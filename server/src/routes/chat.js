'use strict';

const express = require('express');
const router = express.Router();
const { runChat } = require('../ai/chat');
const chatStore = require('../ai/chatStore');
const store = require('../incidents/store');
const engine = require('../incidents/engine');
const { upsertResource } = require('../graph/resources');
const { logEvent } = require('../activity/logger');

const RESOURCE_TYPES = ['container', 'service', 'website', 'host'];

router.get('/sessions', (_req, res) => {
  res.json(chatStore.listSessions());
});

router.get('/sessions/:id', (req, res) => {
  const session = chatStore.getSession(Number(req.params.id));
  if (!session) return res.status(404).json({ error: 'Session not found' });
  res.json({ ...session, messages: chatStore.getMessages(session.id) });
});

router.delete('/sessions/:id', (req, res) => {
  const deleted = chatStore.deleteSession(Number(req.params.id));
  if (!deleted) return res.status(404).json({ error: 'Session not found' });
  res.json({ deleted });
});

/**
 * Escalate a chat finding into a real incident.
 *
 * This is deliberately the *only* way a conversation reaches the action
 * machinery, and it enters at the front: it creates a DETECTED incident
 * and hands it to the normal investigation path, so the resulting
 * remediation still needs an explicit human approval (or an existing
 * auto-remediate opt-in) exactly like a detector-raised one. Chat never
 * approves or executes anything itself.
 *
 * `user_reported` has no entry in CANONICAL_REMEDIATION by design — a
 * human describing a problem is not the deterministic ground truth that
 * "systemd says this unit is inactive" is, so there is no derived
 * restart fallback for these.
 */
router.post('/escalate', (req, res) => {
  const { resourceType, externalId, summary } = req.body || {};
  if (!resourceType || !externalId) {
    return res.status(400).json({ error: 'resourceType and externalId are required' });
  }
  if (!RESOURCE_TYPES.includes(resourceType)) {
    return res.status(400).json({ error: `Unknown resourceType "${resourceType}"` });
  }

  const resource = upsertResource({ type: resourceType, externalId, name: externalId });

  // Same dedupe rule the detector uses — one open incident per resource.
  const existing = store.findOpenIncidentForResource(resource.id);
  if (existing) return res.json({ incidentId: existing.id, existing: true });

  const incident = store.createIncident({
    resourceId: resource.id,
    severity: 'medium',
    triggerRule: 'user_reported',
    triggerSummary: summary || `Reported via Ask Sentinel: ${externalId}`
  });
  logEvent('INCIDENT_DETECTED', `Incident #${incident.id} raised from Ask Sentinel: ${resourceType} ${externalId}`);

  engine.startInvestigation(incident.id)
    .catch(err => console.error(`[chat] investigation for #${incident.id} failed:`, err.message));

  res.json({ incidentId: incident.id, existing: false });
});

/**
 * One conversational turn, streamed.
 *
 * SSE-over-POST, the same wire format routes/deployments.js already
 * uses (and the frontend already knows how to read): each event is a
 * `data: {json}` line. Streaming is the point — the operator watches
 * the tool calls happen rather than waiting on a single opaque reply.
 */
router.post('/', async (req, res) => {
  const { message } = req.body || {};
  if (!message || typeof message !== 'string' || !message.trim()) {
    return res.status(400).json({ error: 'message is required' });
  }

  let session = req.body.sessionId ? chatStore.getSession(Number(req.body.sessionId)) : null;
  if (!session) session = chatStore.createSession(message.trim());

  const history = chatStore.getMessages(session.id).map(m => ({ role: m.role, content: m.content }));
  chatStore.addMessage(session.id, { role: 'user', content: message.trim() });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (type, data) => res.write(`data: ${JSON.stringify({ type, ...data, ts: Date.now() })}\n\n`);

  send('session', { sessionId: session.id, title: session.title });

  try {
    const { answer, toolCalls, suggestedIncident } = await runChat({
      question: message.trim(),
      history,
      onEvent: send
    });
    chatStore.addMessage(session.id, {
      role: 'assistant',
      content: answer,
      toolCalls: toolCalls.length > 0 || suggestedIncident ? { calls: toolCalls, suggestedIncident } : null
    });
  } catch (err) {
    // The turn's own error surfaces in the stream (the response has
    // already been committed with a 200, so a status code can't).
    send('error', { message: err.message });
  }

  res.write('event: done\ndata: {}\n\n');
  res.end();
});

module.exports = router;

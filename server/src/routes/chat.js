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
// SSE comment lines (start with ':') are ignored by every SSE parser but
// still count as bytes on the wire, resetting any intermediary's
// idle-connection timer. This VPS routes chat requests through both
// cloudflared and Caddy; Cloudflare's edge enforces a 100s idle cutoff.
// A single slow provider call (seen live at 20s+ against a free-tier
// model, sometimes with a retry on top) can otherwise go that long with
// zero bytes written, which is indistinguishable from a dead connection
// to anything watching for one.
const KEEPALIVE_MS = 15000;

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
  // Defensive: a write after the client is gone should never be able to
  // crash the process via an unhandled 'error' event on the response.
  res.on('error', () => {});
  res.flushHeaders();

  // res.on('close') fires both on a normal finish and on the client
  // hanging up early — writableEnded is what tells those apart. Checked
  // between chat.js's steps so an abandoned turn stops spending provider
  // quota and agent tool calls the moment nobody is listening, instead
  // of continuing to completion in the background (observed live:
  // reopening a session after its stream had already errored out showed
  // an extra tool call and a final answer that ran after the browser
  // had already given up).
  let clientGone = false;
  res.on('close', () => {
    if (!res.writableEnded) clientGone = true;
  });

  const keepalive = setInterval(() => {
    if (!res.writableEnded) {
      try { res.write(': keepalive\n\n'); } catch { /* connection already gone */ }
    }
  }, KEEPALIVE_MS);

  const send = (type, data) => {
    if (res.writableEnded) return;
    try { res.write(`data: ${JSON.stringify({ type, ...data, ts: Date.now() })}\n\n`); } catch { /* connection already gone */ }
  };

  send('session', { sessionId: session.id, title: session.title });

  try {
    const { answer, toolCalls, suggestedIncident, cancelled } = await runChat({
      question: message.trim(),
      history,
      onEvent: send,
      isCancelled: () => clientGone
    });
    if (!cancelled) {
      chatStore.addMessage(session.id, {
        role: 'assistant',
        content: answer,
        toolCalls: toolCalls.length > 0 || suggestedIncident ? { calls: toolCalls, suggestedIncident } : null
      });
    } else if (toolCalls.length > 0) {
      // Still worth persisting what was gathered before the connection
      // died, so reopening the session shows a true partial state
      // instead of either nothing or a turn that quietly kept running.
      chatStore.addMessage(session.id, {
        role: 'assistant',
        content: '(connection interrupted before this finished)',
        toolCalls: { calls: toolCalls, suggestedIncident: null }
      });
    }
  } catch (err) {
    // The turn's own error surfaces in the stream (the response has
    // already been committed with a 200, so a status code can't).
    send('error', { message: err.message });
  } finally {
    clearInterval(keepalive);
  }

  if (!res.writableEnded) {
    try { res.write('event: done\ndata: {}\n\n'); } catch { /* connection already gone */ }
    res.end();
  }
});

module.exports = router;

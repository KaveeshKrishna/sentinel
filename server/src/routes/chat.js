'use strict';

const express = require('express');
const router = express.Router();
const { runChat } = require('../ai/chat');
const chatStore = require('../ai/chatStore');
const store = require('../incidents/store');
const engine = require('../incidents/engine');
const { upsertResource } = require('../graph/resources');
const { logEvent } = require('../activity/logger');
const chatRuns = require('../ai/chatRuns');
const { publish } = require('../events/publish');

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

  // One turn at a time per session, so two tabs can't interleave answers
  // into the same conversation.
  if (chatRuns.isRunning(session.id)) {
    return res.status(409).json({ error: 'This conversation is already thinking — stop it first' });
  }

  const question = message.trim();
  const history = chatStore.getMessages(session.id).map(m => ({ role: m.role, content: m.content }));
  chatStore.addMessage(session.id, { role: 'user', content: question });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  // Defensive: a write after the client is gone should never be able to
  // crash the process via an unhandled 'error' event on the response.
  res.on('error', () => {});
  res.flushHeaders();

  const keepalive = setInterval(() => {
    if (!res.writableEnded) {
      try { res.write(': keepalive\n\n'); } catch { /* connection already gone */ }
    }
  }, KEEPALIVE_MS);

  const send = (type, data) => {
    if (res.writableEnded) return;
    try { res.write(`data: ${JSON.stringify({ type, ...data, ts: Date.now() })}\n\n`); } catch { /* gone */ }
  };

  send('session', { sessionId: session.id, title: session.title });

  // The turn is registered BEFORE the await, so a Stop arriving while
  // the first provider call is in flight still finds something to cancel.
  const run = chatRuns.start(session.id, question);

  try {
    const { answer, toolCalls, suggestedIncident, cancelled } = await runChat({
      question,
      history,
      onEvent: send,
      // Only an explicit Stop ends a turn early now. The browser going
      // away does not: the answer is persisted and announced regardless,
      // so asking something and navigating elsewhere no longer throws
      // away the work (and the provider request already paid for).
      isCancelled: () => run.cancelled
    });

    if (cancelled) {
      chatStore.addMessage(session.id, {
        role: 'assistant',
        content: toolCalls.length > 0
          ? '(stopped — here is what had been gathered)'
          : '(stopped before anything ran)',
        toolCalls: toolCalls.length > 0 ? { calls: toolCalls, suggestedIncident: null } : null
      });
      send('stopped', {});
    } else {
      chatStore.addMessage(session.id, {
        role: 'assistant',
        content: answer,
        toolCalls: toolCalls.length > 0 || suggestedIncident ? { calls: toolCalls, suggestedIncident } : null
      });
      // Announced whether or not this stream is still attached — that is
      // the whole point of the turn outliving its connection. The client
      // uses it to toast an answer that landed on a conversation the
      // operator has since navigated away from.
      publish('chat', {
        event: 'answered',
        sessionId: session.id,
        title: session.title,
        question,
        preview: (answer || '').slice(0, 160)
      });
    }
  } catch (err) {
    // The turn's own error surfaces in the stream (the response has
    // already been committed with a 200, so a status code can't) and, for
    // an operator who has navigated away, as a pushed event.
    send('error', { message: err.message });
    chatStore.addMessage(session.id, {
      role: 'assistant',
      content: `(failed: ${err.message})`,
      toolCalls: null
    });
    publish('chat', {
      event: 'failed', sessionId: session.id, title: session.title, question, error: err.message
    });
  } finally {
    clearInterval(keepalive);
    chatRuns.finish(session.id);
  }

  if (!res.writableEnded) {
    try { res.write('event: done\ndata: {}\n\n'); } catch { /* connection already gone */ }
    res.end();
  }
});

/**
 * Stop a turn that is currently thinking.
 *
 * This is now the ONLY way a turn ends early — navigating away doesn't.
 * It takes effect at the next step boundary (between a provider call and
 * the tool call it asked for), so an in-flight HTTP request to the
 * provider still completes; what it prevents is the next one.
 */
router.post('/sessions/:id/stop', (req, res) => {
  const sessionId = Number(req.params.id);
  if (!chatStore.getSession(sessionId)) return res.status(404).json({ error: 'Session not found' });
  res.json({ stopped: chatRuns.cancel(sessionId) });
});

/** Which conversations are mid-thought, so a reopened UI shows it. */
router.get('/running', (_req, res) => {
  res.json({ running: chatRuns.listRunning() });
});

module.exports = router;

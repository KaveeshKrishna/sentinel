'use strict';

const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();
const { verifyApproveToken } = require('../notify/approveLink');
const { getNotifyConfig } = require('../settings/notifyConfig');
const { getResource } = require('../graph/resources');
const store = require('../incidents/store');
const engine = require('../incidents/engine');
const { logEvent } = require('../activity/logger');

/**
 * One-click approval from a Slack/Discord/webhook notification.
 *
 * This is the ONLY route in Sentinel that acts without a session cookie,
 * so read notify/approveLink.js for the full security model. In short:
 * the signed token authenticates one exact incident+action pair that the
 * AI has already proposed and that is already waiting on a human, the
 * feature is opt-in and off by default, and the agent still
 * independently re-authorizes the resulting call.
 *
 * The GET/POST split is load-bearing, not REST pedantry: Slack, Discord
 * and mail clients all prefetch links to build previews, so a GET that
 * approved would be fired by the notification itself before any human
 * saw it. GET renders an inert confirmation page; only the POST that
 * page submits executes anything.
 */

// The token is unguessable, but an unauthenticated endpoint should not
// be a free oracle either.
const approveLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests' }
});

router.use(approveLimiter);

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function page({ title, body, tone = 'neutral' }) {
  const accent = { ok: '#22c55e', bad: '#ef4444', neutral: '#3b82f6' }[tone];
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Sentinel — ${escapeHtml(title)}</title>
<style>
  :root { color-scheme: dark; }
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
         background:#080b0f; color:#e6edf3; font-family:system-ui,-apple-system,sans-serif; padding:20px; }
  .card { width:100%; max-width:440px; background:#0d1117; border:1px solid #21262d;
          border-top:3px solid ${accent}; border-radius:12px; padding:28px; }
  h1 { font-size:1.1rem; margin:0 0 14px; }
  .row { display:flex; justify-content:space-between; gap:12px; padding:7px 0; border-top:1px solid #21262d; font-size:.86rem; }
  .k { color:#8b949e; } .v { text-align:right; word-break:break-word; }
  .mono { font-family:ui-monospace,monospace; }
  p { color:#8b949e; font-size:.86rem; line-height:1.55; }
  button { width:100%; margin-top:18px; padding:12px; border:0; border-radius:8px;
           background:${accent}; color:#fff; font-size:.95rem; font-weight:600; cursor:pointer; }
  .risk { color:#f59e0b; font-weight:600; }
</style>
</head><body><div class="card">${body}</div></body></html>`;
}

function invalidPage(res) {
  // Deliberately does not distinguish tampered from expired from unknown.
  return res.status(403).send(page({
    title: 'Link invalid',
    tone: 'bad',
    body: '<h1>This approval link is no longer valid</h1><p>It may have expired (links last 30 minutes), already been used, or been altered. Open Sentinel and approve from the incident page instead.</p>'
  }));
}

/** Shared preconditions for both verbs. */
function resolve(token) {
  const claim = verifyApproveToken(token);
  if (!claim) return { error: 'invalid' };

  if (!getNotifyConfig().approveLinks) return { error: 'disabled' };

  const incident = store.getIncident(claim.incidentId);
  const action = store.getAction(claim.actionId);
  if (!incident || !action || action.incident_id !== incident.id) return { error: 'invalid' };

  return { incident, action };
}

// GET — inert. Renders a confirmation page and executes nothing, so a
// link preview/prefetch cannot approve anything.
router.get('/:token', (req, res) => {
  const { error, incident, action } = resolve(req.params.token);
  if (error === 'invalid') return invalidPage(res);
  if (error === 'disabled') {
    return res.status(403).send(page({
      title: 'Disabled', tone: 'bad',
      body: '<h1>One-click approval is disabled</h1><p>Enable it in Sentinel under Settings → Notifications, or approve from the incident page.</p>'
    }));
  }

  if (action.status !== 'proposed') {
    return res.status(409).send(page({
      title: 'Already handled', tone: 'neutral',
      body: `<h1>Already handled</h1><p>This action is <strong>${escapeHtml(action.status)}</strong>. Nothing further to do.</p>`
    }));
  }

  const resource = getResource(incident.resource_id);
  res.send(page({
    title: 'Approve action',
    body: `
      <h1>Approve this action?</h1>
      <div class="row"><span class="k">Incident</span><span class="v">#${incident.id}</span></div>
      <div class="row"><span class="k">Resource</span><span class="v">${escapeHtml(resource ? `${resource.name} (${resource.type})` : incident.resource_id)}</span></div>
      <div class="row"><span class="k">Problem</span><span class="v">${escapeHtml(incident.root_cause || incident.trigger_summary)}</span></div>
      <div class="row"><span class="k">Action</span><span class="v mono">${escapeHtml(action.tool_name)}</span></div>
      <div class="row"><span class="k">Risk</span><span class="v risk">${escapeHtml(action.real_risk)}</span></div>
      <form method="POST"><button type="submit">Approve &amp; execute</button></form>
      <p>Sentinel will run this action and then verify it actually fixed the problem.</p>`
  }));
});

// POST — the only verb that executes.
router.post('/:token', async (req, res) => {
  const { error, incident, action } = resolve(req.params.token);
  if (error) return invalidPage(res);

  // Single-use by construction: a replayed link finds the action no
  // longer 'proposed' and does nothing.
  if (action.status !== 'proposed') {
    return res.status(409).send(page({
      title: 'Already handled', tone: 'neutral',
      body: `<h1>Already handled</h1><p>This action is <strong>${escapeHtml(action.status)}</strong>. Nothing was run.</p>`
    }));
  }

  try {
    logEvent('INCIDENT_APPROVED', `Incident #${incident.id}: ${action.tool_name} approved via one-click link`);
    // via: 'link' — a human approval with no user id, which must stay
    // distinguishable from a machine one (see settings/autoRemediate.js).
    const updated = await engine.approve(incident.id, { actionId: action.id, userId: null, via: 'link' });
    res.send(page({
      title: 'Approved', tone: updated.status === 'RESOLVED' ? 'ok' : 'neutral',
      body: `
        <h1>${updated.status === 'RESOLVED' ? '✅ Fixed and verified' : 'Action approved'}</h1>
        <div class="row"><span class="k">Incident</span><span class="v">#${incident.id}</span></div>
        <div class="row"><span class="k">Ran</span><span class="v mono">${escapeHtml(action.tool_name)}</span></div>
        <div class="row"><span class="k">Status</span><span class="v">${escapeHtml(updated.status)}</span></div>
        <p>${updated.status === 'RESOLVED'
          ? 'Sentinel ran the action and confirmed the problem is resolved.'
          : 'Open Sentinel for the full timeline.'}</p>`
    }));
  } catch (err) {
    console.error('[approve-link] failed:', err.message);
    res.status(502).send(page({
      title: 'Failed', tone: 'bad',
      body: '<h1>The action could not be completed</h1><p>Open Sentinel to see what happened and try again from the incident page.</p>'
    }));
  }
});

module.exports = router;

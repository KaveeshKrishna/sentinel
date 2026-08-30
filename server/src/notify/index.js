'use strict';

const { getNotifyConfig, getDecryptedUrls } = require('../settings/notifyConfig');
const { buildNotification } = require('./format');
const { buildApproveUrl } = require('./approveLink');
const { getResource } = require('../graph/resources');
const store = require('../incidents/store');

const RENDERERS = {
  slack: require('./channels/slack'),
  discord: require('./channels/discord'),
  webhook: require('./channels/webhook')
};

const TIMEOUT_MS = 8000;

/**
 * Deliver one notification to every configured channel.
 *
 * Best-effort and fire-and-forget by contract: this is called from the
 * detector and the incident engine, right next to their existing
 * logEvent calls, and a Slack outage must never be able to fail an
 * incident transition or a remediation. Every error is logged and
 * swallowed; nothing here throws to its caller.
 *
 * @param {string} event - a settings/notifyConfig EVENTS member
 * @param {number} incidentId
 * @param {{action?: object}} [extra]
 */
async function notifyIncident(event, incidentId, { action = null } = {}) {
  try {
    const config = getNotifyConfig();
    if (!config.events.includes(event)) return;

    const urls = getDecryptedUrls();
    if (Object.keys(urls).length === 0) return;

    const incident = store.getIncident(incidentId);
    if (!incident) return;

    const resource = getResource(incident.resource_id);

    // A one-click link is only ever built for an action still waiting on
    // a human, and only when the operator has opted in.
    const approveUrl = (config.approveLinks && action && action.status === 'proposed')
      ? buildApproveUrl(config.baseUrl, incident.id, action.id)
      : null;

    const notification = buildNotification(event, {
      incident,
      resource,
      action,
      approveUrl,
      incidentUrl: config.baseUrl ? `${config.baseUrl}/incidents/${incident.id}` : null
    });

    await Promise.all(
      Object.entries(urls).map(([channel, url]) =>
        post(url, RENDERERS[channel].render(notification))
          .catch(err => console.error(`[notify] ${channel} delivery failed:`, err.message))
      )
    );
  } catch (err) {
    console.error('[notify] failed:', err.message);
  }
}

async function post(url, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${(await res.text().catch(() => '')).slice(0, 200)}`);
    }
  } finally {
    clearTimeout(timer);
  }
}

/** Settings' "Send test" button: same rendering path, obvious content. */
async function sendTestNotification() {
  const config = getNotifyConfig();
  const urls = getDecryptedUrls();
  if (Object.keys(urls).length === 0) throw new Error('No notification channel is configured');

  const notification = buildNotification('INCIDENT_RESOLVED', {
    incident: {
      id: 0,
      resource_id: 0,
      trigger_rule: 'test',
      trigger_summary: 'This is a test notification from Sentinel.',
      root_cause: 'Nothing is wrong — you pressed the test button.'
    },
    resource: { name: 'sentinel', type: 'service' },
    action: null,
    approveUrl: null,
    incidentUrl: config.baseUrl ? `${config.baseUrl}/incidents` : null
  });

  const results = {};
  await Promise.all(Object.entries(urls).map(async ([channel, url]) => {
    try {
      await post(url, RENDERERS[channel].render(notification));
      results[channel] = { ok: true };
    } catch (err) {
      results[channel] = { ok: false, error: err.message };
    }
  }));
  return results;
}

module.exports = { notifyIncident, sendTestNotification };

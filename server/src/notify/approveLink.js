'use strict';

const crypto = require('crypto');
const { loadSecretKey } = require('../crypto/secretKey');

/**
 * Signed, single-purpose approval links for notifications.
 *
 * SECURITY MODEL — this is the one route that acts without a session
 * cookie, so the boundary is worth stating precisely. The link grants NO
 * NEW CAPABILITY: it is an alternative authentication path to an action
 * that the AI has *already proposed* and that is *already sitting in the
 * approval queue* awaiting a human. Everything else still applies —
 * approve() runs the same code path as the UI button, and the agent
 * independently re-authorizes the call through its own isAuthorized().
 *
 * The constraints on top of that:
 *   - HMAC-SHA256 over the exact incident + action + expiry, keyed by
 *     /etc/sentinel/secret.key (0640 root:sentinel). An attacker cannot
 *     mint a link for a different action, or for one they invent.
 *   - 30-minute expiry, checked on both GET and POST.
 *   - Single-use by construction: the POST handler refuses unless the
 *     action is still 'proposed', so a replayed link is inert.
 *   - GET is inert and only renders a confirm page; POST executes. Slack,
 *     Discord and email clients all prefetch links for previews, so a
 *     GET that approved would be triggered by the notification itself.
 *   - The feature is opt-in and off by default (notify.approveLinks).
 *
 * Timing-safe comparison throughout, so the signature can't be probed.
 */

const TTL_MS = 30 * 60 * 1000;

function sign(payload) {
  return crypto.createHmac('sha256', loadSecretKey()).update(payload).digest();
}

function b64url(buf) {
  return Buffer.from(buf).toString('base64url');
}

/**
 * @returns {string} `<base64url payload>.<base64url hmac>`
 */
function signApproveToken({ incidentId, actionId, expiresAt = Date.now() + TTL_MS }) {
  const payload = `${incidentId}.${actionId}.${expiresAt}`;
  return `${b64url(payload)}.${b64url(sign(payload))}`;
}

/**
 * @returns {{incidentId: number, actionId: number, expiresAt: number} | null}
 *   null for anything malformed, tampered with, or expired — the caller
 *   must not distinguish these to the client beyond "invalid or expired".
 */
function verifyApproveToken(token) {
  if (typeof token !== 'string') return null;

  const parts = token.split('.');
  if (parts.length !== 2) return null;

  let payload;
  let provided;
  try {
    payload = Buffer.from(parts[0], 'base64url').toString('utf8');
    provided = Buffer.from(parts[1], 'base64url');
  } catch {
    return null;
  }

  const expected = sign(payload);
  if (provided.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(provided, expected)) return null;

  const [incidentId, actionId, expiresAt] = payload.split('.').map(Number);
  if (!Number.isInteger(incidentId) || !Number.isInteger(actionId) || !Number.isFinite(expiresAt)) return null;
  if (Date.now() > expiresAt) return null;

  return { incidentId, actionId, expiresAt };
}

/** Absolute URL for a notification button. Returns null without a base URL. */
function buildApproveUrl(baseUrl, incidentId, actionId) {
  if (!baseUrl) return null;
  const token = signApproveToken({ incidentId, actionId });
  return `${String(baseUrl).replace(/\/+$/, '')}/a/${token}`;
}

module.exports = { signApproveToken, verifyApproveToken, buildApproveUrl, TTL_MS };

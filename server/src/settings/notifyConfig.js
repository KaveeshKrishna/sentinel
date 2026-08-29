'use strict';

const { getSetting, setSetting, deleteSetting } = require('../db/settings');
const { encrypt, decrypt } = require('../crypto/aesGcm');

/**
 * Outbound notification configuration.
 *
 * Webhook URLs are treated as credentials, not settings: anyone holding
 * a Slack or Discord incoming-webhook URL can post into that channel as
 * Sentinel. They are therefore AES-256-GCM encrypted at rest with the
 * same key as the AI provider key, and the read API returns only a
 * masked form — mirroring aiConfig's keySuffix pattern. The raw URL
 * leaves this module only via getDecryptedUrls(), for the dispatcher.
 */

const CHANNELS = ['slack', 'discord', 'webhook'];

/** Incident lifecycle moments a notification can be sent for. */
const EVENTS = [
  'INCIDENT_DETECTED',
  'INCIDENT_AWAITING_APPROVAL',
  'INCIDENT_AUTO_REMEDIATE',
  'INCIDENT_RESOLVED',
  'INCIDENT_FAILED'
];

const DEFAULT_EVENTS = ['INCIDENT_AWAITING_APPROVAL', 'INCIDENT_RESOLVED', 'INCIDENT_FAILED'];

const KEY_URL_ENC = (channel) => `notify.${channel}UrlEnc`;
const KEY_EVENTS = 'notify.events';
const KEY_BASE_URL = 'notify.baseUrl';
const KEY_APPROVE_LINKS = 'notify.approveLinks';

/** Enough to recognise which webhook is configured, never enough to use it. */
function maskUrl(url) {
  if (!url) return null;
  try {
    const u = new URL(url);
    const tail = u.pathname.length > 6 ? `…${u.pathname.slice(-6)}` : u.pathname;
    return `${u.host}${tail}`;
  } catch {
    return '(invalid URL)';
  }
}

function readUrl(channel) {
  const enc = getSetting(KEY_URL_ENC(channel));
  return enc ? decrypt(enc) : null;
}

function getNotifyConfig() {
  const channels = {};
  for (const channel of CHANNELS) {
    const url = readUrl(channel);
    channels[channel] = { configured: !!url, masked: maskUrl(url) };
  }

  let events = DEFAULT_EVENTS;
  const raw = getSetting(KEY_EVENTS);
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) events = parsed.filter(e => EVENTS.includes(e));
    } catch { /* malformed row falls back to the defaults */ }
  }

  return {
    channels,
    events,
    baseUrl: getSetting(KEY_BASE_URL) || '',
    approveLinks: getSetting(KEY_APPROVE_LINKS) === 'true',
    availableEvents: EVENTS,
    availableChannels: CHANNELS
  };
}

/**
 * Partial update. A channel URL omitted from the patch is left alone; an
 * explicit empty string clears it — the same blank-means-keep semantics
 * as setAIConfig, so the UI can render a masked value without having to
 * round-trip the secret.
 */
function setNotifyConfig(patch = {}) {
  for (const channel of CHANNELS) {
    const url = patch[`${channel}Url`];
    if (url === undefined) continue;
    if (url === '' || url === null) {
      deleteSetting(KEY_URL_ENC(channel));
      continue;
    }
    if (typeof url !== 'string' || !/^https:\/\//.test(url)) {
      throw new Error(`${channel} webhook URL must be an https:// URL`);
    }
    setSetting(KEY_URL_ENC(channel), encrypt(url));
  }

  if (patch.events !== undefined) {
    if (!Array.isArray(patch.events)) throw new Error('events must be an array');
    const unknown = patch.events.filter(e => !EVENTS.includes(e));
    if (unknown.length) throw new Error(`Unknown event(s): ${unknown.join(', ')}`);
    setSetting(KEY_EVENTS, JSON.stringify([...new Set(patch.events)]));
  }

  if (patch.baseUrl !== undefined) {
    const base = String(patch.baseUrl || '').trim().replace(/\/+$/, '');
    if (base && !/^https?:\/\//.test(base)) throw new Error('baseUrl must start with http:// or https://');
    setSetting(KEY_BASE_URL, base);
  }

  if (patch.approveLinks !== undefined) {
    // Opt-in, and only meaningful with a public base URL to build links from.
    if (patch.approveLinks && !(patch.baseUrl ?? getSetting(KEY_BASE_URL))) {
      throw new Error('Set the public base URL before enabling one-click approval links');
    }
    setSetting(KEY_APPROVE_LINKS, patch.approveLinks ? 'true' : 'false');
  }

  return getNotifyConfig();
}

function clearNotifyConfig() {
  for (const channel of CHANNELS) deleteSetting(KEY_URL_ENC(channel));
  for (const key of [KEY_EVENTS, KEY_BASE_URL, KEY_APPROVE_LINKS]) deleteSetting(key);
  return getNotifyConfig();
}

/**
 * Internal-only: the plaintext webhook URLs, for the dispatcher. Never
 * import this from a route handler that returns its result to a client.
 */
function getDecryptedUrls() {
  const out = {};
  for (const channel of CHANNELS) {
    const url = readUrl(channel);
    if (url) out[channel] = url;
  }
  return out;
}

module.exports = {
  CHANNELS, EVENTS, DEFAULT_EVENTS,
  getNotifyConfig, setNotifyConfig, clearNotifyConfig, getDecryptedUrls, maskUrl
};

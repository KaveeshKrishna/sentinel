'use strict';

const express = require('express');
const router = express.Router();
const { getAIConfig, setAIConfig, clearAIConfig, getDecryptedAPIKey, PROVIDERS } = require('../settings/aiConfig');
const { getDetectorConfig, setDetectorConfig, resetDetectorConfig, DEFAULTS, LIMITS } = require('../settings/detectorConfig');
const {
  getAutoRemediateList, setAutoRemediateList,
  AUTO_REMEDIABLE_TOOLS, MAX_AUTO_RISK, MAX_AUTO_PER_WINDOW
} = require('../settings/autoRemediate');
const { getProvider } = require('../ai/provider');
const {
  listCredentials, getCredential, getCredentialSecret, addCredential, updateCredential,
  deleteCredential, reorderCredentials, recordFailure, recordSuccess
} = require('../settings/aiCredentials');
const { getNotifyConfig, setNotifyConfig, clearNotifyConfig } = require('../settings/notifyConfig');
const { getAccessScope, setAccessScope, MAX_PATHS } = require('../settings/accessScope');
const { sendTestNotification } = require('../notify');

// Detector tuning — cooldown, sustain windows, CPU/RAM/disk thresholds.
// Defaults and limits ship alongside the values so the UI can render
// sensible inputs without duplicating the schema.
router.get('/detector', (_req, res) => {
  res.json({ config: getDetectorConfig(), defaults: DEFAULTS, limits: LIMITS });
});

router.put('/detector', (req, res) => {
  try {
    res.json({ config: setDetectorConfig(req.body || {}), defaults: DEFAULTS, limits: LIMITS });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.delete('/detector', (_req, res) => {
  res.json({ config: resetDetectorConfig(), defaults: DEFAULTS, limits: LIMITS });
});

// Auto-remediation opt-in list. The tool allowlist and risk ceiling are
// returned read-only for the UI to display — they are code-level
// constants and deliberately not settable over the API, since this is
// the one path that runs an action without a human clicking approve.
router.get('/auto-remediate', (_req, res) => {
  res.json({
    resources: getAutoRemediateList(),
    allowedTools: AUTO_REMEDIABLE_TOOLS,
    maxRisk: MAX_AUTO_RISK,
    maxPerHour: MAX_AUTO_PER_WINDOW
  });
});

router.put('/auto-remediate', (req, res) => {
  const { resources } = req.body || {};
  try {
    res.json({
      resources: setAutoRemediateList(resources || []),
      allowedTools: AUTO_REMEDIABLE_TOOLS,
      maxRisk: MAX_AUTO_RISK,
      maxPerHour: MAX_AUTO_PER_WINDOW
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Outbound notifications. Webhook URLs are credentials (anyone holding
// one can post to the channel), so they are encrypted at rest and only
// ever returned masked — same treatment as the AI provider key.
router.get('/notify', (_req, res) => {
  res.json(getNotifyConfig());
});

router.put('/notify', (req, res) => {
  try {
    res.json(setNotifyConfig(req.body || {}));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.delete('/notify', (_req, res) => {
  res.json(clearNotifyConfig());
});

router.post('/notify/test', async (_req, res) => {
  try {
    res.json({ ok: true, results: await sendTestNotification() });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

// How much of this host Ask Sentinel may look at. `ownData` covers
// Sentinel's own records (recordings/incidents/activity); `paths` is an
// allowlist of host directories the agent's read-only file tools may
// look inside, empty by default. The invariants that hold regardless of
// what is set here (never a key, never /etc/sentinel, never a write)
// live in the agent — see agent/src/tools/files.js.
router.get('/access', (_req, res) => {
  res.json({ ...getAccessScope(), maxPaths: MAX_PATHS });
});

router.put('/access', (req, res) => {
  const { ownData, paths } = req.body || {};
  try {
    res.json({ ...setAccessScope({ ownData, paths }), maxPaths: MAX_PATHS });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── AI credentials ────────────────────────────────────────────────────
// An ordered pool, tried in listed order on every AI call (ai/failover.js).
// The raw key is never returned — only its last 4 characters — and each
// row carries the reason it last failed, so the Settings page can explain
// why a credential is being skipped without the operator reading logs.
router.get('/ai/credentials', (_req, res) => {
  res.json({ credentials: listCredentials(), providers: PROVIDERS });
});

router.post('/ai/credentials', (req, res) => {
  const { label, provider, model, baseUrl, apiKey, enabled, rpmLimit, rpdLimit } = req.body || {};
  try {
    res.status(201).json(addCredential({ label, provider, model, baseUrl, apiKey, enabled, rpmLimit, rpdLimit }));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Failover order. Sent as the full list of ids, first tried first.
router.put('/ai/credentials/order', (req, res) => {
  try {
    res.json({ credentials: reorderCredentials((req.body || {}).ids) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.put('/ai/credentials/:id', (req, res) => {
  const { label, provider, model, baseUrl, apiKey, enabled, rpmLimit, rpdLimit } = req.body || {};
  try {
    res.json(updateCredential(Number(req.params.id), { label, provider, model, baseUrl, apiKey, enabled, rpmLimit, rpdLimit }));
  } catch (err) {
    res.status(/^No AI credential/.test(err.message) ? 404 : 400).json({ error: err.message });
  }
});

router.delete('/ai/credentials/:id', (req, res) => {
  if (!deleteCredential(Number(req.params.id))) {
    return res.status(404).json({ error: 'No such AI credential' });
  }
  res.json({ ok: true, credentials: listCredentials() });
});

// Test one specific credential, using its own stored key. Updates that
// row's health so a failure is visible on the page after a reload, not
// just in this response.
router.post('/ai/credentials/:id/test', async (req, res) => {
  const id = Number(req.params.id);
  const credential = getCredential(id);
  if (!credential) return res.status(404).json({ error: 'No such AI credential' });

  // Deliberately not listUsableCredentials(): a *disabled* credential is
  // still testable, which is how an operator validates a replacement key
  // before putting it back in the failover chain.
  const usable = getCredentialSecret(id);
  if (!usable) {
    const msg = 'This credential could not be decrypted — re-enter its API key';
    recordFailure(id, msg);
    return res.status(400).json({ ok: false, error: msg });
  }

  try {
    const result = await getProvider(usable.provider).chat({
      system: 'Reply with exactly one word: OK',
      messages: [{ role: 'user', content: 'Reply with exactly one word: OK' }],
      apiKey: usable.apiKey, model: usable.model, baseUrl: usable.baseUrl
    });
    recordSuccess(id);
    res.json({ ok: true, sample: (result.text || '').slice(0, 50), credential: getCredential(id) });
  } catch (err) {
    recordFailure(id, err.message);
    res.status(502).json({ ok: false, error: err.message, credential: getCredential(id) });
  }
});

router.get('/ai', (_req, res) => {
  res.json(getAIConfig());
});

router.put('/ai', (req, res) => {
  const { provider, model, baseUrl, apiKey } = req.body || {};
  if (!provider) return res.status(400).json({ error: 'provider is required' });
  try {
    setAIConfig({ provider, model, baseUrl, apiKey });
    res.json(getAIConfig());
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.delete('/ai', (_req, res) => {
  clearAIConfig();
  res.json({ ok: true });
});

// A 1-token round trip against either the saved config or an inline,
// not-yet-saved one (so the UI can validate before committing to
// Settings). Never echoes the key back either way.
router.post('/ai/test-connection', async (req, res) => {
  const inline = req.body || {};
  const provider = inline.provider || getAIConfig().provider;
  const model = inline.model || getAIConfig().model;
  const baseUrl = inline.baseUrl || getAIConfig().baseUrl;
  const apiKey = inline.apiKey || getDecryptedAPIKey();

  if (!provider || !apiKey) return res.status(400).json({ error: 'No AI provider configured' });
  if (!PROVIDERS.includes(provider)) return res.status(400).json({ error: `Unknown provider "${provider}"` });

  try {
    const adapter = getProvider(provider);
    const result = await adapter.chat({
      system: 'Reply with exactly one word: OK',
      messages: [{ role: 'user', content: 'Reply with exactly one word: OK' }],
      apiKey, model, baseUrl
    });
    res.json({ ok: true, sample: (result.text || '').slice(0, 50) });
  } catch (err) {
    res.status(502).json({ ok: false, error: err.message });
  }
});

module.exports = router;

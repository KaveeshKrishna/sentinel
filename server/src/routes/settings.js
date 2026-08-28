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

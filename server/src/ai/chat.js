'use strict';

const { getAgentClient } = require('../agent/client');
const { getProvider } = require('./provider');
const { getAIConfig, getDecryptedAPIKey } = require('../settings/aiConfig');
const { CHAT_STEP_SCHEMA, validateChatStep } = require('./schema');
const { renderToolCatalog } = require('./orchestrator');
const { callToolAudited } = require('../incidents/toolCallAudit');
const { summarizeToolResult } = require('./summarize');
const { recordAiRun } = require('./runs');
const { redact } = require('./redact');

/**
 * Hard ceilings on one turn. MAX_TOOL_CALLS bounds what a single
 * question can do to the host (and to the provider's quota);
 * MAX_STEPS additionally bounds the *conversation* so that a model
 * which keeps returning malformed JSON, or keeps asking for tools it
 * isn't allowed, terminates instead of looping.
 */
const MAX_TOOL_CALLS = 5;
const MAX_STEPS = 8;
const CHAT_RESULT_LIMIT = 3000;

/**
 * Wall-clock ceiling on one turn, independent of MAX_STEPS.
 *
 * Found live: a slow free-tier model (already observed at 20s+ for a
 * single call, before the transient-retry work above sometimes adds a
 * second attempt on top) can make an 8-step conversation run for
 * minutes. MAX_STEPS alone doesn't bound that — it stops a model from
 * taking too many cheap turns, not a model that takes few but very slow
 * ones. Checked between steps (see runChat), so a turn stops well
 * before it could plausibly trip an intermediary's idle-connection
 * timeout (this VPS routes through both cloudflared and Caddy; the
 * former enforces a 100s idle cutoff at Cloudflare's edge).
 */
const MAX_TURN_MS = 60000;

/**
 * Extra tries for a provider call that fails with a status suggesting
 * the failure is on the provider's side, not a real misconfiguration.
 *
 * Found live against a real OpenRouter free-tier model
 * (nvidia/nemotron-3-ultra-...:free): the identical request — same base
 * URL, same key, same model, proven by a Settings "Test Connection" that
 * succeeded moments earlier — returned a real completion on some calls
 * and "OpenAI-compatible API error (404): Provider returned error" on
 * others. A wrong base URL or bad key fails *every* call; this failed
 * roughly half the time, which is the signature of OpenRouter routing a
 * free model across multiple backend providers of varying availability,
 * not a Sentinel or user configuration problem. A bounded retry turns
 * "the conversation just dies" into "try again, usually works" — the
 * request costs the same provider quota either way, since the failed
 * attempt never got billed/counted as a completion.
 *
 * Deliberately scoped to chat only: unlike a diagnosis, a chat turn is a
 * live, synchronous, user-initiated request with no background process
 * to retry it later — diagnosis already has its own (much coarser,
 * 30s+) resilience via the detector's checkStuckInvestigations backoff,
 * and the post-incident report is deliberately single-attempt by design
 * (see ai/report.js). 401/403/400 (bad key, bad request) are excluded
 * on purpose — those fail identically every time, so retrying only
 * burns quota and delays the real error reaching the operator.
 */
const PROVIDER_RETRY_ATTEMPTS = 2; // extra tries beyond the first
const PROVIDER_RETRY_DELAY_MS = 300;
const PROVIDER_RETRYABLE_STATUS = new Set([404, 408, 429, 500, 502, 503, 504]);

function retryableProviderStatus(message) {
  const m = /\((\d{3})\)/.exec(message || '');
  return m ? PROVIDER_RETRYABLE_STATUS.has(Number(m[1])) : false;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function buildChatSystemPrompt(readOnlyCatalog) {
  return [
    'You are Sentinel, an AI infrastructure engineer with read-only access to a single monitored host.',
    'A human operator is asking you questions about it. Investigate using the tools below, then answer.',
    '',
    'Respond with ONLY a JSON object — no prose, no markdown fences. Each response is ONE step:',
    '  {"thought": "...", "action": "tool", "tool": "<name>", "params": { ... }}   to run a tool, or',
    '  {"thought": "...", "action": "answer", "answer": "..."}                     to answer the operator.',
    '',
    'You may ONLY use these tools. They are all read-only — they observe, they never change anything.',
    'Each "params" object MUST conform exactly to that tool\'s schema below: use only the properties it',
    'lists and no others (the schemas are strict — extra properties are rejected). Where a schema wants',
    'a container "id", pass the container name.',
    renderToolCatalog(readOnlyCatalog),
    '',
    `You may run at most ${MAX_TOOL_CALLS} tools before you must answer. Prefer one or two well-chosen`,
    'calls over exhaustively checking everything. After each tool call you will be given its output;',
    'use it to decide whether to run another tool or to answer.',
    '',
    'Ground your answer strictly in tool output. Never invent metrics, log lines or container names.',
    'If the tools available cannot answer the question, say so plainly instead of guessing.',
    'Write the "answer" for a human operator: direct, specific, and short — a few sentences, or a',
    'short list. Quote concrete numbers and names you actually observed.',
    '',
    'You cannot start, stop, restart, deploy or change anything, and you must not claim you can.',
    'If you find a problem that needs a fix, include a "suggestedIncident" object alongside your answer:',
    '  {"action": "answer", "answer": "...", "suggestedIncident": {"resourceType": "container"|"service",',
    '   "externalId": "<exact container or service name>", "summary": "<one line: what is wrong>"}}',
    'That opens a normal incident, which is diagnosed and then waits for the operator to approve a fix.',
    'Only suggest one when something is genuinely wrong right now — not for a healthy system.'
  ].join('\n');
}

/**
 * Call the provider, retrying a bounded number of times when the
 * failure's HTTP status suggests it's transient rather than a real
 * config problem (see PROVIDER_RETRY_ATTEMPTS above for why and when).
 * Every attempt — success or failure — is recorded to ai_runs, so the
 * audit trail shows exactly what happened rather than only the final
 * outcome.
 */
async function callProviderWithRetry(adapter, chatArgs, { provider, model, step, question }) {
  let lastErr;
  for (let sub = 0; sub <= PROVIDER_RETRY_ATTEMPTS; sub++) {
    const startedAt = Date.now();
    try {
      return await adapter.chat(chatArgs);
    } catch (err) {
      lastErr = err;
      recordAiRun({
        incidentId: null, purpose: 'chat', provider, model, attempt: step,
        requestSummary: question, rawResponse: null, parsedJson: null,
        error: err.message, usage: null, latencyMs: Date.now() - startedAt
      });
      if (sub < PROVIDER_RETRY_ATTEMPTS && retryableProviderStatus(err.message)) {
        await sleep(PROVIDER_RETRY_DELAY_MS);
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

/** Pulled out for direct unit testing — real-timing tests can't cheaply hit both branches. */
function timeoutAnswer(toolCallCount) {
  return toolCallCount > 0
    ? "This is taking longer than expected. Here's what I found before running out of time — ask again to continue."
    : "This is taking longer than expected and I wasn't able to find anything yet. Try again, or ask something narrower.";
}

/** Prior turns, in the alternating shape every adapter expects. */
function historyToMessages(history) {
  return history
    .filter(m => m.content)
    .map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content }));
}

/**
 * One turn of "Ask Sentinel": a bounded observe-then-answer loop.
 *
 * SAFETY: two independent gates keep this read-only, neither of which
 * trusts the model.
 *
 *   1. Here — a requested tool is looked up in the agent's live catalog
 *      and refused unless its *registered* risk is READ_ONLY. The
 *      model's own opinion of a tool never enters into it.
 *   2. At the agent — the call goes through callToolAudited with
 *      `approved: false`, so the agent's own isAuthorized() rejects
 *      anything above READ_ONLY regardless of what this process asked
 *      for. Gate 1 failing open would still not grant execution.
 *
 * A refused tool is fed back to the model as a normal conversational
 * result, so it can adjust (usually by answering, or by proposing an
 * incident) rather than the turn dying.
 *
 * @param {object} opts
 * @param {string} opts.question
 * @param {Array<{role,content}>} [opts.history] - prior turns
 * @param {(type: string, data: object) => void} [opts.onEvent] - stream sink
 * @param {() => boolean} [opts.isCancelled] - polled between steps; when
 *   it returns true (the caller's HTTP connection died), the loop stops
 *   making further provider/tool calls rather than continuing to spend
 *   quota and agent calls on a turn nobody is listening to anymore.
 * @param {number} [opts.maxTurnMs] - wall-clock ceiling override, for tests.
 * @returns {Promise<{answer, toolCalls, suggestedIncident, cancelled?}>}
 */
async function runChat({ question, history = [], onEvent = () => {}, isCancelled = () => false, maxTurnMs = MAX_TURN_MS }) {
  const config = getAIConfig();
  if (!config.configured) {
    throw new Error('No AI provider configured. Add one in Settings first.');
  }

  const apiKey = getDecryptedAPIKey();
  const adapter = getProvider(config.provider);

  const catalog = await getAgentClient().listTools();
  const readOnly = catalog.filter(t => t.risk === 'READ_ONLY');
  const allowed = new Map(readOnly.map(t => [t.name, t]));

  const system = buildChatSystemPrompt(readOnly);
  const messages = [...historyToMessages(history), { role: 'user', content: question }];

  const toolCalls = [];
  const turnStartedAt = Date.now();

  for (let step = 1; step <= MAX_STEPS; step++) {
    if (isCancelled()) {
      return { answer: null, toolCalls, suggestedIncident: null, cancelled: true };
    }
    if (Date.now() - turnStartedAt > maxTurnMs) {
      const timedOut = timeoutAnswer(toolCalls.length);
      onEvent('answer', { text: timedOut });
      return { answer: timedOut, toolCalls, suggestedIncident: null };
    }

    const startedAt = Date.now();
    let result;
    try {
      result = await callProviderWithRetry(adapter, {
        system, messages,
        responseSchema: CHAT_STEP_SCHEMA,
        apiKey, model: config.model, baseUrl: config.baseUrl
      }, { provider: config.provider, model: config.model, step, question });
    } catch (err) {
      // Every attempt (including the retries) already got its own
      // ai_runs row inside callProviderWithRetry — this is the final,
      // exhausted failure, genuinely the operator's problem to see.
      throw err;
    }

    let parsed = null;
    let parseError = null;
    try {
      parsed = JSON.parse(result.text);
    } catch {
      parseError = 'Response was not valid JSON';
    }

    const { valid, errors } = parsed ? validateChatStep(parsed) : { valid: false, errors: [] };
    if (parsed && !valid) parseError = `Schema validation failed: ${errors.join('; ')}`;

    recordAiRun({
      incidentId: null, purpose: 'chat', provider: config.provider, model: config.model,
      attempt: step, requestSummary: question, rawResponse: result.text,
      parsedJson: valid ? parsed : null, error: parseError,
      usage: result.usage, latencyMs: Date.now() - startedAt
    });

    if (parseError) {
      messages.push({ role: 'assistant', content: result.text });
      messages.push({ role: 'user', content: `That was not a valid step object (${parseError}). Respond with ONLY the JSON object.` });
      continue;
    }

    if (parsed.thought) onEvent('thought', { text: parsed.thought });

    if (parsed.action === 'answer') {
      const answer = parsed.answer || parsed.thought || '(no answer)';
      onEvent('answer', { text: answer });
      const suggestedIncident = normalizeSuggestion(parsed.suggestedIncident);
      if (suggestedIncident) onEvent('suggest_incident', suggestedIncident);
      return { answer, toolCalls, suggestedIncident };
    }

    // --- action: 'tool' ---------------------------------------------
    messages.push({ role: 'assistant', content: result.text });

    if (toolCalls.length >= MAX_TOOL_CALLS) {
      messages.push({ role: 'user', content: `You have used your budget of ${MAX_TOOL_CALLS} tool calls. Answer the operator now with {"action":"answer","answer":"..."} using what you already know.` });
      continue;
    }

    const tool = allowed.get(parsed.tool);
    if (!tool) {
      // Gate 1. A tool that exists but mutates is refused by name here,
      // before the agent is ever contacted.
      const known = catalog.find(t => t.name === parsed.tool);
      const reason = known
        ? `"${parsed.tool}" is ${known.risk}. Ask Sentinel may only run READ_ONLY tools — it cannot change anything. If this needs doing, answer and include a suggestedIncident instead.`
        : `There is no tool named "${parsed.tool}".`;
      onEvent('tool_refused', { tool: parsed.tool || null, reason });
      messages.push({ role: 'user', content: `Tool call refused: ${reason}` });
      continue;
    }

    const params = parsed.params || {};
    onEvent('tool_call', { tool: tool.name, params });

    let summary;
    let ok;
    try {
      // Gate 2. approved:false — the agent independently re-derives
      // authorization from its own registered risk for this tool.
      const output = await callToolAudited(null, tool.name, params, {
        approved: false, requestedBy: 'chat', realRisk: tool.risk
      });
      summary = redact(summarizeToolResult(tool.name, output, CHAT_RESULT_LIMIT));
      ok = true;
    } catch (err) {
      summary = `${tool.name} failed: ${err.message}`;
      ok = false;
    }

    toolCalls.push({ tool: tool.name, params, ok, summary });
    onEvent('tool_result', { tool: tool.name, ok, summary });
    messages.push({ role: 'user', content: `Result of ${tool.name}:\n${summary}` });
  }

  // Ran out of steps without an answer — return what was gathered
  // rather than throwing, so the operator still sees the tool output.
  const fallback = toolCalls.length > 0
    ? "I wasn't able to reach a conclusion within my step budget. The tool output I gathered is above."
    : "I wasn't able to produce an answer for that.";
  onEvent('answer', { text: fallback });
  return { answer: fallback, toolCalls, suggestedIncident: null };
}

/** Only a well-formed suggestion is passed on; a partial one is dropped. */
function normalizeSuggestion(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const { resourceType, externalId, summary } = raw;
  if (!resourceType || !externalId) return null;
  return { resourceType: String(resourceType), externalId: String(externalId), summary: String(summary || '') };
}

module.exports = {
  runChat, buildChatSystemPrompt, normalizeSuggestion, MAX_TOOL_CALLS, MAX_STEPS, MAX_TURN_MS,
  retryableProviderStatus, PROVIDER_RETRY_ATTEMPTS, PROVIDER_RETRY_DELAY_MS, timeoutAnswer
};

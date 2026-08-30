'use strict';

const { getAgentClient } = require('../agent/client');
const { getAIConfig } = require('../settings/aiConfig');
const { chatWithFailover, isRetryable } = require('./failover');
const { CHAT_STEP_SCHEMA, validateChatStep } = require('./schema');
const { renderToolCatalog } = require('./orchestrator');
const { callToolAudited } = require('../incidents/toolCallAudit');
const { summarizeToolResult } = require('./summarize');
const { listLocalTools, callLocalTool } = require('./localTools');
const { getAllowedRoots } = require('../settings/accessScope');
const { recordAiRun } = require('./runs');
const { redact } = require('./redact');

/**
 * Hard ceilings on one turn. MAX_TOOL_CALLS bounds what a single
 * question can do to the host (and to the provider's quota);
 * MAX_STEPS additionally bounds the *conversation* so that a model
 * which keeps returning malformed JSON, or keeps asking for tools it
 * isn't allowed, terminates instead of looping.
 */
/**
 * Agent tools whose `roots` parameter is filled in from Settings rather
 * than by the model. Listing them explicitly (instead of sending `roots`
 * to everything) keeps every other tool's strict schema intact.
 */
const FILE_TOOLS = new Set(['list_directory', 'read_file', 'search_files']);

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
 * Re-exported from ai/failover.js, where the transient-retry policy now
 * lives so every AI call site shares one definition of "the provider is
 * flaky" vs "the config is wrong". Kept named here because this is where
 * the behaviour was found and is still exercised (ai/chat.test.js).
 */
const PROVIDER_RETRY_ATTEMPTS = 2; // extra tries beyond the first, per credential

function buildChatSystemPrompt(readOnlyCatalog, allowedRoots = []) {
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
    allowedRoots.length > 0
      ? `You may read files under these directories, and nowhere else: ${allowedRoots.join(', ')}. ` +
        'Use list_directory to explore and read_file (with a "tail" for logs) to read. Keys, ' +
        'credentials and secret stores are refused no matter where they sit.'
      : 'You have no filesystem access: no directory has been allowed by the operator. If a question ' +
        'needs one, say so and suggest they add it under Settings \u2192 Access Scope.',
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
 * Call the provider through the failover chain, recording every attempt
 * — including each credential that failed on the way — to ai_runs.
 *
 * The transient-status retry that used to live here now lives in
 * ai/failover.js (`retryTransient`), applied per credential before
 * moving on to the next one: a flaky provider should be retried on the
 * key the operator actually chose first, before falling back to a
 * different model whose answers may be worse.
 */
async function callProviderWithRetry(chatArgs, { step, question }) {
  return chatWithFailover(chatArgs, {
    purpose: 'chat',
    retryTransient: true,
    onAttemptError: ({ credential, error, latencyMs }) => recordAiRun({
      incidentId: null, purpose: 'chat',
      provider: credential.provider, model: credential.model, credentialId: credential.id, attempt: step,
      requestSummary: question, rawResponse: null, parsedJson: null,
      error: error.message, usage: null, latencyMs
    })
  });
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

  // Two sources, one catalog. Agent tools reach the host; local tools
  // answer from Sentinel's own database (recordings, incidents,
  // activity) and never leave this process. Both are READ_ONLY, so the
  // single "refuse anything not READ_ONLY" gate below covers both.
  const agentCatalog = await getAgentClient().listTools();
  const catalog = [...agentCatalog, ...listLocalTools()];
  const readOnly = catalog.filter(t => t.risk === 'READ_ONLY');
  const allowed = new Map(readOnly.map(t => [t.name, t]));

  // Directories the operator has opened up (Settings → Access Scope),
  // passed to the agent's file tools with each call. Empty by default,
  // in which case those tools refuse everything. The agent enforces its
  // own non-negotiable denials on top of this — see agent/src/tools/files.js.
  const allowedRoots = getAllowedRoots();

  // `roots` is supplied from Settings, never chosen by the model, so it
  // is hidden from the schema the prompt shows — otherwise the model
  // invents directory lists and the agent rejects the call.
  const promptCatalog = readOnly.map(tool => {
    if (!FILE_TOOLS.has(tool.name) || !tool.parameters?.properties?.roots) return tool;
    const { roots, ...properties } = tool.parameters.properties;
    return { ...tool, parameters: { ...tool.parameters, properties } };
  });

  const system = buildChatSystemPrompt(promptCatalog, allowedRoots);
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
      result = await callProviderWithRetry(
        { system, messages, responseSchema: CHAT_STEP_SCHEMA },
        { step, question }
      );
    } catch (err) {
      // Every attempt (including the retries) already got its own
      // ai_runs row inside callProviderWithRetry — this is the final,
      // exhausted failure, genuinely the operator's problem to see.
      throw err;
    }

    // Checked again here, not only at the top of the loop: a turn that
    // needs just one provider call would otherwise be uncancellable —
    // Stop would land while that call was in flight and the answer would
    // arrive anyway, making the button look broken. The request is
    // already paid for either way; what Stop means is "don't act on it".
    if (isCancelled()) {
      return { answer: null, toolCalls, suggestedIncident: null, cancelled: true };
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
      incidentId: null, purpose: 'chat',
      provider: result.credential.provider, model: result.credential.model,
      credentialId: result.credential.id,
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
      let output;
      if (tool.local) {
        // Sentinel's own records — no agent, no host privilege involved.
        output = await callLocalTool(tool.name, params);
      } else {
        // Gate 2. approved:false — the agent independently re-derives
        // authorization from its own registered risk for this tool.
        output = await callToolAudited(null, tool.name, {
          ...params,
          // The model never chooses the roots; they come from settings.
          // Sending them unconditionally would break every non-file
          // tool's strict `additionalProperties: false` schema.
          ...(FILE_TOOLS.has(tool.name) ? { roots: allowedRoots } : {})
        }, {
          approved: false, requestedBy: 'chat', realRisk: tool.risk
        });
      }
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
  retryableProviderStatus: isRetryable, PROVIDER_RETRY_ATTEMPTS, timeoutAnswer
};

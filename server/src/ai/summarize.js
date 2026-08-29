'use strict';

/**
 * Turn a tool's raw result into a bounded piece of text suitable for
 * storing as evidence or feeding back to a model.
 *
 * Shared by the incident engine (approved READ_ONLY investigation
 * actions, whose output becomes an incident_evidence row) and the chat
 * orchestrator (whose tool results go back into the conversation). Both
 * need the same two things: a readable rendering of the log-line arrays
 * the docker/journal tools return, and a hard length ceiling — an
 * unbounded `docker logs` dump would otherwise blow the context window
 * or the evidence row.
 */
const DEFAULT_LIMIT = 4000;

function summarizeToolResult(toolName, result, limit = DEFAULT_LIMIT) {
  if (result == null) return `${toolName}: (no output)`;
  // Log tools return arrays of {stream, text} or plain strings.
  const text = Array.isArray(result)
    ? result.map(l => (typeof l === 'string' ? l : `[${l.stream}] ${l.text}`)).join('\n')
    : JSON.stringify(result);
  return text.length > limit
    ? `${text.slice(0, limit)}\n… (truncated)`
    : text;
}

module.exports = { summarizeToolResult, DEFAULT_LIMIT };

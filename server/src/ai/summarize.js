'use strict';

/**
 * Turn a tool's raw result into a bounded piece of text suitable for
 * storing as evidence or feeding back to a model.
 *
 * Shared by the incident engine (approved READ_ONLY investigation
 * actions, whose output becomes an incident_evidence row) and the chat
 * orchestrator (whose tool results go back into the conversation). Both
 * need the same two things: a readable rendering of the log-line arrays
 * `get_container_logs`/`get_service_logs` return, and a hard length
 * ceiling — an unbounded `docker logs` dump would otherwise blow the
 * context window or the evidence row.
 *
 * The array case is shape-checked, not just type-checked. Every
 * READ_ONLY tool that returns an array was originally assumed to be a
 * log-line dump (`{stream, text}` frames, or plain strings from
 * journalctl) — true for the two log tools, but `list_containers`,
 * `list_services`, `get_docker_events` and `inspect_processes` also
 * return arrays, of arbitrary objects that have neither field. Forcing
 * those through the log-line template silently produced
 * "[undefined] undefined" per element (found live via Ask Sentinel
 * asking `list_containers` for unhealthy containers) — which also fed
 * the model garbage instead of the real container list, in the one
 * place this function's output goes back into a conversation rather
 * than just being displayed.
 */
const DEFAULT_LIMIT = 4000;

function isLogLine(item) {
  return item !== null && typeof item === 'object'
    && typeof item.text === 'string' && typeof item.stream === 'string';
}

function summarizeToolResult(toolName, result, limit = DEFAULT_LIMIT) {
  if (result == null) return `${toolName}: (no output)`;

  let text;
  if (Array.isArray(result)) {
    if (result.length === 0) {
      text = '(empty)';
    } else if (result.every(l => typeof l === 'string' || isLogLine(l))) {
      text = result.map(l => (typeof l === 'string' ? l : `[${l.stream}] ${l.text}`)).join('\n');
    } else {
      // Not a log-line array — e.g. list_containers/list_services'
      // objects, or get_docker_events' event records. Render whole.
      text = JSON.stringify(result);
    }
  } else {
    text = JSON.stringify(result);
  }

  return text.length > limit
    ? `${text.slice(0, limit)}\n… (truncated)`
    : text;
}

module.exports = { summarizeToolResult, DEFAULT_LIMIT };

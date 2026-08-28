'use strict';

/**
 * Short-lived suppression of detector rules for resources Sentinel
 * itself just acted on.
 *
 * Without this, any mutating action taken *through* Sentinel — a user
 * clicking Stop on the Services page, or an approved remediation
 * restarting a container — immediately produces the very events the
 * detector is watching for, and Sentinel pages itself for the
 * consequence of its own deliberate action. That isn't a monitoring
 * signal; it's an echo.
 *
 * Found for real: stopping `docker` from the Services page killed every
 * container on the host, each of which emitted a `die` event with a
 * non-zero exit code, raising a HIGH incident per container within
 * seconds — including for unrelated production containers.
 *
 * Deliberately in-memory and not persisted: a suppression window is
 * measured in seconds and only meaningful while the process that issued
 * the action is still running. A restart clearing it is the correct
 * behavior — after a restart, whatever is still broken *should* page.
 */

const DEFAULT_WINDOW_MS = 90000;

/** `${type}:${externalId}` (or `${type}:*` for a whole-type window) -> expiry ms. */
const windows = new Map();

function keyFor(type, externalId) {
  return `${type}:${externalId}`;
}

function set(key, ms) {
  const until = Date.now() + ms;
  // Never shorten an existing, longer window.
  if ((windows.get(key) || 0) < until) windows.set(key, until);
}

/** Suppress detector rules for one resource. */
function suppressResource(type, externalId, ms = DEFAULT_WINDOW_MS) {
  set(keyFor(type, externalId), ms);
}

/** Suppress detector rules for every resource of a type (see the docker case below). */
function suppressType(type, ms = DEFAULT_WINDOW_MS) {
  set(keyFor(type, '*'), ms);
}

function isActive(key) {
  const until = windows.get(key);
  if (!until) return false;
  if (until <= Date.now()) {
    windows.delete(key);
    return false;
  }
  return true;
}

/** True while either this exact resource or its whole type is suppressed. */
function isSuppressed(type, externalId) {
  return isActive(keyFor(type, '*')) || isActive(keyFor(type, externalId));
}

/**
 * Map a mutating tool call to the resource(s) it will disturb, and
 * suppress them. Called from every path that mutates host state on a
 * human's behalf: the Docker/Services routes (direct UI actions) and
 * the incident engine's approved remediations.
 *
 * The `docker` special case is the one that actually matters: stopping
 * or restarting the container runtime takes every container down with
 * it, so the whole `container` type is suppressed for that window, not
 * just the `service:docker` resource.
 */
function suppressForToolCall(toolName, params = {}, ms = DEFAULT_WINDOW_MS) {
  if (toolName.endsWith('_container') && params.id) {
    suppressResource('container', params.id, ms);
    return;
  }

  if (toolName.endsWith('_service') && params.service) {
    suppressResource('service', params.service, ms);
    if (params.service === 'docker') suppressType('container', ms);
  }
}

/** Test seam — windows are process-local, so tests must be able to reset them. */
function _clearAll() {
  windows.clear();
}

module.exports = {
  DEFAULT_WINDOW_MS,
  suppressResource, suppressType, suppressForToolCall, isSuppressed, _clearAll
};

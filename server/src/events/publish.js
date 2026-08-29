'use strict';

/**
 * One-way fan-out of server-side events to connected browser clients.
 *
 * The dependency is deliberately INVERTED: this module never requires
 * `websocket/broadcaster.js`. The broadcaster registers itself here at
 * init instead (`setSink`). Requiring it from the store or the activity
 * logger — even lazily, at call time — would drag in the auth middleware
 * and the agent client behind it, and `auth/middleware.js` exits the
 * process when JWT_SECRET is unset. That turned every store/logger unit
 * test into a fatal boot of the whole web layer.
 *
 * Delivery is best-effort by design: with no sink registered (every unit
 * test, and the window before the HTTP server is up) publish is a no-op,
 * and a throwing sink can never turn a successful DB write into an
 * error. The browser's own polling stays the source of truth — this only
 * makes it feel immediate.
 */

let sink = null;

/**
 * @param {(type: string, data: object) => void} fn - usually
 *   broadcaster.broadcast; pass null to detach.
 */
function setSink(fn) {
  sink = fn;
}

/**
 * @param {string} type - envelope type the client dispatcher switches on
 *   ('activity' | 'incident'); 'metrics'/'init' stay owned by the
 *   broadcaster's own 1 Hz ticker.
 * @param {object} data - JSON-serializable payload
 */
function publish(type, data) {
  if (!sink) return;
  try {
    sink(type, data);
  } catch (err) {
    console.error(`[events] publish(${type}) failed:`, err.message);
  }
}

module.exports = { publish, setSink };

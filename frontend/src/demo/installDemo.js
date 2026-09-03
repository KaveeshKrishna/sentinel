/**
 * Turns the running SPA into the self-contained public demo:
 *   - every `/api/*` fetch is served from in-browser fabricated state
 *   - the `/ws` WebSocket is fed by a local telemetry simulator
 * No real backend is contacted (the demo build has none).
 *
 * Called once from main.jsx, guarded by import.meta.env.VITE_DEMO so all
 * of frontend/src/demo/ is tree-shaken out of the normal build.
 */
import { initState } from './state.js';
import { installFetch } from './mockServer.js';
import { MockWebSocket } from './mockWebSocket.js';

export function installDemo() {
  initState();
  installFetch();
  window.WebSocket = MockWebSocket;
  try { document.title = 'Sentinel — Interactive Demo'; } catch { /* ignore */ }
}

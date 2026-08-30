/**
 * A stand-in for `window.WebSocket` used only in the demo build.
 *
 * `hooks/useWebSocket.jsx` opens `new WebSocket('.../ws')` and reads
 * `readyState`, `onopen`, `onmessage`, `onclose`, `onerror`, `close()`,
 * plus the static `WebSocket.OPEN`. This reproduces exactly that surface
 * and feeds it from liveSim.
 */
import { subscribe } from './liveSim.js';

export class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  constructor() {
    this.readyState = MockWebSocket.CONNECTING;
    this.onopen = null;
    this.onmessage = null;
    this.onclose = null;
    this.onerror = null;
    this._unsub = null;

    setTimeout(() => {
      this.readyState = MockWebSocket.OPEN;
      this.onopen?.({ type: 'open' });
      this._unsub = subscribe((msg) => {
        if (this.readyState !== MockWebSocket.OPEN) return;
        this.onmessage?.({ data: JSON.stringify(msg) });
      });
    }, 60);
  }

  send() { /* the demo has nothing to receive */ }

  close() {
    this.readyState = MockWebSocket.CLOSED;
    this._unsub?.();
    this._unsub = null;
    this.onclose?.({ type: 'close', wasClean: true });
  }

  addEventListener(type, fn) {
    if (type === 'open') this.onopen = fn;
    else if (type === 'message') this.onmessage = fn;
    else if (type === 'close') this.onclose = fn;
    else if (type === 'error') this.onerror = fn;
  }
  removeEventListener() { /* no-op */ }
}

import { createContext, useContext, useEffect, useState, useRef, useCallback } from 'react';

const WSContext = createContext(null);

const MAX_LIVE_EVENTS = 50;

export function WebSocketProvider({ children }) {
  const [metrics, setMetrics]   = useState(null);
  const [connected, setConnected] = useState(false);
  // Most recent incident push. `tick` increments on every message so a
  // consumer can re-fetch even when two consecutive pushes are identical
  // (e.g. the same incident re-entering INVESTIGATING).
  const [lastIncident, setLastIncident] = useState(null);
  const [incidentTick, setIncidentTick] = useState(0);
  const [liveEvents, setLiveEvents]     = useState([]);
  const wsRef       = useRef(null);
  const timerRef    = useRef(null);

  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${protocol}//${window.location.host}/ws`);

    ws.onopen  = () => { setConnected(true); clearTimeout(timerRef.current); };
    ws.onclose = () => {
      setConnected(false);
      timerRef.current = setTimeout(connect, 5000);
    };
    ws.onerror = () => ws.close();
    ws.onmessage = ({ data }) => {
      try {
        const msg = JSON.parse(data);
        if (msg.type === 'metrics' || msg.type === 'init') {
          setMetrics({ ...msg.data, history: msg.history });
        } else if (msg.type === 'incident') {
          setLastIncident(msg.data);
          setIncidentTick(t => t + 1);
        } else if (msg.type === 'activity') {
          setLiveEvents(prev => [msg.data, ...prev].slice(0, MAX_LIVE_EVENTS));
        }
      } catch {}
    };
    wsRef.current = ws;
  }, []);

  useEffect(() => {
    connect();
    return () => {
      clearTimeout(timerRef.current);
      wsRef.current?.close();
    };
  }, [connect]);

  return (
    <WSContext.Provider value={{ metrics, connected, lastIncident, incidentTick, liveEvents }}>
      {children}
    </WSContext.Provider>
  );
}

export function useMetrics()   { return useContext(WSContext); }
export function useConnected() { return useContext(WSContext)?.connected; }

/**
 * Live server-pushed events. `incidentTick` is the value to put in a
 * useEffect dependency array to refetch on any incident change.
 */
export function useLiveEvents() {
  const ctx = useContext(WSContext);
  return {
    lastIncident: ctx?.lastIncident ?? null,
    incidentTick: ctx?.incidentTick ?? 0,
    liveEvents: ctx?.liveEvents ?? []
  };
}

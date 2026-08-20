import { createContext, useContext, useEffect, useState, useRef, useCallback } from 'react';

const WSContext = createContext(null);

export function WebSocketProvider({ children }) {
  const [metrics, setMetrics]   = useState(null);
  const [connected, setConnected] = useState(false);
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
    <WSContext.Provider value={{ metrics, connected }}>
      {children}
    </WSContext.Provider>
  );
}

export function useMetrics()   { return useContext(WSContext); }
export function useConnected() { return useContext(WSContext)?.connected; }

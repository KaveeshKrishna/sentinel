import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useLiveEvents } from '../../hooks/useWebSocket';

const DISMISS_MS = 9000;

/**
 * Which incident states are worth interrupting someone for. Every other
 * transition (DETECTED -> INVESTIGATING, REMEDIATING, ...) is visible in
 * the Incidents list and on the timeline; toasting all of them would
 * make the useful ones easy to miss.
 */
const NOTABLE = {
  DETECTED:          { icon: '🔴', tone: 'red',    title: 'Incident detected' },
  AWAITING_APPROVAL: { icon: '⏳', tone: 'yellow', title: 'Approval needed' },
  RESOLVED:          { icon: '✔',  tone: 'green',  title: 'Incident resolved' },
  FAILED:            { icon: '❌', tone: 'red',    title: 'Remediation failed' }
};

export default function ToastHost() {
  const { lastIncident, incidentTick } = useLiveEvents();
  const [toasts, setToasts] = useState([]);
  const navigate = useNavigate();
  const seenTick = useRef(0);

  useEffect(() => {
    if (!lastIncident || incidentTick === seenTick.current) return;
    seenTick.current = incidentTick;

    const meta = NOTABLE[lastIncident.status];
    if (!meta) return;

    const toast = {
      key: `${lastIncident.id}-${lastIncident.status}-${incidentTick}`,
      incidentId: lastIncident.id,
      ...meta,
      body: lastIncident.rootCause || lastIncident.triggerSummary || lastIncident.triggerRule
    };
    setToasts(prev => [toast, ...prev].slice(0, 4));

    const timer = setTimeout(
      () => setToasts(prev => prev.filter(t => t.key !== toast.key)),
      DISMISS_MS
    );
    return () => clearTimeout(timer);
  }, [lastIncident, incidentTick]);

  function dismiss(key) {
    setToasts(prev => prev.filter(t => t.key !== key));
  }

  if (toasts.length === 0) return null;

  return (
    <div className="toast-host">
      {toasts.map(t => (
        <div
          key={t.key}
          id={`toast-${t.incidentId}`}
          className={`toast toast-${t.tone}`}
          role="status"
          onClick={() => { dismiss(t.key); navigate(`/incidents/${t.incidentId}`); }}
        >
          <span className="toast-icon">{t.icon}</span>
          <div className="toast-body">
            <div className="toast-title">{t.title} · #{t.incidentId}</div>
            <div className="toast-text">{t.body}</div>
          </div>
          <button
            className="toast-close"
            aria-label="Dismiss"
            onClick={(e) => { e.stopPropagation(); dismiss(t.key); }}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}

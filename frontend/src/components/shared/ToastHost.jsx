import { useEffect, useRef, useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useLiveEvents } from '../../hooks/useWebSocket';
import Icon from './Icon';

const DISMISS_MS = 9000;

/**
 * Which incident states are worth interrupting someone for. Every other
 * transition (DETECTED -> INVESTIGATING, REMEDIATING, ...) is visible in
 * the Incidents list and on the timeline; toasting all of them would
 * make the useful ones easy to miss.
 */
const NOTABLE = {
  DETECTED:          { icon: 'alert-circle', tone: 'red',    title: 'Incident detected' },
  AWAITING_APPROVAL: { icon: 'refresh-cw',    tone: 'yellow', title: 'Approval needed' },
  RESOLVED:          { icon: 'check',         tone: 'green',  title: 'Incident resolved' },
  FAILED:            { icon: 'x-circle',      tone: 'red',    title: 'Remediation failed' }
};

/**
 * AI credential failover. Both are worth a toast for different reasons:
 * a failover means nothing broke but a key the operator is paying for (or
 * relying on) just stopped working, and an exhausted chain means the
 * reasoning loop has actually stalled. Both carry the provider's own
 * error text, so the operator sees the real reason immediately rather
 * than having to go and read logs.
 */
const AI_TOASTS = {
  AI_PROVIDER_FAILOVER:  { icon: 'shuffle',      tone: 'yellow', title: 'AI provider switched' },
  AI_PROVIDER_EXHAUSTED: { icon: 'slash-circle', tone: 'red',    title: 'All AI providers failed' }
};

/** The first real reason from a failover payload, for the toast body. */
function firstReason(problem) {
  const failure = problem.failures?.[0];
  return failure ? `${failure.label}: ${failure.error}` : problem.message;
}

const CHAT_TOASTS = {
  answered: { icon: 'message-circle',  tone: 'green', title: 'Ask Sentinel answered' },
  failed:   { icon: 'alert-triangle',  tone: 'red',   title: 'Ask Sentinel failed' }
};

export default function ToastHost() {
  const { lastIncident, incidentTick, lastAiProblem, aiProblemTick, lastChat, chatTick } = useLiveEvents();
  const [toasts, setToasts] = useState([]);
  const navigate = useNavigate();
  const seenTick = useRef(0);
  const seenAiTick = useRef(0);
  const seenChatTick = useRef(0);

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

  useEffect(() => {
    if (!lastAiProblem || aiProblemTick === seenAiTick.current) return;
    seenAiTick.current = aiProblemTick;

    const meta = AI_TOASTS[lastAiProblem.type];
    if (!meta) return;

    const toast = {
      key: `ai-${aiProblemTick}`,
      // Clicking through goes to Settings, where the same reason is shown
      // per credential and can actually be fixed.
      href: '/settings',
      ...meta,
      body: firstReason(lastAiProblem)
    };
    setToasts(prev => [toast, ...prev].slice(0, 4));

    const timer = setTimeout(
      () => setToasts(prev => prev.filter(t => t.key !== toast.key)),
      DISMISS_MS
    );
    return () => clearTimeout(timer);
  }, [lastAiProblem, aiProblemTick]);

  // A turn keeps running after you navigate away, so its answer has to
  // come and find you. Suppressed while Ask Sentinel is already open —
  // there the answer appears in the transcript itself.
  const location = useLocation();
  useEffect(() => {
    if (!lastChat || chatTick === seenChatTick.current) return;
    seenChatTick.current = chatTick;
    if (location.pathname.startsWith('/ask')) return;

    const meta = CHAT_TOASTS[lastChat.event];
    if (!meta) return;

    const toast = {
      key: `chat-${chatTick}`,
      href: `/ask?session=${lastChat.sessionId}`,
      ...meta,
      body: lastChat.error || lastChat.preview || lastChat.question
    };
    setToasts(prev => [toast, ...prev].slice(0, 4));

    const timer = setTimeout(
      () => setToasts(prev => prev.filter(t => t.key !== toast.key)),
      DISMISS_MS
    );
    return () => clearTimeout(timer);
  }, [lastChat, chatTick, location.pathname]);

  function dismiss(key) {
    setToasts(prev => prev.filter(t => t.key !== key));
  }

  if (toasts.length === 0) return null;

  return (
    <div className="toast-host">
      {toasts.map(t => (
        <div
          key={t.key}
          id={t.incidentId ? `toast-${t.incidentId}` : `toast-${t.key}`}
          className={`toast toast-${t.tone}`}
          role="status"
          onClick={() => { dismiss(t.key); navigate(t.href || `/incidents/${t.incidentId}`); }}
        >
          <span className="toast-icon"><Icon name={t.icon} size={18} /></span>
          <div className="toast-body">
            <div className="toast-title">{t.title}{t.incidentId ? ` · #${t.incidentId}` : ''}</div>
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

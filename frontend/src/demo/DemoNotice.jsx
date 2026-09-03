/**
 * The demo badge + explanatory popup.
 *
 * <DemoBadge/> renders a small "DEMO" pill (shown on the login page and
 * to the left of the "Live" indicator in the header). Clicking it opens
 * <DemoModal/>. When `autoOpen` is set (the header instance, mounted only
 * after login) the modal also opens automatically once per browser.
 *
 * This module is only ever dynamically imported when import.meta.env
 * .VITE_DEMO is set, so it (and everything it pulls from ./state.js) stays
 * out of the normal build.
 */
import { useEffect, useState } from 'react';
import { resetDemo } from './state.js';

function WarnIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
      <line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
  );
}
function InfoIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="10" /><line x1="12" y1="16" x2="12" y2="12" /><line x1="12" y1="8" x2="12.01" y2="8" />
    </svg>
  );
}

export function DemoModal({ open, onClose }) {
  if (!open) return null;
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card demo-modal" onClick={e => e.stopPropagation()} role="alertdialog" aria-modal="true">
        <div className="demo-modal-eyebrow"><WarnIcon /> Important : please read</div>
        <div className="demo-modal-title">You're viewing the DEMO version of Sentinel</div>
        <p className="demo-modal-text">
          <strong>Every value on this dashboard is completely fabricated.</strong> Sentinel
          normally operates on sensitive personal VPS data that can't be shared with others,
          so this build has <strong>no backend at all</strong>, the telemetry, incidents,
          deployments and AI responses you see are simulated entirely in your browser.
        </p>
        <p className="demo-modal-text">
          Try any feature, including <strong>Ask Sentinel</strong> and approving the open
          incident, to get a feel for how the real product works. Changes you make are saved
          only in this browser.
        </p>
        <div className="modal-actions">
          <button className="btn btn-secondary btn-sm" onClick={() => { onClose(); resetDemo(); }}>
            Reset demo
          </button>
          <button className="btn btn-primary btn-sm" onClick={onClose}>I understand</button>
        </div>
      </div>
    </div>
  );
}

export function DemoBadge({ compact, autoOpen }) {
  const [open, setOpen] = useState(false);

  // Shows on every page load (each fresh visit), not just the first —
  // the badge to the left of "Live" reopens it any time within a session.
  useEffect(() => {
    if (autoOpen) setOpen(true);
  }, [autoOpen]);

  function close() {
    setOpen(false);
  }

  return (
    <>
      <button
        type="button"
        className="demo-badge"
        onClick={() => setOpen(true)}
        title="About this demo"
        style={compact ? undefined : { marginTop: 10 }}
      >
        <InfoIcon /> DEMO
      </button>
      <DemoModal open={open} onClose={close} />
    </>
  );
}

import { useState } from 'react';

/**
 * One collapsible settings panel.
 *
 * Every setting used to be an always-open card stacked vertically, which
 * made the page a long scroll where nothing was findable and the AI
 * provider config (the one people actually change) sat the same distance
 * away as thresholds nobody touches. Collapsing everything by default
 * except what the caller marks `defaultOpen` puts the whole surface on
 * one screen, and the `summary` line means a collapsed section still
 * tells you its current state without being opened.
 *
 * Open/closed is deliberately local component state, not persisted: it's
 * a per-visit reading convenience, not a preference worth a settings row.
 */
export default function SettingsSection({
  id, icon, title, description, summary, defaultOpen = false, children
}) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <section className={`settings-section${open ? ' is-open' : ''}`}>
      <button
        type="button"
        id={id ? `settings-toggle-${id}` : undefined}
        className="settings-section-head"
        aria-expanded={open}
        aria-controls={id ? `settings-body-${id}` : undefined}
        onClick={() => setOpen(o => !o)}
      >
        <span className="settings-section-icon" aria-hidden="true">{icon}</span>
        <span className="settings-section-titles">
          <span className="settings-section-title">{title}</span>
          {description && <span className="settings-section-desc">{description}</span>}
        </span>
        {summary && <span className="settings-section-summary">{summary}</span>}
        <span className="settings-section-chevron" aria-hidden="true">›</span>
      </button>

      {open && (
        <div className="settings-section-body" id={id ? `settings-body-${id}` : undefined}>
          {children}
        </div>
      )}
    </section>
  );
}

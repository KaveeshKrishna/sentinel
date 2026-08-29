import { useEffect, useState } from 'react';
import { api } from '../../api/client';
import Icon from '../shared/Icon';

/**
 * The AI-written post-incident report.
 *
 * Rendered from the stored *structure*, not from markdown — the server
 * validates it against REPORT_SCHEMA and derives the markdown for the
 * copy button, so nothing here has to parse untrusted model output into
 * HTML.
 */
export default function IncidentReport({ incidentId, isTerminal, refreshKey }) {
  const [data, setData] = useState(null);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api.get(`/incidents/${incidentId}/report`)
      .then(d => { if (!cancelled) setData(d); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [incidentId, refreshKey]);

  async function generate() {
    setGenerating(true);
    setError(null);
    try {
      setData(await api.post(`/incidents/${incidentId}/report`));
    } catch (err) {
      setError(err.message);
    } finally {
      setGenerating(false);
    }
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(data.markdown);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError('Could not copy to clipboard');
    }
  }

  // Nothing to show, and nothing to generate from, while the incident is
  // still open — a report on an unfinished incident would be guesswork.
  if (!isTerminal && !data?.report) return null;

  const report = data?.report;

  return (
    <div className="card">
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
        <div className="card-title" style={{ margin: 0 }}><Icon name="clipboard" /> Post-Incident Report</div>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
          {report && (
            <button className="btn btn-secondary btn-sm" id="btn-copy-report" onClick={copy}>
              {copied ? <><Icon name="check" size={12} /> Copied</> : <><Icon name="file" size={12} /> Copy as Markdown</>}
            </button>
          )}
          <button className="btn btn-secondary btn-sm" id="btn-generate-report" onClick={generate} disabled={generating}>
            {generating ? 'Writing…' : report ? <><Icon name="refresh-cw" size={12} /> Regenerate</> : <><Icon name="zap" size={12} /> Generate</>}
          </button>
        </div>
      </div>

      {error && <div className="error-msg">{error}</div>}

      {!report && !generating && !error && (
        <div style={{ fontSize: '0.82rem', color: 'var(--text-muted)' }}>
          No report yet — Sentinel writes one automatically when an incident closes.
        </div>
      )}

      {report && (
        <div className="report">
          <div className="report-title">{report.title || `Incident #${incidentId}`}</div>
          <ReportSection label="Summary" text={report.summary} />
          <ReportSection label="Impact" text={report.impact} />
          <ReportSection label="Root cause" text={report.rootCause} />
          <ReportSection label="Resolution" text={report.resolution} />
          <ReportList label="Timeline" items={report.timeline} mono />
          <ReportList label="Prevention" items={report.prevention} />
          {data.generatedAt && (
            <div className="report-footer">
              Written by Sentinel · {new Date(data.generatedAt).toLocaleString('en-GB', { hour12: false })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ReportSection({ label, text }) {
  if (!text) return null;
  return (
    <div className="report-section">
      <div className="report-label">{label}</div>
      <div className="report-text">{text}</div>
    </div>
  );
}

function ReportList({ label, items, mono }) {
  if (!items?.length) return null;
  return (
    <div className="report-section">
      <div className="report-label">{label}</div>
      <ul className="report-list">
        {items.map((it, i) => <li key={i} className={mono ? 'mono' : undefined}>{it}</li>)}
      </ul>
    </div>
  );
}

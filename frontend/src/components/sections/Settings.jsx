import { useState, useEffect } from 'react';
import { api } from '../../api/client';
import SettingsSection from '../shared/SettingsSection';
import Icon from '../shared/Icon';
import AIProvidersSettings from './AIProvidersSettings';
import DetectorSettings from './DetectorSettings';
import AutoRemediateSettings from './AutoRemediateSettings';
import NotifySettings from './NotifySettings';
import AccessSettings from './AccessSettings';

/**
 * Settings, grouped by what the setting is *for* rather than by which
 * module implements it, and collapsed by default so the whole surface
 * fits on one screen.
 *
 * The groups follow the product's own reasoning loop — Intelligence is
 * what powers DIAGNOSE, Detection & Response covers OBSERVE and ACT, and
 * Alerting is how a human finds out. AI providers is the one section open
 * on arrival: it's both the most-changed and the only one whose failure
 * silently disables everything else.
 */
export default function Settings() {
  const [summary, setSummary] = useState({ ai: null, autoRemediate: null, notify: null, access: null });

  // One lightweight pass so each collapsed section can state its own
  // status without being expanded. Deliberately best-effort: a section
  // renders fine (and fetches its own data) with no summary.
  useEffect(() => {
    let cancelled = false;
    async function load() {
      const [ai, auto, notify, access] = await Promise.all([
        api.get('/settings/ai/credentials').catch(() => null),
        api.get('/settings/auto-remediate').catch(() => null),
        api.get('/settings/notify').catch(() => null),
        api.get('/settings/access').catch(() => null)
      ]);
      if (cancelled) return;

      const credentials = ai?.credentials || [];
      const failing = credentials.filter(c => c.lastError).length;
      const enabled = credentials.filter(c => c.enabled).length;

      setSummary({
        ai: credentials.length === 0
          ? { text: 'Not configured', tone: 'red' }
          : failing > 0
            ? { text: `${failing} of ${credentials.length} failing`, tone: 'yellow' }
            : { text: enabled === 1 ? '1 provider' : `${enabled} providers`, tone: 'green' },
        autoRemediate: auto
          ? (auto.resources.length === 0
              ? { text: 'Off', tone: 'gray' }
              : { text: `${auto.resources.length} opted in`, tone: 'yellow' })
          : null,
        notify: notify
          ? (() => {
              // No single "enabled" flag — a channel counts as on once it
              // has a webhook URL saved (see settings/notifyConfig.js).
              const on = Object.values(notify.channels || {}).filter(c => c.configured).length;
              return on === 0
                ? { text: 'Off', tone: 'gray' }
                : { text: on === 1 ? '1 channel' : `${on} channels`, tone: 'green' };
            })()
          : null,
        access: access
          ? (access.paths.length === 0
              ? { text: access.ownData ? 'Own data only' : 'Closed', tone: 'gray' }
              : { text: `${access.paths.length} path${access.paths.length === 1 ? '' : 's'}`, tone: 'yellow' })
          : null
      });
    }
    load();
    return () => { cancelled = true; };
  }, []);

  const badge = s => s && (
    <span className={`badge badge-${s.tone}`}>
      <span className="badge-dot" style={{ background: `var(--${s.tone === 'gray' ? 'text-dim' : s.tone})` }} />
      {s.text}
    </span>
  );

  return (
    <div className="settings-page">
      <div className="settings-group">
        <h2 className="settings-group-title">Intelligence</h2>
        <SettingsSection
          id="ai-providers"
          icon={<Icon name="cpu" />}
          title="AI Providers"
          description="Keys used to diagnose incidents, answer questions and write reports — tried in order, with automatic failover."
          summary={badge(summary.ai)}
          defaultOpen
        >
          <AIProvidersSettings />
        </SettingsSection>
      </div>

      <div className="settings-group">
        <h2 className="settings-group-title">Detection &amp; Response</h2>
        <SettingsSection
          id="detector"
          icon={<Icon name="sliders" />}
          title="Detector Thresholds"
          description="How sensitive Sentinel is before it raises an incident."
        >
          <DetectorSettings />
        </SettingsSection>
        <SettingsSection
          id="access"
          icon={<Icon name="search" />}
          title="Access Scope"
          description="What Ask Sentinel may look at — its own records, and which host directories it can read."
          summary={badge(summary.access)}
        >
          <AccessSettings />
        </SettingsSection>
        <SettingsSection
          id="auto-remediate"
          icon={<Icon name="bandage" />}
          title="Auto-Remediation"
          description="Which resources Sentinel may restart on its own, without waiting for approval."
          summary={badge(summary.autoRemediate)}
        >
          <AutoRemediateSettings />
        </SettingsSection>
      </div>

      <div className="settings-group">
        <h2 className="settings-group-title">Alerting</h2>
        <SettingsSection
          id="notify"
          icon={<Icon name="bell" />}
          title="Notifications"
          description="Push incident events to Slack, Discord or a webhook."
          summary={badge(summary.notify)}
        >
          <NotifySettings />
        </SettingsSection>
      </div>
    </div>
  );
}

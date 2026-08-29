'use strict';

/**
 * One channel-agnostic payload per event, rendered per channel by
 * notify/channels/*. Keeping the shaping here means a new channel is a
 * renderer, not another copy of the wording.
 */

const EVENT_META = {
  INCIDENT_DETECTED:         { emoji: '🔴', color: '#ef4444', headline: 'Incident detected' },
  INCIDENT_AWAITING_APPROVAL:{ emoji: '⏳', color: '#f59e0b', headline: 'Approval needed' },
  INCIDENT_AUTO_REMEDIATE:   { emoji: '🤖', color: '#06b6d4', headline: 'Auto-remediating' },
  INCIDENT_RESOLVED:         { emoji: '✅', color: '#22c55e', headline: 'Incident resolved' },
  INCIDENT_FAILED:           { emoji: '❌', color: '#ef4444', headline: 'Remediation failed' }
};

/** Discord's decimal colour ints, from the same hex the UI uses. */
function decimalColor(hex) {
  return parseInt(hex.replace('#', ''), 16);
}

/**
 * @param {string} event - one of EVENT_META's keys
 * @param {object} ctx
 * @param {object} ctx.incident
 * @param {object|null} [ctx.resource]
 * @param {object|null} [ctx.action] - the proposed action, when there is one
 * @param {string|null} [ctx.approveUrl] - a signed one-click link, when enabled
 * @param {string|null} [ctx.incidentUrl] - deep link into the UI
 */
function buildNotification(event, { incident, resource, action, approveUrl, incidentUrl }) {
  const meta = EVENT_META[event] || { emoji: '•', color: '#8b949e', headline: event };
  const target = resource ? `${resource.name} (${resource.type})` : `resource #${incident.resource_id}`;

  const fields = [
    { label: 'Resource', value: target },
    { label: 'Trigger', value: `${incident.trigger_rule} — ${incident.trigger_summary}` }
  ];
  if (incident.root_cause) fields.push({ label: 'Root cause', value: incident.root_cause });
  if (action) fields.push({ label: 'Proposed action', value: `${action.tool_name} (${action.real_risk})` });

  const links = [];
  // The approve link goes first: on a phone it's the reason the message
  // was worth opening.
  if (approveUrl && action) links.push({ label: `Approve ${action.tool_name}`, url: approveUrl, primary: true });
  if (incidentUrl) links.push({ label: 'Open in Sentinel', url: incidentUrl });

  return {
    event,
    emoji: meta.emoji,
    color: meta.color,
    colorInt: decimalColor(meta.color),
    title: `${meta.emoji} ${meta.headline} · Incident #${incident.id}`,
    text: `${target}: ${incident.root_cause || incident.trigger_summary}`,
    fields,
    links
  };
}

module.exports = { buildNotification, EVENT_META };

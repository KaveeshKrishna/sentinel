'use strict';

const recordingDb = require('../recording/db');
const store = require('../incidents/store');
const { getResource } = require('../graph/resources');
const { getEvents } = require('../activity/logger');
const { getAccessScope } = require('../settings/accessScope');

/**
 * Tools that answer from Sentinel's OWN database rather than the host.
 *
 * These never reach the agent: recording sessions, incidents and the
 * activity timeline are rows this process already wrote, so routing a
 * question about them through a privileged process would add risk and
 * a round trip for nothing.
 *
 * The gap they close is real. Asked "summarise recording session
 * #2026-08-29T15:19", Ask Sentinel could only answer that it has no
 * access to recording data — true, and useless: the data was sitting in
 * the same SQLite file the process had open.
 *
 * All READ_ONLY by construction — there is no handler here that writes.
 * Availability is gated on Settings → Access Scope's `ownData`.
 */

const MAX_ROWS = 50;

/** A recording session summarised the way a human would want it read. */
function summariseSession(session) {
  const samples = recordingDb.getSamples(session.id);
  if (samples.length === 0) {
    return { ...session, samples: 0, note: 'This session recorded no samples.' };
  }

  const stat = (key) => {
    const values = samples.map(s => s[key]).filter(v => typeof v === 'number');
    if (values.length === 0) return null;
    const sum = values.reduce((a, b) => a + b, 0);
    return {
      avg: Math.round((sum / values.length) * 10) / 10,
      min: Math.round(Math.min(...values) * 10) / 10,
      max: Math.round(Math.max(...values) * 10) / 10
    };
  };

  const containers = recordingDb.getContainerSamples(session.id);
  const byContainer = new Map();
  for (const row of containers) {
    const entry = byContainer.get(row.container_name) || { samples: 0, cpuTotal: 0, memTotal: 0 };
    entry.samples++;
    entry.cpuTotal += row.cpu_percent || 0;
    entry.memTotal += row.mem_percent || 0;
    byContainer.set(row.container_name, entry);
  }

  return {
    id: session.id,
    name: session.name,
    startedAt: session.start_time ? new Date(session.start_time).toISOString() : null,
    endedAt: session.end_time ? new Date(session.end_time).toISOString() : null,
    durationMinutes: session.end_time && session.start_time
      ? Math.round((session.end_time - session.start_time) / 60000)
      : null,
    sampleCount: samples.length,
    cpuPercent: stat('cpu_usage'),
    ramPercent: stat('ram_percent'),
    cpuTempC: stat('cpu_temp'),
    load1: stat('load_1'),
    containers: [...byContainer.entries()]
      .map(([name, e]) => ({
        name,
        avgCpuPercent: Math.round((e.cpuTotal / e.samples) * 10) / 10,
        avgMemPercent: Math.round((e.memTotal / e.samples) * 10) / 10
      }))
      .sort((a, b) => b.avgCpuPercent - a.avgCpuPercent)
      .slice(0, 20)
  };
}

const TOOLS = {
  list_recording_sessions: {
    description:
      'List Sentinel\'s own recorded monitoring sessions (id, name, when it ran, how many samples, ' +
      'average CPU/RAM). Use this to find a session before summarising it.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    handler: async () => recordingDb.getSessions().slice(0, MAX_ROWS).map(s => ({
      id: s.id,
      name: s.name,
      startedAt: s.start_time ? new Date(s.start_time).toISOString() : null,
      endedAt: s.end_time ? new Date(s.end_time).toISOString() : null,
      sampleCount: s.sample_count,
      avgCpuPercent: s.avg_cpu,
      avgRamPercent: s.avg_ram,
      peakTempC: s.peak_temp
    }))
  },

  get_recording_session: {
    description:
      'Summarise one recording session: duration, CPU/RAM/temperature min-average-max across all ' +
      'its samples, and the busiest containers during it. Accepts the numeric session id, or a ' +
      'name (or part of one) as shown in the Recordings page.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'number', description: 'Numeric session id' },
        name: { type: 'string', description: 'Session name, or a distinctive part of it' }
      },
      additionalProperties: false
    },
    handler: async ({ id, name }) => {
      let session = id ? recordingDb.getSession(id) : null;

      if (!session && name) {
        // The operator refers to a session the way the UI labels it,
        // which is a name/timestamp, not the row id.
        const needle = String(name).toLowerCase();
        const all = recordingDb.getSessions();
        session = all.find(s => (s.name || '').toLowerCase() === needle)
          || all.find(s => (s.name || '').toLowerCase().includes(needle));
      }

      if (!session) {
        const available = recordingDb.getSessions().slice(0, 10).map(s => `#${s.id} "${s.name}"`);
        throw new Error(
          `No recording session matched. Available: ${available.join(', ') || '(none recorded yet)'}`
        );
      }
      return summariseSession(session);
    }
  },

  list_incidents: {
    description:
      'List Sentinel\'s own incident history — status, severity, what triggered each one, and the ' +
      'diagnosed root cause where one exists. Optionally filter by status.',
    parameters: {
      type: 'object',
      properties: {
        status: { type: 'string', description: 'e.g. RESOLVED, FAILED, AWAITING_APPROVAL' },
        limit: { type: 'number', description: `Max rows (default 20, cap ${MAX_ROWS})` }
      },
      additionalProperties: false
    },
    handler: async ({ status, limit }) => {
      const rows = store.listIncidents({ status: status || undefined })
        .slice(0, Math.min(limit || 20, MAX_ROWS));
      return rows.map(i => {
        const resource = getResource(i.resource_id);
        return {
          id: i.id,
          status: i.status,
          severity: i.severity,
          resource: resource ? `${resource.type}:${resource.external_id}` : null,
          trigger: i.trigger_rule,
          summary: i.trigger_summary,
          rootCause: i.root_cause,
          detectedAt: i.created_at ? new Date(i.created_at).toISOString() : null
        };
      });
    }
  },

  get_incident_detail: {
    description:
      'Everything Sentinel knows about one incident: its diagnosis, the evidence gathered, and ' +
      'every action proposed or taken, with outcomes.',
    parameters: {
      type: 'object',
      properties: { id: { type: 'number', description: 'Incident id' } },
      required: ['id'],
      additionalProperties: false
    },
    handler: async ({ id }) => {
      const incident = store.getIncident(id);
      if (!incident) throw new Error(`No incident #${id}`);
      const resource = getResource(incident.resource_id);
      return {
        id: incident.id,
        status: incident.status,
        severity: incident.severity,
        resource: resource ? `${resource.type}:${resource.external_id}` : null,
        trigger: incident.trigger_rule,
        summary: incident.trigger_summary,
        rootCause: incident.root_cause,
        evidence: store.getEvidence(id).slice(0, 20).map(e => ({
          tool: e.source_tool, summary: e.summary
        })),
        actions: store.getActions(id).map(a => ({
          tool: a.tool, status: a.status, risk: a.real_risk, rationale: a.rationale
        }))
      };
    }
  },

  search_activity: {
    description:
      'Search Sentinel\'s recent activity timeline (logins, deployments, container and service ' +
      'state changes, incident transitions) for entries matching some text.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Text to match against event messages' }
      },
      additionalProperties: false
    },
    handler: async ({ query }) => {
      const events = getEvents();
      const needle = String(query || '').toLowerCase();
      return events
        .filter(e => !needle || e.message.toLowerCase().includes(needle) || e.type.toLowerCase().includes(needle))
        .slice(0, MAX_ROWS)
        .map(e => ({ at: new Date(e.timestamp).toISOString(), type: e.type, message: e.message }));
    }
  }
};

/**
 * The local tools available right now, in the same catalog shape the
 * agent's /tools returns — so ai/chat.js can merge them into one list
 * and treat them identically. `risk` is READ_ONLY on every one, which
 * keeps chat.js's existing "refuse anything not READ_ONLY" gate as the
 * single rule for both sources.
 */
function listLocalTools() {
  if (!getAccessScope().ownData) return [];
  return Object.entries(TOOLS).map(([name, def]) => ({
    name,
    description: def.description,
    parameters: def.parameters,
    risk: 'READ_ONLY',
    local: true
  }));
}

function isLocalTool(name) {
  return Object.prototype.hasOwnProperty.call(TOOLS, name) && getAccessScope().ownData;
}

async function callLocalTool(name, params) {
  if (!isLocalTool(name)) throw new Error(`Unknown local tool "${name}"`);
  return TOOLS[name].handler(params || {});
}

module.exports = { listLocalTools, isLocalTool, callLocalTool, TOOLS };

'use strict';

const { getResource } = require('../graph/resources');
const { getNeighbours } = require('../graph/relationships');
const { callToolAudited } = require('../incidents/toolCallAudit');
const { redact } = require('../ai/redact');
const { buildDeployCorrelationEvidence } = require('./deployCorrelation');
const { getDetectorConfig } = require('../settings/detectorConfig');

const LOG_TAIL = 50;
const MAX_EVIDENCE_ROWS = 12;
const MAX_NEIGHBOURS = 2;

/** Per-resource-type tool set: [tool, params(resource), summarize(result)]. */
function toolsForType(type, resource) {
  if (type === 'container') {
    return [
      ['get_container_status', { id: resource.external_id }, (r) => `Container ${r.name || resource.name}: state=${JSON.stringify(r.state)} restarts=${r.restartCount}`],
      ['get_container_logs', { id: resource.external_id, tail: LOG_TAIL }, (r) => (r || []).map(l => `[${l.stream}] ${l.text}`).join('\n')]
    ];
  }
  if (type === 'service') {
    return [
      ['get_service_status', { service: resource.external_id }, (r) => `Service ${r.service}: ${r.status}`],
      ['get_service_logs', { service: resource.external_id, lines: LOG_TAIL }, (r) => (r || []).join('\n')]
    ];
  }
  if (type === 'website') {
    return [
      ['get_website_health', {}, (r) => JSON.stringify((r || []).find(s => s.domain === resource.external_id) || r)]
    ];
  }
  return [];
}

/**
 * Collect bounded, tool-sourced evidence for an incident: the incident's
 * own resource, up to MAX_NEIGHBOURS graph neighbours (so a dependency
 * like demo-db shows up as evidence for demo-api's incident), and always
 * the repo-wide git status so a recent deploy can be ruled in or out.
 * Every result is persisted as one incident_evidence row via the caller.
 */
async function gatherEvidence(incident) {
  const resource = getResource(incident.resource_id);
  const rows = [];

  // Computed FIRST and exempt from MAX_EVIDENCE_ROWS below (it's seeded
  // into `rows` before anything else can fill the cap) — a deploy
  // correlation is the highest-value single piece of evidence this whole
  // feature exists to surface, and must never be the row silently
  // dropped because 12 slots were already used by routine container
  // status/log evidence. Pure DB read, no agent call, so it costs
  // nothing to compute even when nothing is found.
  const deployEvidence = buildDeployCorrelationEvidence(
    resource, incident, getDetectorConfig().deployCorrelationWindowMs
  );
  if (deployEvidence) rows.push(deployEvidence);

  const collect = async (targetResource) => {
    if (!targetResource) return;
    for (const [tool, params, summarize] of toolsForType(targetResource.type, targetResource)) {
      if (rows.length >= MAX_EVIDENCE_ROWS) return;
      try {
        const result = await callToolAudited(incident.id, tool, params, { requestedBy: 'context' });
        rows.push({
          resourceId: targetResource.id,
          sourceTool: tool,
          summary: redact(String(summarize(result) || '')),
          data: result
        });
      } catch (err) {
        rows.push({ resourceId: targetResource.id, sourceTool: tool, summary: `${tool} failed: ${err.message}`, data: null });
      }
    }
  };

  await collect(resource);

  const neighbours = resource ? getNeighbours(resource.id).slice(0, MAX_NEIGHBOURS) : [];
  for (const neighbour of neighbours) {
    if (rows.length >= MAX_EVIDENCE_ROWS) break;
    await collect(neighbour);
  }

  if (rows.length < MAX_EVIDENCE_ROWS) {
    try {
      const gitStatus = await callToolAudited(incident.id, 'inspect_git_status', {}, { requestedBy: 'context' });
      const summary = Array.isArray(gitStatus) && gitStatus.length
        ? gitStatus.map(r => `${r.name}: ${r.clean ? 'clean' : 'dirty'}, last commit ${r.commit?.hash || '?'} "${r.commit?.message || ''}"`).join('; ')
        : 'No git-managed repositories discovered';
      rows.push({ resourceId: null, sourceTool: 'inspect_git_status', summary: redact(summary), data: gitStatus });
    } catch (err) {
      rows.push({ resourceId: null, sourceTool: 'inspect_git_status', summary: `inspect_git_status failed: ${err.message}`, data: null });
    }
  }

  return rows;
}

module.exports = { gatherEvidence, MAX_EVIDENCE_ROWS };

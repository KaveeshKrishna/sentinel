'use strict';

const { getDb } = require('../db/connection');

let stmts = null;

/** Prepare frequently-used statements once, lazily (after migrations have run). */
function getStmts() {
  if (stmts) return stmts;
  const db = getDb();

  stmts = {
    insertSample: db.prepare(`
      INSERT INTO samples (
        session_id, timestamp, cpu_usage, load_1, load_5, load_15,
        cpu_temp, ram_used, ram_total, ram_percent, swap_used, swap_total,
        disk_used, disk_total, disk_read_speed, disk_write_speed,
        net_up_speed, net_down_speed, net_bytes_sent, net_bytes_recv
      ) VALUES (
        @session_id, @timestamp, @cpu_usage, @load_1, @load_5, @load_15,
        @cpu_temp, @ram_used, @ram_total, @ram_percent, @swap_used, @swap_total,
        @disk_used, @disk_total, @disk_read_speed, @disk_write_speed,
        @net_up_speed, @net_down_speed, @net_bytes_sent, @net_bytes_recv
      )
    `),
    insertContainer: db.prepare(`
      INSERT INTO container_samples (sample_id, container_name, cpu_percent, ram_usage, restart_count, health_status)
      VALUES (@sample_id, @container_name, @cpu_percent, @ram_usage, @restart_count, @health_status)
    `),
    insertService: db.prepare(`
      INSERT INTO service_samples (sample_id, service_name, status)
      VALUES (@sample_id, @service_name, @status)
    `),
    bumpCount: db.prepare('UPDATE sessions SET sample_count = sample_count + 1 WHERE id = ?')
  };
  return stmts;
}

// ── Sessions ──────────────────────────────────────────────────────────────────

function createSession(name) {
  return getDb().prepare('INSERT INTO sessions (name, start_time) VALUES (?, ?)').run(name, Date.now()).lastInsertRowid;
}

function endSession(sessionId, sampleCount) {
  getDb().prepare('UPDATE sessions SET end_time = ?, sample_count = ? WHERE id = ?').run(Date.now(), sampleCount, sessionId);
}

function getSessions() {
  return getDb().prepare(`
    SELECT s.*,
      ROUND(AVG(sa.cpu_usage), 1)   AS avg_cpu,
      ROUND(MAX(sa.cpu_temp), 1)    AS peak_temp,
      ROUND(AVG(sa.ram_percent), 1) AS avg_ram,
      ROUND(MAX(sa.load_1), 2)      AS max_load,
      ROUND(AVG(sa.cpu_temp), 1)    AS avg_temp
    FROM sessions s
    LEFT JOIN samples sa ON sa.session_id = s.id
    GROUP BY s.id
    ORDER BY s.start_time DESC
  `).all();
}

function getSession(id) {
  return getDb().prepare('SELECT * FROM sessions WHERE id = ?').get(id);
}

function deleteSession(id) {
  getDb().prepare('DELETE FROM sessions WHERE id = ?').run(id);
}

// ── Samples ───────────────────────────────────────────────────────────────────

function getSamples(sessionId) {
  return getDb().prepare('SELECT * FROM samples WHERE session_id = ? ORDER BY timestamp').all(sessionId);
}

function getContainerSamples(sessionId) {
  return getDb().prepare(`
    SELECT cs.* FROM container_samples cs
    JOIN samples s ON s.id = cs.sample_id
    WHERE s.session_id = ?
    ORDER BY s.timestamp, cs.container_name
  `).all(sessionId);
}

/**
 * Write one complete snapshot inside a transaction for atomicity.
 */
function saveSample(sessionId, metrics, containers, services) {
  const db = getDb();
  const { insertSample, insertContainer, insertService, bumpCount } = getStmts();

  const insertAll = db.transaction(() => {
    const sampleId = insertSample.run({
      session_id:      sessionId,
      timestamp:       Date.now(),
      cpu_usage:       metrics.cpu?.usage ?? 0,
      load_1:          metrics.cpu?.load?.['1'] ?? 0,
      load_5:          metrics.cpu?.load?.['5'] ?? 0,
      load_15:         metrics.cpu?.load?.['15'] ?? 0,
      cpu_temp:        metrics.temperature?.current ?? null,
      ram_used:        metrics.memory?.used ?? 0,
      ram_total:       metrics.memory?.total ?? 0,
      ram_percent:     metrics.memory?.usedPercent ?? 0,
      swap_used:       metrics.memory?.swapUsed ?? 0,
      swap_total:      metrics.memory?.swapTotal ?? 0,
      disk_used:       metrics.disk?.usage?.used ?? 0,
      disk_total:      metrics.disk?.usage?.total ?? 0,
      disk_read_speed: metrics.disk?.io?.readSpeed ?? 0,
      disk_write_speed:metrics.disk?.io?.writeSpeed ?? 0,
      net_up_speed:    metrics.network?.txSpeed ?? 0,
      net_down_speed:  metrics.network?.rxSpeed ?? 0,
      net_bytes_sent:  metrics.network?.txTotal ?? 0,
      net_bytes_recv:  metrics.network?.rxTotal ?? 0
    }).lastInsertRowid;

    for (const c of (containers || [])) {
      insertContainer.run({
        sample_id:      sampleId,
        container_name: c.name,
        cpu_percent:    c.cpuPercent ?? 0,
        ram_usage:      c.memUsage ?? 0,
        restart_count:  c.restartCount ?? 0,
        health_status:  c.health ?? 'N/A'
      });
    }

    for (const [name, status] of Object.entries(services || {})) {
      insertService.run({ sample_id: sampleId, service_name: name, status });
    }

    bumpCount.run(sessionId);
  });

  insertAll();
}

module.exports = { createSession, endSession, getSessions, getSession, deleteSession, getSamples, getContainerSamples, saveSample };

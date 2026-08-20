'use strict';

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '../../data/sentinel.db');

let db = null;
let stmts = {};

function initDb() {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  db = new Database(DB_PATH);

  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT NOT NULL,
      start_time  INTEGER NOT NULL,
      end_time    INTEGER,
      sample_count INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS samples (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id      INTEGER NOT NULL,
      timestamp       INTEGER NOT NULL,
      cpu_usage       REAL,
      load_1          REAL,
      load_5          REAL,
      load_15         REAL,
      cpu_temp        REAL,
      ram_used        INTEGER,
      ram_total       INTEGER,
      ram_percent     REAL,
      swap_used       INTEGER,
      swap_total      INTEGER,
      disk_used       INTEGER,
      disk_total      INTEGER,
      disk_read_speed REAL,
      disk_write_speed REAL,
      net_up_speed    REAL,
      net_down_speed  REAL,
      net_bytes_sent  INTEGER,
      net_bytes_recv  INTEGER,
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS container_samples (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      sample_id       INTEGER NOT NULL,
      container_name  TEXT NOT NULL,
      cpu_percent     REAL,
      ram_usage       INTEGER,
      restart_count   INTEGER,
      health_status   TEXT,
      FOREIGN KEY (sample_id) REFERENCES samples(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS service_samples (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      sample_id     INTEGER NOT NULL,
      service_name  TEXT NOT NULL,
      status        TEXT,
      FOREIGN KEY (sample_id) REFERENCES samples(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_samples_session    ON samples(session_id);
    CREATE INDEX IF NOT EXISTS idx_cs_sample          ON container_samples(sample_id);
    CREATE INDEX IF NOT EXISTS idx_ss_sample          ON service_samples(sample_id);
  `);

  // Prepare frequently-used statements once
  stmts.insertSample = db.prepare(`
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
  `);

  stmts.insertContainer = db.prepare(`
    INSERT INTO container_samples (sample_id, container_name, cpu_percent, ram_usage, restart_count, health_status)
    VALUES (@sample_id, @container_name, @cpu_percent, @ram_usage, @restart_count, @health_status)
  `);

  stmts.insertService = db.prepare(`
    INSERT INTO service_samples (sample_id, service_name, status)
    VALUES (@sample_id, @service_name, @status)
  `);

  stmts.bumpCount = db.prepare(`UPDATE sessions SET sample_count = sample_count + 1 WHERE id = ?`);

  console.log('[db] SQLite initialized:', DB_PATH);
  return db;
}

// ── Sessions ──────────────────────────────────────────────────────────────────

function createSession(name) {
  return db.prepare('INSERT INTO sessions (name, start_time) VALUES (?, ?)').run(name, Date.now()).lastInsertRowid;
}

function endSession(sessionId, sampleCount) {
  db.prepare('UPDATE sessions SET end_time = ?, sample_count = ? WHERE id = ?').run(Date.now(), sampleCount, sessionId);
}

function getSessions() {
  return db.prepare(`
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
  return db.prepare('SELECT * FROM sessions WHERE id = ?').get(id);
}

function deleteSession(id) {
  db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
}

// ── Samples ───────────────────────────────────────────────────────────────────

function getSamples(sessionId) {
  return db.prepare('SELECT * FROM samples WHERE session_id = ? ORDER BY timestamp').all(sessionId);
}

function getContainerSamples(sessionId) {
  return db.prepare(`
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
  const insertAll = db.transaction(() => {
    const sampleId = stmts.insertSample.run({
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
      stmts.insertContainer.run({
        sample_id:      sampleId,
        container_name: c.name,
        cpu_percent:    c.cpuPercent ?? 0,
        ram_usage:      c.memUsage ?? 0,
        restart_count:  c.restartCount ?? 0,
        health_status:  c.health ?? 'N/A'
      });
    }

    for (const [name, status] of Object.entries(services || {})) {
      stmts.insertService.run({ sample_id: sampleId, service_name: name, status });
    }

    stmts.bumpCount.run(sessionId);
  });

  insertAll();
}

module.exports = { initDb, createSession, endSession, getSessions, getSession, deleteSession, getSamples, getContainerSamples, saveSample };

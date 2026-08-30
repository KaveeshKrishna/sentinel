-- Baseline schema: the recording (session/sample) tables that predate the
-- migration runner. Written IF NOT EXISTS so this is a safe no-op against
-- a database that already has them from the pre-migration-runner code path
-- (older server.js called CREATE TABLE IF NOT EXISTS directly at boot).

CREATE TABLE IF NOT EXISTS sessions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL,
  start_time    INTEGER NOT NULL,
  end_time      INTEGER,
  sample_count  INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS samples (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id        INTEGER NOT NULL,
  timestamp         INTEGER NOT NULL,
  cpu_usage         REAL,
  load_1            REAL,
  load_5            REAL,
  load_15           REAL,
  cpu_temp          REAL,
  ram_used          INTEGER,
  ram_total         INTEGER,
  ram_percent       REAL,
  swap_used         INTEGER,
  swap_total        INTEGER,
  disk_used         INTEGER,
  disk_total        INTEGER,
  disk_read_speed   REAL,
  disk_write_speed  REAL,
  net_up_speed      REAL,
  net_down_speed    REAL,
  net_bytes_sent    INTEGER,
  net_bytes_recv    INTEGER,
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

CREATE INDEX IF NOT EXISTS idx_samples_session ON samples(session_id);
CREATE INDEX IF NOT EXISTS idx_cs_sample        ON container_samples(sample_id);
CREATE INDEX IF NOT EXISTS idx_ss_sample        ON service_samples(sample_id);

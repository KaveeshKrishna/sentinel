-- Minimal dependency graph: nodes Sentinel has observed (containers,
-- services, websites) and edges between them. Deliberately not an
-- auto-discovered general graph — see ARCHITECTURE.md roadmap ("Knowledge
-- graph beyond container->service->website edges" is P1). Rows are
-- upserted opportunistically as the context engine or detector touches
-- a resource; edges are registered explicitly via POST
-- /api/resources/relationships.

CREATE TABLE IF NOT EXISTS resources (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  type          TEXT NOT NULL,          -- 'container' | 'service' | 'website'
  external_id   TEXT NOT NULL,          -- container name/id, service name, or site domain
  name          TEXT NOT NULL,
  metadata_json TEXT,
  first_seen_at INTEGER NOT NULL,
  last_seen_at  INTEGER NOT NULL,
  UNIQUE(type, external_id)
);

CREATE TABLE IF NOT EXISTS resource_relationships (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  from_resource_id  INTEGER NOT NULL,
  to_resource_id    INTEGER NOT NULL,
  relationship      TEXT NOT NULL,      -- e.g. 'depends_on'
  created_at        INTEGER NOT NULL,
  FOREIGN KEY (from_resource_id) REFERENCES resources(id) ON DELETE CASCADE,
  FOREIGN KEY (to_resource_id)   REFERENCES resources(id) ON DELETE CASCADE,
  UNIQUE(from_resource_id, to_resource_id, relationship)
);

CREATE INDEX IF NOT EXISTS idx_relationships_from ON resource_relationships(from_resource_id);
CREATE INDEX IF NOT EXISTS idx_relationships_to   ON resource_relationships(to_resource_id);

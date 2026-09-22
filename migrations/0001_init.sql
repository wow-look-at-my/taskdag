-- TaskDAG schema. One working graph per capability-URL token.
--
-- `owner_id` IS the path token from `/:token/mcp`. There is no users table
-- and no projects table: the token partitions everything, and every query
-- in src/db.ts binds it.

-- No `PRAGMA foreign_keys = ON` here: D1 enforces foreign keys by default,
-- and remote D1 rejects most PRAGMA statements — one in a migration file
-- fails the whole migration for no gain. Local test runs set it themselves
-- (see test/fake-d1.ts), where sqlite defaults to OFF.

CREATE TABLE IF NOT EXISTS graphs (
  owner_id   TEXT PRIMARY KEY,
  title      TEXT NOT NULL DEFAULT 'Working graph',
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  id         TEXT PRIMARY KEY,
  owner_id   TEXT NOT NULL REFERENCES graphs(owner_id) ON DELETE CASCADE,
  key        TEXT NOT NULL,
  title      TEXT NOT NULL,
  detail     TEXT NOT NULL DEFAULT '',
  status     TEXT NOT NULL DEFAULT 'todo'
             CHECK (status IN ('todo','in_progress','done','blocked','cancelled')),
  priority   INTEGER NOT NULL DEFAULT 0,
  tags       TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (owner_id, key)
);

CREATE INDEX IF NOT EXISTS tasks_owner_idx ON tasks(owner_id);

-- `from_id` depends on `to_id`: `to_id` must be done before `from_id` is
-- ready. Both sides cascade, so deleting a task takes its edges with it.
CREATE TABLE IF NOT EXISTS edges (
  owner_id TEXT NOT NULL REFERENCES graphs(owner_id) ON DELETE CASCADE,
  from_id  TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  to_id    TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  PRIMARY KEY (from_id, to_id)
);

CREATE INDEX IF NOT EXISTS edges_owner_idx ON edges(owner_id);

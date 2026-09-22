-- Server-minted graph handles: the 2026-07-28 replacement for sessions.
--
-- WHAT CHANGED. 0001 gave each capability-URL token exactly one graph, keyed
-- by the token itself. That made the connection's identity the working set's
-- identity, which is the thing protocol revision 2026-07-28 removed when it
-- deleted `Mcp-Session-Id`: "Servers that need cross-call state use explicit,
-- server-minted handles passed as ordinary tool arguments". So the working
-- set now has an id of its own, minted here, passed back by the model on
-- each call, and still readable only by the token that owns it.
--
-- ADDITIVE ON PURPOSE. This does not rebuild 0001's tables, it supersedes
-- them: new tables beside the old, one backfill, and the old rows left
-- untouched. That is what lets src/schema.ts keep applying the whole
-- migrations directory on first use without a ledger -- every statement
-- below is a no-op the second time it runs. Dropping `graphs`, `tasks` and
-- `edges` is a later migration's job, once this one has been live long
-- enough to trust.

CREATE TABLE IF NOT EXISTS graph_handles (
  id         TEXT PRIMARY KEY,
  owner_id   TEXT NOT NULL,
  title      TEXT NOT NULL DEFAULT 'Working graph',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Every read starts "this owner's graphs, newest first": the handle alone is
-- never enough to reach a row, the owner is always bound alongside it.
CREATE INDEX IF NOT EXISTS graph_handles_owner_idx ON graph_handles(owner_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS graph_tasks (
  id         TEXT PRIMARY KEY,
  graph_id   TEXT NOT NULL REFERENCES graph_handles(id) ON DELETE CASCADE,
  key        TEXT NOT NULL,
  title      TEXT NOT NULL,
  detail     TEXT NOT NULL DEFAULT '',
  status     TEXT NOT NULL DEFAULT 'todo'
             CHECK (status IN ('todo','in_progress','done','blocked','cancelled')),
  priority   INTEGER NOT NULL DEFAULT 0,
  tags       TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (graph_id, key)
);

CREATE INDEX IF NOT EXISTS graph_tasks_graph_idx ON graph_tasks(graph_id);

CREATE TABLE IF NOT EXISTS graph_edges (
  graph_id TEXT NOT NULL REFERENCES graph_handles(id) ON DELETE CASCADE,
  from_id  TEXT NOT NULL REFERENCES graph_tasks(id) ON DELETE CASCADE,
  to_id    TEXT NOT NULL REFERENCES graph_tasks(id) ON DELETE CASCADE,
  PRIMARY KEY (from_id, to_id)
);

CREATE INDEX IF NOT EXISTS graph_edges_graph_idx ON graph_edges(graph_id);

-- A render that did not fit its character budget, remembered just long
-- enough to be overridden once.
--
-- WHY IT IS A TABLE AND NOT A FLAG. `mermaid` caps its output so a 200-node
-- graph cannot land whole in a conversation by accident. The escape hatch is
-- deliberately not "pass a bigger number": the model has to have hit the cap
-- first, and the proof of that is this row, minted by the call that
-- overflowed and spent by the call that overrides it. A model that simply
-- asks for 100k characters up front gets the cap.
CREATE TABLE IF NOT EXISTS render_overflow (
  token      TEXT PRIMARY KEY,
  graph_id   TEXT NOT NULL REFERENCES graph_handles(id) ON DELETE CASCADE,
  chars      INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS render_overflow_graph_idx ON render_overflow(graph_id);

-- Backfill. A token that had a graph under 0001 keeps it, under a handle
-- minted here, so an existing connector URL answers exactly as it did.
-- `randomblob(16)` because a migration cannot call crypto.randomUUID; the
-- handle is an identifier inside an owner's partition, never a credential.
INSERT INTO graph_handles (id, owner_id, title, created_at, updated_at)
SELECT 'g_' || lower(hex(randomblob(8))), g.owner_id, g.title, g.updated_at, g.updated_at
  FROM graphs g
 WHERE NOT EXISTS (SELECT 1 FROM graph_handles h WHERE h.owner_id = g.owner_id);

-- The legacy graph is the owner's oldest handle, which is deterministic
-- whichever order a re-run sees the rows in. Task ids carry over unchanged,
-- so the guard is a plain primary-key check.
INSERT INTO graph_tasks (id, graph_id, key, title, detail, status, priority, tags, created_at, updated_at)
SELECT t.id,
       (SELECT h.id FROM graph_handles h WHERE h.owner_id = t.owner_id ORDER BY h.created_at, h.id LIMIT 1),
       t.key, t.title, t.detail, t.status, t.priority, t.tags, t.created_at, t.updated_at
  FROM tasks t
 WHERE EXISTS (SELECT 1 FROM graph_handles h WHERE h.owner_id = t.owner_id)
   AND NOT EXISTS (SELECT 1 FROM graph_tasks gt WHERE gt.id = t.id);

INSERT INTO graph_edges (graph_id, from_id, to_id)
SELECT (SELECT h.id FROM graph_handles h WHERE h.owner_id = e.owner_id ORDER BY h.created_at, h.id LIMIT 1),
       e.from_id, e.to_id
  FROM edges e
 WHERE EXISTS (SELECT 1 FROM graph_tasks gt WHERE gt.id = e.from_id)
   AND EXISTS (SELECT 1 FROM graph_tasks gt WHERE gt.id = e.to_id)
   AND NOT EXISTS (SELECT 1 FROM graph_edges ge WHERE ge.from_id = e.from_id AND ge.to_id = e.to_id);

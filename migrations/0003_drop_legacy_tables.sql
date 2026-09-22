-- Drop 0001's tables, now that every row in them lives under a handle.
--
-- THIS ONE IS BY HAND, AND IT IS NOT IN src/schema.ts's MIGRATIONS LIST.
-- The bootstrap replays its list on every cold start, which is safe only
-- while every statement is idempotent and additive. A DROP is neither
-- reversible nor something to run because a Worker happened to get a
-- request, so this file is for `npm run migrate:remote` and nothing else. A
-- test asserts the bootstrap set contains no DROP, which is what keeps that
-- true when somebody adds 0004.
--
-- BEFORE RUNNING IT. These three tables are still the only copy of the
-- pre-handle rows: 0002 copied them, it did not move them. Check the copy
-- landed, on the database you are about to change --
--
--   npx wrangler d1 execute taskdag-db --remote --command \
--     "SELECT (SELECT COUNT(*) FROM tasks) AS legacy, (SELECT COUNT(*) FROM graph_tasks) AS migrated;"
--
-- -- and expect `migrated` to be at least `legacy`. It is larger once new
-- graphs exist, which is fine; smaller means stop.

DROP TABLE IF EXISTS edges;
DROP TABLE IF EXISTS tasks;
DROP TABLE IF EXISTS graphs;

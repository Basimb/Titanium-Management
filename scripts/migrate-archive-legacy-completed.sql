-- ============================================================================
--  ONE-TIME DATA FIX -- archive tasks completed before auto-archive-on-approve
--  scripts/migrate-archive-legacy-completed.sql
-- ============================================================================
--
--  WHAT THIS DOES, IN PLAIN TERMS
--  ------------------------------
--  Until commit 8c0ba838 ("Fix bare اعتمد classification, auto-archive tasks
--  on approval", 2026-09-10), approving a task set status='completed' but
--  never touched archived_at -- archiving a task the moment Basim approves it
--  was only added in that commit. Every task that was approved BEFORE that
--  change reached the server is stuck exactly as it was left: status is
--  'completed' forever, archived_at is NULL forever, because nothing in the
--  app ever goes back and archives an already-completed task after the fact
--  (approve is the only code path that writes archived_at, it only runs once,
--  at approval time, and that already happened for these rows in the past).
--
--  This is exactly Basim's report: "مهمة أدابتر كهرباء كمان مكتملة وما
--  تأرشفت أوتوماتيك". It is why such a task keeps showing up in "سجل مهام
--  الفريق" and in the normal dashboard list under "مكتملة" instead of moving
--  to "الأرشيف" the way every NEW approval now does (getManagementSnapshot's
--  own scoping only ever hides a row once archived_at is set).
--
--  This script fixes exactly those rows, once: for every task where
--  status='completed' AND archived_at IS NULL, it sets archived_at to that
--  task's own completed_at (so the recorded archive date matches when it was
--  actually approved, not "now"), and archived_by to 'باسم', since task.approve
--  is Basim-only -- he is the only person who could have completed any of
--  these.
--
--  Nothing else is touched, no rows are deleted, and any task that is still
--  open, in progress, or pending approval is completely unaffected.
--
--  THIS IS NOT DESTRUCTIVE -- it only ever sets two already-empty columns, and
--  only on rows that are already completed and not yet archived. Still, take
--  a backup first as a matter of habit before running anything by hand
--  against the live production database.
--
--  HOW TO RUN IT (by hand, on the server, never automatically)
--  -----------------------------------------------------------
--    # 1. Back up the database (quick, and this is live production data).
--    cp data/titanium.sqlite data/titanium.sqlite.bak-before-archive-legacy
--
--    # 2. See exactly which rows will change (read-only, safe to run anytime).
--    sqlite3 data/titanium.sqlite \
--      "SELECT id, title, owner, completed_at FROM tasks WHERE status='completed' AND archived_at IS NULL;"
--
--    # 3. Run this file.
--    sqlite3 data/titanium.sqlite < scripts/migrate-archive-legacy-completed.sql
--
--  (Default DB path is `data/titanium.sqlite` under the app directory, or
--   `$TITANIUM_DATA_DIR/titanium.sqlite` if that env var is set --
--   see `dataDirectory` in lib/titanium-server.ts.)
--
--  It is safe to run more than once: after the first run there are no
--  remaining status='completed' AND archived_at IS NULL rows left to match,
--  so a second run touches zero rows.
--
--  This is NOT wired into the application's own additive-only per-request
--  migrations (migrateManagementActions, migrateAgentSchema) -- it is a
--  one-time data correction, not a schema change, and is only ever run by
--  hand, exactly like scripts/migrate-drop-projects.sql before it.
-- ============================================================================

BEGIN IMMEDIATE;

UPDATE tasks
   SET archived_at = COALESCE(completed_at, CAST(strftime('%s','now') AS INTEGER) * 1000),
       archived_by = 'باسم'
 WHERE status = 'completed'
   AND archived_at IS NULL;

COMMIT;

-- ---------------------------------------------------------------------------
-- Verification. Should print nothing at all if the fix is complete; any
-- output means some row still needs attention.
-- ---------------------------------------------------------------------------
SELECT 'STILL UNARCHIVED: ' || id || ' -- ' || title FROM tasks
 WHERE status = 'completed' AND archived_at IS NULL;

PRAGMA integrity_check;

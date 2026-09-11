-- ============================================================================
--  ONE-TIME DESTRUCTIVE MIGRATION -- "projects" removal
--  scripts/migrate-drop-projects.sql
-- ============================================================================
--
--  WHAT THIS DOES, IN PLAIN TERMS
--  ------------------------------
--  The product no longer has projects. Tasks are flat, standalone records.
--  This script permanently removes the project side of the database:
--
--    1. Rebuilds the `tasks` table WITHOUT the `project_id` column (keeping
--       every task row and every other task column, byte for byte).
--    2. Drops the `projects` table entirely -- with it goes every project row
--       and the project-only `is_standalone` column that lived on it.
--    3. Drops the now-meaningless project index `idx_tasks_project_status` and
--       creates the replacement `idx_tasks_status` the new code expects.
--    4. Drops the two conversation-memory tables the chat layer used only to
--       remember "which project were we talking about":
--       `secretary_last_project` and `secretary_project_name_pending`.
--    5. Expires any still-pending project approval request (`project_create` /
--       `project_close`), because nothing in the new code can act on one.
--    6. Clears short-lived pending chat confirmations, in case one of them is
--       a stashed project command from just before the deploy.
--
--  Comments, attachments, users, sessions, audit logs, approvals, rules, the
--  outbox and every other table are left untouched. Task rows are NOT deleted:
--  a task that used to sit inside a project simply becomes a standalone task.
--  Historical audit_logs rows about projects are deliberately KEPT as history
--  (the dashboard renders them as plain, unlinked entries). An optional block
--  at the very bottom can delete them if you prefer -- it is commented out.
--
--  THIS IS DESTRUCTIVE AND IRREVERSIBLE. TAKE A BACKUP FIRST.
--
--  HOW TO RUN IT (by hand, on the server, never automatically)
--  -----------------------------------------------------------
--    # 0. Stop the app so nothing writes mid-rebuild.
--    systemctl stop <your-app-service>        # and the whatsapp-bridge service
--
--    # 1. Back up the database AND its WAL sidecar files.
--    cp data/titanium.sqlite      data/titanium.sqlite.bak-before-drop-projects
--    cp data/titanium.sqlite-wal  data/titanium.sqlite-wal.bak 2>/dev/null || true
--    cp data/titanium.sqlite-shm  data/titanium.sqlite-shm.bak 2>/dev/null || true
--
--    # 2. Run this file.
--    sqlite3 data/titanium.sqlite < scripts/migrate-drop-projects.sql
--
--    # 3. Start the app again and confirm the dashboard and bot both work.
--    systemctl start <your-app-service>
--
--  (Default DB path is `data/titanium.sqlite` under the app directory, or
--   `$TITANIUM_DATA_DIR/titanium.sqlite` if that env var is set --
--   see `dataDirectory` in lib/titanium-server.ts.)
--
--  NOTES
--  -----
--  * It is wrapped in a single transaction: if any statement fails, nothing is
--    changed and you can investigate with the database still intact.
--  * It is safe to run twice. A second run is a harmless no-op rebuild of
--    `tasks` (the DROP IF EXISTS / CREATE IF NOT EXISTS statements and the
--    already-projectless column list make the repeat pass do nothing new).
--  * It is NOT wired into the application. The app's own per-request migrations
--    (`migrateManagementActions`, `migrateAgentSchema`) stay additive-only --
--    ADD COLUMN / CREATE IF NOT EXISTS, never a drop. This file is the only
--    place a drop happens, and only because you run it by hand.
--  * Ordering vs. the deploy does not matter: the new code never reads
--    project_id, and the old code is already gone by the time you run this.
-- ============================================================================

-- Foreign keys must be off while `tasks` is swapped out from under the tables
-- that reference it (comments, attachments). This PRAGMA is a no-op inside a
-- transaction, so it has to come first, before BEGIN.
PRAGMA foreign_keys = OFF;

BEGIN IMMEDIATE;

-- ---------------------------------------------------------------------------
-- 1. Rebuild `tasks` without `project_id`.
--    SQLite cannot ALTER TABLE ... DROP COLUMN here, because project_id is
--    covered by a foreign key and by idx_tasks_project_status, so we use the
--    standard "create new table, copy rows, drop old, rename" procedure.
--    The column list below is the new schema exactly as lib/titanium-server.ts
--    creates it for a fresh database, plus the four columns that
--    migrateAgentSchema adds to tasks (watcher, expected_at, blocker,
--    last_update_at).
-- ---------------------------------------------------------------------------

-- Clean up after a previous interrupted run, if there ever was one.
DROP TABLE IF EXISTS tasks_without_projects;

CREATE TABLE tasks_without_projects (
  id               TEXT PRIMARY KEY NOT NULL,
  title            TEXT NOT NULL,
  details          TEXT DEFAULT '' NOT NULL,
  priority         TEXT DEFAULT 'yellow' NOT NULL,
  status           TEXT DEFAULT 'open' NOT NULL,
  owner            TEXT,
  suggested_owner  TEXT,
  started_at       INTEGER,
  due_date         TEXT,
  completed_at     INTEGER,
  rejection_reason TEXT,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER,
  archived_at      INTEGER,
  archived_by      TEXT,
  watcher          TEXT,
  expected_at      TEXT,
  blocker          TEXT,
  last_update_at   INTEGER
);

-- Every task row is carried over. `project_id` is simply not in this list, so
-- it is the one and only piece of task data that is dropped.
INSERT INTO tasks_without_projects (
  id, title, details, priority, status, owner, suggested_owner, started_at,
  due_date, completed_at, rejection_reason, created_at, updated_at,
  archived_at, archived_by, watcher, expected_at, blocker, last_update_at
)
SELECT
  id, title, details, priority, status, owner, suggested_owner, started_at,
  due_date, completed_at, rejection_reason, created_at, updated_at,
  archived_at, archived_by, watcher, expected_at, blocker, last_update_at
FROM tasks;

DROP TABLE tasks;
ALTER TABLE tasks_without_projects RENAME TO tasks;

-- ---------------------------------------------------------------------------
-- 2. Indexes: the project-scoped one is gone, the flat one replaces it.
--    (Dropping `tasks` above already removed its indexes; these statements
--    recreate exactly what lib/titanium-server.ts declares today.)
-- ---------------------------------------------------------------------------
DROP INDEX IF EXISTS idx_tasks_project_status;
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_owner  ON tasks(owner);

-- ---------------------------------------------------------------------------
-- 3. The projects table itself, and with it the project-only `is_standalone`
--    column (it only ever existed on `projects`, never on `tasks`).
--    THIS PERMANENTLY DELETES ALL PROJECT ROWS.
-- ---------------------------------------------------------------------------
DROP TABLE IF EXISTS projects;

-- ---------------------------------------------------------------------------
-- 4. Chat-layer project memory: both tables existed only to remember a
--    project between WhatsApp messages. Nothing reads them anymore.
-- ---------------------------------------------------------------------------
DROP TABLE IF EXISTS secretary_last_project;
DROP TABLE IF EXISTS secretary_project_name_pending;

-- ---------------------------------------------------------------------------
-- 5. Pending project approval requests can never be decided now -- the new
--    code has no project_create / project_close handler. Mark them expired so
--    they stop appearing in Basim's pending list. The rows stay as history.
-- ---------------------------------------------------------------------------
UPDATE approvals
   SET status = 'expired'
 WHERE status = 'pending'
   AND (type IN ('project_create', 'project_close') OR entity_type = 'project');

-- ---------------------------------------------------------------------------
-- 6. Short-lived pending chat state. If a confirmation was stashed in the last
--    few minutes before the deploy it may hold a now-unknown project command;
--    clearing it just means whoever was mid-conversation asks again.
-- ---------------------------------------------------------------------------
DELETE FROM secretary_pending;
DELETE FROM secretary_task_choice;
DELETE FROM secretary_confirmation_views;

COMMIT;

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- Verification. Each of these should print nothing at all if the migration
-- succeeded; any output means STOP and restore the backup.
-- ---------------------------------------------------------------------------
-- Any comment/attachment pointing at a task that no longer exists:
PRAGMA foreign_key_check;
-- Any surviving project column anywhere in `tasks`:
SELECT 'STILL HAS A PROJECT COLUMN: ' || name FROM pragma_table_info('tasks')
 WHERE name LIKE '%project%' OR name = 'is_standalone';
-- Any surviving project-shaped table:
SELECT 'STILL HAS TABLE: ' || name FROM sqlite_master
 WHERE type = 'table' AND name LIKE '%project%';

-- General integrity + reclaim the space the dropped table used.
PRAGMA integrity_check;
VACUUM;

-- ---------------------------------------------------------------------------
-- OPTIONAL, NOT RUN BY DEFAULT.
-- Old project entries in the activity log are kept above, on purpose: they are
-- a true record of what happened, and the dashboard shows them as plain text
-- without a link. Uncomment only if you also want that history erased.
-- ---------------------------------------------------------------------------
-- DELETE FROM audit_logs WHERE entity_type = 'project';
-- DELETE FROM audit_logs WHERE action LIKE '%_project';

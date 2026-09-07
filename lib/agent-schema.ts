import type { DatabaseSync } from "node:sqlite";

/**
 * Schema additions for the WhatsApp agent. Idempotent: safe to call on every
 * request the same way migrateManagementActions is. Only ADD COLUMN and
 * CREATE IF NOT EXISTS — never drops or rewrites existing data.
 */
export function migrateAgentSchema(sqlite: DatabaseSync): void {
  const addColumns = (table: string, columns: Array<[string, string]>) => {
    const existing = new Set(sqlite.prepare(`PRAGMA table_info(${table})`).all().map(row => String(row.name)));
    if (!existing.has("id")) return;
    for (const [column, type] of columns) if (!existing.has(column)) sqlite.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  };
  const nested = sqlite.isTransaction;
  sqlite.exec(nested ? "SAVEPOINT agent_schema" : "BEGIN IMMEDIATE");
  try {
    addColumns("users", [["phone", "TEXT"], ["department", "TEXT"]]);
    addColumns("tasks", [["watcher", "TEXT"], ["expected_at", "TEXT"], ["blocker", "TEXT"], ["last_update_at", "INTEGER"]]);
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS approvals (
        id TEXT PRIMARY KEY NOT NULL,
        type TEXT NOT NULL,                -- deadline_extension | task_close | project_create | rule | policy
        status TEXT DEFAULT 'pending' NOT NULL, -- pending | approved | rejected | expired
        requested_by TEXT NOT NULL,        -- user id
        requested_by_name TEXT NOT NULL,
        entity_type TEXT NOT NULL,         -- task | project | rule
        entity_id TEXT,
        summary TEXT NOT NULL,             -- one-line Arabic description shown to the approver
        payload TEXT DEFAULT '{}' NOT NULL,-- JSON: old/new values, reason, draft
        decided_by TEXT,
        decision_note TEXT,
        created_at INTEGER NOT NULL,
        decided_at INTEGER,
        last_nudged_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_approvals_status ON approvals(status, created_at);
      CREATE INDEX IF NOT EXISTS idx_approvals_entity ON approvals(entity_type, entity_id);

      CREATE TABLE IF NOT EXISTS rules (
        id TEXT PRIMARY KEY NOT NULL,
        kind TEXT NOT NULL,                -- assignment | policy | note
        statement TEXT NOT NULL,           -- human-readable rule as approved by the owner
        match TEXT DEFAULT '{}' NOT NULL,  -- JSON: keywords/project/category the rule applies to
        effect TEXT DEFAULT '{}' NOT NULL, -- JSON: e.g. {"suggestOwner":"khaled"} or {"requireDueDate":true}
        active INTEGER DEFAULT 1 NOT NULL,
        approved_by TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS corrections (
        id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
        category TEXT NOT NULL,            -- e.g. assignment
        signature TEXT NOT NULL,           -- normalized key used to count repeats
        from_value TEXT,
        to_value TEXT,
        context TEXT DEFAULT '' NOT NULL,
        corrected_by TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        proposed_rule_id TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_corrections_signature ON corrections(category, signature);

      CREATE TABLE IF NOT EXISTS knowledge (
        id TEXT PRIMARY KEY NOT NULL,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        category TEXT DEFAULT 'general' NOT NULL, -- policy | licensing | supplier | template | instruction
        visibility TEXT DEFAULT 'team' NOT NULL,   -- team | owner
        added_by TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_fts USING fts5(title, body, content='knowledge', content_rowid='rowid');
      CREATE TRIGGER IF NOT EXISTS knowledge_ai AFTER INSERT ON knowledge BEGIN
        INSERT INTO knowledge_fts(rowid, title, body) VALUES (new.rowid, new.title, new.body);
      END;
      CREATE TRIGGER IF NOT EXISTS knowledge_ad AFTER DELETE ON knowledge BEGIN
        INSERT INTO knowledge_fts(knowledge_fts, rowid, title, body) VALUES ('delete', old.rowid, old.title, old.body);
      END;
      CREATE TRIGGER IF NOT EXISTS knowledge_au AFTER UPDATE ON knowledge BEGIN
        INSERT INTO knowledge_fts(knowledge_fts, rowid, title, body) VALUES ('delete', old.rowid, old.title, old.body);
        INSERT INTO knowledge_fts(rowid, title, body) VALUES (new.rowid, new.title, new.body);
      END;

      CREATE TABLE IF NOT EXISTS agent_outbox (
        id TEXT PRIMARY KEY NOT NULL,
        to_user TEXT NOT NULL,             -- user id or 'group'
        text TEXT NOT NULL,
        state TEXT DEFAULT 'pending' NOT NULL, -- pending | sending | sent | failed
        created_at INTEGER NOT NULL,
        sent_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_agent_outbox_state ON agent_outbox(state, created_at);

      CREATE TABLE IF NOT EXISTS agent_followups (
        id TEXT PRIMARY KEY NOT NULL,
        kind TEXT NOT NULL,                -- overdue_task | stale_approval | daily_digest
        target_user TEXT NOT NULL,         -- user id or 'group'
        entity_id TEXT,
        sent_at INTEGER NOT NULL,
        response TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_followups_target ON agent_followups(target_user, sent_at);
    `);
    sqlite.exec(nested ? "RELEASE agent_schema" : "COMMIT");
  } catch (error) { sqlite.exec(nested ? "ROLLBACK TO agent_schema" : "ROLLBACK"); throw error; }
}

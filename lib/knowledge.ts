import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { migrateManagementActions, resolveManagementActor, type ManagementActor } from "./management-actions.ts";
import { can, isOwner, type PermissionActor } from "./permissions.ts";

export type KnowledgeEntry = { id: string; title: string; body: string; category: string; visibility: "team" | "owner"; addedBy: string; createdAt: number; updatedAt: number };
export type KnowledgeHit = KnowledgeEntry & { snippet: string };
const CATEGORIES = ["general", "policy", "licensing", "supplier", "template", "instruction", "project"];
const SELECT = "SELECT id,title,body,category,visibility,added_by AS addedBy,created_at AS createdAt,updated_at AS updatedAt FROM knowledge";

function scoped(actor: ManagementActor, entry: { visibility: string }) { return entry.visibility === "team" || isOwner(actor as PermissionActor); }

export function addKnowledge(db: DatabaseSync, claimed: ManagementActor, input: { title: string; body: string; category?: string; visibility?: "team" | "owner" }, options: { now?: number } = {}): KnowledgeEntry {
  migrateManagementActions(db);
  const actor = resolveManagementActor(db, claimed);
  if (!can(actor as PermissionActor, "knowledge.write")) throw new Error("knowledge_write_forbidden");
  const title = String(input.title ?? "").trim().slice(0, 200);
  const body = String(input.body ?? "").trim().slice(0, 20_000);
  if (!title || !body) throw new Error("knowledge_invalid");
  const category = CATEGORIES.includes(input.category ?? "") ? input.category! : "general";
  const visibility = input.visibility === "owner" ? "owner" : "team";
  const at = options.now ?? Date.now(); const id = randomUUID();
  db.prepare("INSERT INTO knowledge (id,title,body,category,visibility,added_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)").run(id, title, body, category, visibility, actor.id, at, at);
  db.prepare("INSERT INTO audit_logs (actor_user_id,actor_name,action,entity_type,entity_id,details,created_at) VALUES (?,?,?,?,?,?,?)")
    .run(actor.id, actor.name, "knowledge_add", "knowledge", id, JSON.stringify({ summary: `أضاف معلومة: ${title}`, source: "knowledge", category }), at);
  return db.prepare(`${SELECT} WHERE id=?`).get(id) as unknown as KnowledgeEntry;
}

/** FTS5 first, LIKE fallback for very short/Arabic-normalized queries. Visibility enforced. */
export function searchKnowledge(db: DatabaseSync, claimed: ManagementActor, query: string, limit = 5): KnowledgeHit[] {
  migrateManagementActions(db);
  const actor = resolveManagementActor(db, claimed);
  if (!can(actor as PermissionActor, "knowledge.read")) return [];
  const cleaned = String(query ?? "").replace(/["'*^:()\-]/g, " ").trim();
  if (!cleaned) return [];
  const terms = cleaned.split(/\s+/).filter(term => term.length > 1).slice(0, 8);
  let rows: Record<string, unknown>[] = [];
  if (terms.length) {
    try {
      rows = db.prepare(`SELECT k.id,k.title,k.body,k.category,k.visibility,k.added_by AS addedBy,k.created_at AS createdAt,k.updated_at AS updatedAt,
        snippet(knowledge_fts, 1, '«', '»', '…', 24) AS snippet FROM knowledge_fts JOIN knowledge k ON k.rowid=knowledge_fts.rowid
        WHERE knowledge_fts MATCH ? ORDER BY bm25(knowledge_fts) LIMIT ?`).all(terms.map(term => `"${term}"*`).join(" OR "), limit * 2) as Record<string, unknown>[];
    } catch { rows = []; }
  }
  if (!rows.length) {
    rows = db.prepare(`${SELECT} WHERE title LIKE ? OR body LIKE ? ORDER BY updated_at DESC LIMIT ?`).all(`%${terms[0] ?? cleaned}%`, `%${terms[0] ?? cleaned}%`, limit * 2) as Record<string, unknown>[];
    rows = rows.map(row => ({ ...row, snippet: String(row.body).slice(0, 160) }));
  }
  return rows.filter(row => scoped(actor, row as { visibility: string })).slice(0, limit) as unknown as KnowledgeHit[];
}

export function listKnowledge(db: DatabaseSync, claimed: ManagementActor, category?: string): KnowledgeEntry[] {
  migrateManagementActions(db);
  const actor = resolveManagementActor(db, claimed);
  if (!can(actor as PermissionActor, "knowledge.read")) return [];
  const rows = category ? db.prepare(`${SELECT} WHERE category=? ORDER BY updated_at DESC LIMIT 100`).all(category) : db.prepare(`${SELECT} ORDER BY updated_at DESC LIMIT 100`).all();
  return (rows as Record<string, unknown>[]).filter(row => scoped(actor, row as { visibility: string })) as unknown as KnowledgeEntry[];
}

export function removeKnowledge(db: DatabaseSync, claimed: ManagementActor, id: string): boolean {
  migrateManagementActions(db);
  const actor = resolveManagementActor(db, claimed);
  if (!isOwner(actor as PermissionActor)) return false;
  return Number(db.prepare("DELETE FROM knowledge WHERE id=?").run(id).changes) === 1;
}

export function formatKnowledgeHits(hits: KnowledgeHit[]): string {
  if (!hits.length) return "";
  return hits.map(hit => `📌 ${hit.title}\n${hit.snippet.replace(/\s+/g, " ").trim()}`).join("\n\n");
}

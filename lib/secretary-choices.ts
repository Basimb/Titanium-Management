import { randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export type SecretaryChoices = { id: string; title: string; options: Array<{ id: string; label: string }>; expiresAt: number };
export type SecretaryChoiceField = "projectId" | "ownerId" | "priority" | "dueDate" | "approvalDecision";
type Option = { id: string; label: string; value: string | null };
type Binding = { conversationKey: string; actorId: string; draftVersion: string; catalogHash: string; now: number };
type Row = { question_id: string; actor_id: string; draft_version: string; catalog_hash: string; field: SecretaryChoiceField; title: string; options_json: string; expires_at: number };
export class SecretaryChoiceError extends Error {
  constructor() { super("هذا الخيار غير مرتبط بالسؤال الحالي أو انتهت صلاحيته. اكتب جوابك بالكلام لنكمل على التفاصيل الحالية."); this.name = "SecretaryChoiceError"; }
}
const clean = (value: string, max = 100) => value.replace(/[\u0000-\u001F\u007F\u202A-\u202E\u2066-\u2069]/g, " ").trim().slice(0, max);
export function migrateSecretaryChoices(db: DatabaseSync) {
  db.exec(`CREATE TABLE IF NOT EXISTS secretary_choices (conversation_key TEXT PRIMARY KEY,question_id TEXT NOT NULL UNIQUE,
    actor_id TEXT NOT NULL,draft_version TEXT NOT NULL,catalog_hash TEXT NOT NULL,field TEXT NOT NULL,title TEXT NOT NULL,
    options_json TEXT NOT NULL,expires_at INTEGER NOT NULL)`);
}
export function clearSecretaryChoices(db: DatabaseSync, conversationKey: string) {
  db.prepare("DELETE FROM secretary_choices WHERE conversation_key=?").run(conversationKey);
}
/** Call within the caller's receipt/intake transaction. Values never leave server storage. */
export function createSecretaryChoices(db: DatabaseSync, binding: Binding & {
  field: SecretaryChoiceField; title: string; options: Array<{ label: string; value: string | null }>; expiresAt: number;
}): SecretaryChoices {
  if (!db.isTransaction || binding.actorId !== "basem" || binding.options.length < 1 || binding.options.length > 12
    || binding.expiresAt <= binding.now || binding.expiresAt > binding.now + 30 * 60_000) throw new SecretaryChoiceError();
  const id = "Q" + randomBytes(16).toString("hex");
  const options = binding.options.map((option, index) => ({ id: "O" + randomBytes(16).toString("hex"), label: `${index + 1}. ${clean(option.label, 94)}`, value: option.value }));
  const title = clean(binding.title);
  db.prepare("INSERT INTO secretary_choices VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(conversation_key) DO UPDATE SET question_id=excluded.question_id,actor_id=excluded.actor_id,draft_version=excluded.draft_version,catalog_hash=excluded.catalog_hash,field=excluded.field,title=excluded.title,options_json=excluded.options_json,expires_at=excluded.expires_at")
    .run(binding.conversationKey,id,binding.actorId,binding.draftVersion,binding.catalogHash,binding.field,title,JSON.stringify(options),binding.expiresAt);
  return { id, title, options: options.map(({ id, label }) => ({ id, label })), expiresAt: binding.expiresAt };
}
/** A valid selection is single-use and must be committed atomically with the next draft/result. */
export function consumeSecretaryChoice(db: DatabaseSync, binding: Binding, choice: { questionId: string; optionId: string }) {
  if (!db.isTransaction || binding.actorId !== "basem" || !choice || Object.keys(choice).sort().join(",") !== "optionId,questionId"
    || !/^Q[0-9a-f]{32}$/.test(choice.questionId) || !/^O[0-9a-f]{32}$/.test(choice.optionId)) throw new SecretaryChoiceError();
  const row = db.prepare("SELECT * FROM secretary_choices WHERE conversation_key=?").get(binding.conversationKey) as Row | undefined;
  if (!row || row.question_id !== choice.questionId || row.actor_id !== binding.actorId || row.draft_version !== binding.draftVersion
    || row.catalog_hash !== binding.catalogHash || row.expires_at <= binding.now) throw new SecretaryChoiceError();
  const option = (JSON.parse(row.options_json) as Option[]).find(item => item.id === choice.optionId);
  if (!option || !["projectId", "ownerId", "priority", "dueDate", "approvalDecision"].includes(row.field)) throw new SecretaryChoiceError();
  clearSecretaryChoices(db, binding.conversationKey);
  return { field: row.field, value: option.value, label: option.label };
}
/** Read-only peek so callers can dispatch on which kind of choice (task-draft field vs. approval decision) is currently live before binding/validating it. */
export function peekSecretaryChoiceField(db: DatabaseSync, conversationKey: string): SecretaryChoiceField | undefined {
  const row = db.prepare("SELECT field FROM secretary_choices WHERE conversation_key=?").get(conversationKey) as { field: SecretaryChoiceField } | undefined;
  return row?.field;
}

export function secretaryChoiceOptions(field: SecretaryChoiceField, catalog: {
  projects: Array<{ id: string; name: string }>; users: Array<{ id: string; name: string }>; now: number;
}): Array<{ label: string; value: string | null }> {
  const names = (items: Array<{ id: string; name: string }>) => items.map(item => ({ value: item.id,
    label: items.filter(other => other.name === item.name).length > 1 ? `${clean(item.name, 65)} (${item.id.slice(-12)})` : item.name }));
  if (field === "projectId") {
    // "بدون مشروع" is always offered, alongside the real project list and the
    // free-text escape hatch -- reserve its slot the same way the escape
    // hatch's own slot is reserved, so the 12-option cap is never exceeded.
    const limit = catalog.projects.length > 11 ? 10 : 11;
    return [...names(catalog.projects).slice(0, limit), { label: "بدون مشروع", value: "no_project" },
      ...(catalog.projects.length > limit ? [{ label: "اكتب اسم مشروع آخر", value: null }] : [])];
  }
  if (field === "ownerId") return [...names(catalog.users).slice(0, catalog.users.length > 11 ? 10 : 11),
    { label: "بدون مسؤول حاليًا", value: "unassigned" }, ...(catalog.users.length > 11 ? [{ label: "اكتب اسم موظف آخر", value: null }] : [])];
  if (field === "priority") return [{ label: "🔴 قصوى", value: "red" }, { label: "🟡 متوسطة", value: "yellow" }, { label: "🟢 عادية", value: "green" }];
  const date = (at: number) => {
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Amman", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(at);
    return ["year", "month", "day"].map(type => parts.find(part => part.type === type)!.value).join("-");
  };
  return [{ label: `اليوم (${date(catalog.now)})`, value: date(catalog.now) }, { label: `بكرا (${date(catalog.now + 86_400_000)})`, value: date(catalog.now + 86_400_000) },
    { label: "أكتب تاريخًا آخر", value: null }, { label: "بدون موعد", value: "unscheduled" }];
}

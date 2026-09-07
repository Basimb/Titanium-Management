import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export type SecretaryMemory = { question: string; disputedAnswer: string; guidance: string; recordedAt: number };
const DAY = 86_400_000;
const terms = (text: string) => [...new Set(text.normalize("NFKC").toLowerCase()
  .replace(/[\u064b-\u065f\u0670\u0640]/g, "").replace(/[أإآ]/g, "ا").replace(/ى/g, "ي")
  .match(/[\p{L}\p{N}]{3,}/gu) ?? [])].slice(0, 64);

export function migrateSecretaryMemory(db: DatabaseSync) {
  db.exec(`CREATE TABLE IF NOT EXISTS secretary_learning_memory (
    id TEXT PRIMARY KEY, conversation_key TEXT NOT NULL, actor_role TEXT NOT NULL,
    question TEXT NOT NULL, disputed_answer TEXT NOT NULL, scope_json TEXT NOT NULL,
    created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS secretary_learning_scope ON secretary_learning_memory(conversation_key,actor_role,expires_at);`);
  db.exec(`CREATE TABLE IF NOT EXISTS secretary_personal_memory (
    actor_id TEXT NOT NULL, topic TEXT NOT NULL, body TEXT NOT NULL, updated_at INTEGER NOT NULL,
    PRIMARY KEY(actor_id,topic));`);
}

export function personalMemoryCommand(text: string): { topic: string; body: string | null } | null {
  const save = /^(?:احفظ|تذكر) عني\s*[:：]\s*([^:\n：]{2,60})\s*[:：]\s*([^\n]{1,500})$/u.exec(text.trim());
  if (save) return { topic: save[1].trim(), body: save[2].trim() };
  const forget = /^انس عني\s*[:：]\s*([^:\n：]{2,60})$/u.exec(text.trim());
  return forget ? { topic: forget[1].trim(), body: null } : null;
}
/** Called only after resolving the owner again inside the event transaction. */
export function updatePersonalMemory(db: DatabaseSync, actorId: string, command: {topic: string; body: string | null}, now: number) {
  if (command.body === null) {
    db.prepare("DELETE FROM secretary_personal_memory WHERE actor_id=? AND topic=?").run(actorId, command.topic);
    return;
  }
  db.prepare(`INSERT INTO secretary_personal_memory VALUES(?,?,?,?) ON CONFLICT(actor_id,topic)
    DO UPDATE SET body=excluded.body,updated_at=excluded.updated_at`).run(actorId, command.topic, command.body, now);
}
export function personalMemory(db: DatabaseSync, actorId: string): Array<{topic: string; body: string}> {
  return db.prepare("SELECT topic,body FROM secretary_personal_memory WHERE actor_id=? ORDER BY updated_at DESC,topic LIMIT 20")
    .all(actorId) as Array<{topic: string; body: string}>;
}

/** Criticism is evidence of uncertainty, never proof of a replacement fact or permission. */
export function rememberSecretaryMistake(db: DatabaseSync, input: {
  conversation: string; role: string; question: string; answer: string; scope: string[]; now: number;
}) {
  const question = input.question.slice(0, 2000), answer = input.answer.slice(0, 4000);
  const id = createHash("sha256").update(JSON.stringify([input.conversation, input.role, question, answer])).digest("hex");
  db.prepare(`INSERT INTO secretary_learning_memory VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
    scope_json=excluded.scope_json,created_at=excluded.created_at,expires_at=excluded.expires_at`)
    .run(id, input.conversation, input.role, question, answer, JSON.stringify(input.scope), input.now, input.now + 90 * DAY);
  db.prepare("DELETE FROM secretary_learning_memory WHERE expires_at<=?").run(input.now);
  db.prepare(`DELETE FROM secretary_learning_memory WHERE conversation_key=? AND id NOT IN
    (SELECT id FROM secretary_learning_memory WHERE conversation_key=? ORDER BY created_at DESC,id LIMIT 300)`)
    .run(input.conversation, input.conversation);
}

/** Scope filtering precedes ranking. Historical answers are never current site state. */
export function recallSecretaryMemory(db: DatabaseSync, input: {
  conversation: string; role: string; query: string; allowedScope: Set<string>; now: number;
}): SecretaryMemory[] {
  const query = terms(input.query);
  if (!query.length) return [];
  const rows = db.prepare(`SELECT question,disputed_answer,scope_json,created_at FROM secretary_learning_memory
    WHERE conversation_key=? AND actor_role=? AND expires_at>? ORDER BY created_at DESC LIMIT 300`)
    .all(input.conversation, input.role, input.now) as Array<{question: string; disputed_answer: string; scope_json: string; created_at: number}>;
  const visible = rows.filter(row => (JSON.parse(row.scope_json) as string[]).every(id => input.allowedScope.has(id)));
  const docs = visible.map(row => ({row, tokens: terms(row.question)}));
  const frequencies = new Map(query.map(term => [term, docs.filter(doc => doc.tokens.includes(term)).length]));
  const ranked = docs.map(({row,tokens}) => ({row, score: query.reduce((score, term) => score + (tokens.includes(term)
    ? Math.log(1 + (docs.length + 1) / ((frequencies.get(term) ?? 0) + 1)) : 0), 0)
    / Math.sqrt(Math.max(tokens.length, 1)) * (0.7 + 0.3 * Math.exp(-Math.max(0, input.now-row.created_at)/(30*DAY)))}))
    .filter(item => item.score > 0).sort((a,b) => b.score-a.score || b.row.created_at-a.row.created_at);
  let budget = 3200;
  return ranked.slice(0, 4).flatMap(({row}) => {
    const question = row.question.slice(0, 400), disputedAnswer = row.disputed_answer.slice(0, 350);
    if (question.length + disputedAnswer.length > budget) return [];
    budget -= question.length + disputedAnswer.length;
    return [{question, disputedAnswer, recordedAt: row.created_at,
      guidance: "اعترض المستخدم على هذا الجواب سابقًا. لا تكرره كحقيقة؛ راجع بيانات الموقع الحالية أو مصادر موثوقة. الاعتراض لا يثبت تصحيحًا بديلًا ولا يسمح بتنفيذ أي تغيير."}];
  });
}


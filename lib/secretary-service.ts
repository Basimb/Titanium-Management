import { createHash, randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { executeManagementAction, getManagementSnapshot, migrateManagementActions, ManagementActionError, type ManagementCommand } from "./management-actions.ts";
import { resolveChatUser, normalizeContactNumber, type ChatUser } from "./team-chat-policy.ts";
import type { TeamChatConfig, TeamChatEnvelope } from "./team-chat-gateway.ts";
import { directTaskCreationIntent, emptySecretaryIntent, validateSecretaryIntent, type SecretaryIntent, type SecretaryModelInput } from "./secretary-intent.ts";
import { priorityTaskQuery, type PriorityTaskQuery } from "./secretary-priority-query.ts";
import { AGENT_KINDS } from "./secretary-intent.ts";
import { applyDecision, createProjectBundle, handleAgentIntent, type AgentResult } from "./secretary-agent.ts";
import { listApprovals } from "./approvals.ts";
import { activeRules } from "./rules.ts";
import { searchKnowledge, formatKnowledgeHits } from "./knowledge.ts";
import { migrateSecretaryMemory, rememberSecretaryMistake, recallSecretaryMemory, personalMemoryCommand, updatePersonalMemory, personalMemory } from "./secretary-memory.ts";
import { enqueueAgentMessage } from "./agent-followups.ts";
import { safeConversationalReply } from "./secretary-conversation-policy.ts";
import { secretaryReviewRequest, isSecretaryIdentityQuery, SECRETARY_IDENTITY } from "./secretary-review.ts";
import { migrateSecretaryOutbox, getSecretaryOutboxRecipients, createSecretaryOutboxPreview, confirmSecretaryOutboxPreview, getSecretaryOutboxStatus, secretaryOutboxDeliveryLabel, SecretaryOutboxError } from "./secretary-outbox.ts";
import { migrateSecretaryChoices, createSecretaryChoices, consumeSecretaryChoice, clearSecretaryChoices, secretaryChoiceOptions, SecretaryChoiceError, type SecretaryChoices, type SecretaryChoiceField } from "./secretary-choices.ts";

type Task = { id: string; projectId: string; title: string; details: string; status: string; priority: string; owner: string | null; suggestedOwner: string | null; dueDate: string | null; updatedAt: number | null; archivedAt: number | null };
type Project = { id: string; name: string; status: string; updatedAt?: number | null; archivedAt?: number | null };
type Snapshot = { tasks: Task[]; projects: Project[]; users: Array<ChatUser>; comments: Array<{ taskId: string; author: string; body: string; createdAt: number }> };
type Event = TeamChatEnvelope & { replyToMessageId?: string | null; responseMessageId?: string | null };
type Result = { status: string; reply: string; taskId?: string; batchId?: string; choices?: SecretaryChoices };
type Pending = { token: string; command_json: string; snapshot_hash: string; original_text: string; source_message_id: string; expires_at: number };
type ConfirmationView = { token: string; preview_event_key: string; requires_restatement: number };
type HistoryRow = { original_text: string; result_json: string; scope_json: string };
type TaskDraft = { projectId: string | null; title: string | null; details: string | null; priority: "red" | "yellow" | "green" | null; ownerId: string | null; dueDate: string | null };
type IntakeRow = { draft_json: string; last_event_key: string; expires_at: number };
const ORIGIN = "https://www.management.titanium-pharmacy.com";
const CONFIRM_MS = 10 * 60_000;
const HISTORY_MS = 24 * 60 * 60_000;
const HISTORY_CHARS = 6000;
const INTAKE_MS = 30 * 60_000;
const SENSITIVE = new Set(["edit_project", "approve_project", "reject_project", "restore_project", "archive_project", "delete_project", "edit_task", "cancel_claim", "submit", "approve", "reject", "reopen", "reassign", "move_task", "archive_task", "restore_task", "delete_task"]);
const LABELS: Record<string, string> = { open: "بانتظار الاستلام", progress: "قيد التنفيذ", approval: "بانتظار اعتماد باسم", completed: "معتمدة", active: "نشط", pending: "بانتظار الموافقة", rejected: "مرفوض" };
const ACTION_LABELS: Record<string, string> = { add_project: "إنشاء مشروع", edit_project: "تعديل المشروع", approve_project: "اعتماد المشروع", reject_project: "رفض المشروع", restore_project: "إعادة فتح المشروع", archive_project: "أرشفة المشروع", delete_project: "حذف المشروع نهائيًا", add_task: "إنشاء مهمة", edit_task: "تعديل المهمة", claim: "استلام المهمة", cancel_claim: "إرجاع المهمة", comment: "إضافة تعليق", submit: "إرسال المهمة لاعتماد باسم", approve: "اعتماد إنجاز المهمة", reject: "رفض الإنجاز", reopen: "إعادة فتح المهمة", reassign: "تغيير المسؤول", move_task: "نقل المهمة", archive_task: "أرشفة المهمة", restore_task: "استعادة المهمة", delete_task: "حذف المهمة نهائيًا" };
const clean = (value: unknown, max = 200) => String(value ?? "").replace(/[\x00-\x1f\u202a-\u202e\u2066-\u2069]/g, " ").slice(0, max);
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const conversation = (event: Event, actor: ChatUser) => hash([normalizeContactNumber(event.senderNumber), event.groupId, actor.id]);
const eventKey = (event: Event) => hash([event.senderNumber, event.groupId, event.messageId]);
const eventHash = (event: Event) => hash([event.senderNumber, event.groupId, event.text, event.replyToMessageId ?? null, event.responseMessageId ?? null, event.inputKind || "text", ...(event.choice ? [event.choice] : [])]);
function transaction<T>(db: DatabaseSync, work: () => T): T { db.exec("BEGIN IMMEDIATE"); try { const result = work(); db.exec("COMMIT"); return result; } catch (error) { db.exec("ROLLBACK"); throw error; } }
export function migrateSecretary(db: DatabaseSync) {
  migrateSecretaryMemory(db);
  migrateManagementActions(db);
  migrateSecretaryOutbox(db);
  migrateSecretaryChoices(db);
  db.exec(`CREATE TABLE IF NOT EXISTS secretary_events (event_key TEXT PRIMARY KEY,payload_hash TEXT NOT NULL,actor_id TEXT NOT NULL,conversation_key TEXT NOT NULL,original_text TEXT NOT NULL,result_json TEXT NOT NULL,scope_json TEXT NOT NULL,created_at INTEGER NOT NULL,response_message_id TEXT);
    CREATE INDEX IF NOT EXISTS secretary_history ON secretary_events(conversation_key,created_at);
    CREATE TABLE IF NOT EXISTS secretary_pending (conversation_key TEXT PRIMARY KEY,token TEXT NOT NULL,command_json TEXT NOT NULL,snapshot_hash TEXT NOT NULL,original_text TEXT NOT NULL,source_message_id TEXT NOT NULL,expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS secretary_confirmation_views (conversation_key TEXT PRIMARY KEY,token TEXT NOT NULL,preview_event_key TEXT NOT NULL,requires_restatement INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS secretary_task_intake (conversation_key TEXT PRIMARY KEY,draft_json TEXT NOT NULL,last_event_key TEXT NOT NULL,expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS secretary_reminders (id TEXT PRIMARY KEY,actor_id TEXT NOT NULL,sender_number TEXT NOT NULL,group_id TEXT,task_id TEXT NOT NULL,due_at INTEGER NOT NULL,state TEXT NOT NULL DEFAULT 'pending',created_at INTEGER NOT NULL,sent_at INTEGER,sending_at INTEGER,responded_at INTEGER,reply_message_id TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS secretary_reminders_due ON secretary_reminders(state,due_at);`);
}
function actorFor(db: DatabaseSync, event: Event, config: TeamChatConfig) {
  return resolveChatUser({ senderNumber: event.senderNumber, groupId: event.groupId }, config.contacts, db.prepare("SELECT id,name,role,active FROM users").all() as ChatUser[], config.allowedGroupIds);
}
function stateFor(db: DatabaseSync, actor: ChatUser): Snapshot { return getManagementSnapshot(db, actor) as unknown as Snapshot; }
function ownershipCandidates(db: DatabaseSync, actor: ChatUser): NonNullable<SecretaryModelInput["ownershipCandidates"]> {
  if (actor.id === "basem" || actor.role === "admin") return [];
  const projects = new Map((db.prepare("SELECT id,name FROM projects WHERE archived_at IS NULL").all() as Array<{ id: string; name: string }>).map(p => [p.id, p.name]));
  return (db.prepare("SELECT id,title,project_id AS projectId,status,owner,suggested_owner AS suggestedOwner FROM tasks WHERE archived_at IS NULL AND status NOT IN ('completed','approval') ORDER BY created_at,id").all() as Array<{ id: string; title: string; projectId: string; status: string; owner: string | null; suggestedOwner: string | null }>)
    .slice(0, 80).map(task => ({ id: task.id, title: task.title, projectName: projects.get(task.projectId) || "مشروع غير محدد", status: task.status, assignee: task.owner || task.suggestedOwner }));
}
function fingerprint(state: Snapshot) { return hash({ tasks: state.tasks, projects: state.projects, users: state.users.map(u => ({ id: u.id, name: u.name, role: u.role, active: u.active })), comments: state.comments }); }
function scopeAllowed(scope: string[], state: Snapshot) { const ids = new Set([...state.tasks.map(t => "t:" + t.id), ...state.projects.map(p => "p:" + p.id)]); return scope.every(id => ids.has(id)); }
function conversationHistory(db: DatabaseSync, key: string, state: Snapshot, now: number, anchor?: { created_at: number; sequence: number }): HistoryRow[] {
  const rows = (anchor
    ? db.prepare("SELECT original_text,result_json,scope_json FROM secretary_events WHERE conversation_key=? AND created_at>? AND (created_at<? OR (created_at=? AND rowid<=?)) ORDER BY created_at DESC,rowid DESC LIMIT 8")
      .all(key, now - HISTORY_MS, anchor.created_at, anchor.created_at, anchor.sequence)
    : db.prepare("SELECT original_text,result_json,scope_json FROM secretary_events WHERE conversation_key=? AND created_at>? ORDER BY created_at DESC,rowid DESC LIMIT 8")
      .all(key, now - HISTORY_MS)) as HistoryRow[];
  // Never let an inaccessible event supply either model context or task focus.
  return rows.reverse().filter(row => scopeAllowed(JSON.parse(row.scope_json), state));
}
function boundedHistory(rows: HistoryRow[], quote?: { result_json: string }): SecretaryModelInput["history"] {
  const quoted = quote ? ("الرسالة التي يرد عليها المستخدم الآن: " + String(JSON.parse(quote.result_json).reply)).slice(0, 900) : "";
  let remaining = HISTORY_CHARS - quoted.length;
  const history: SecretaryModelInput["history"] = [];
  // Preserve complete recent pairs first; older pairs are shortened to the remaining budget.
  for (const row of [...rows].reverse()) {
    if (remaining < 2) break;
    const user = row.original_text.slice(0, Math.min(600, Math.floor(remaining / 2)));
    const assistant = String(JSON.parse(row.result_json).reply).slice(0, Math.min(900, remaining - user.length));
    history.unshift({ role: "user", content: user }, { role: "assistant", content: assistant });
    remaining -= user.length + assistant.length;
  }
  if (quoted) history.push({ role: "assistant", content: quoted });
  return history;
}
function lookup(db: DatabaseSync, event: Event, actor: ChatUser, state: Snapshot): Result | null {
  const row = db.prepare("SELECT payload_hash,actor_id,result_json,scope_json FROM secretary_events WHERE event_key=?").get(eventKey(event)) as { payload_hash: string; actor_id: string; result_json: string; scope_json: string } | undefined;
  if (!row) return null;
  if (row.payload_hash !== eventHash(event) || row.actor_id !== actor.id || !scopeAllowed(JSON.parse(row.scope_json), state)) return { status: "denied", reply: "" };
  const result = JSON.parse(row.result_json);
  if (result.choices && (actor.id !== "basem" || actor.role !== "admin" || actor.active !== 1 || event.groupId !== null)) return { status: "denied", reply: "" };
  if (result.status === "confirmation" || (result.status === "clarify" && isConfirmationAttempt(event.text))) {
    const lastInstruction = String(result.reply).lastIndexOf("«موافق");
    const legacy = /^«موافق (T[0-9A-F]{6})»/iu.exec(String(result.reply).slice(lastInstruction));
    if (legacy) result.reply = visibleConfirmationReply(result.reply, legacy[1]);
  }
  return { ...result, status: "duplicate" };
}
function save(db: DatabaseSync, event: Event, actor: ChatUser, result: Result, scope: string[], now: number) {
  const bounded = { ...result, reply: result.reply.slice(0, 3800) };
  if (result.status === "confirmation") {
    const key = conversation(event, actor);
    const pending = db.prepare("SELECT token FROM secretary_pending WHERE conversation_key=?").get(key) as { token: string } | undefined;
    if (!pending) throw new Error("Confirmation requires a pending proposal.");
    const previous = confirmationView(db, key);
    bounded.reply = visibleConfirmationReply(bounded.reply, pending.token);
    db.prepare("INSERT INTO secretary_confirmation_views VALUES(?,?,?,?) ON CONFLICT(conversation_key) DO UPDATE SET token=excluded.token,preview_event_key=excluded.preview_event_key,requires_restatement=excluded.requires_restatement")
      .run(key, pending.token, eventKey(event), previous && previous.token !== pending.token ? 1 : previous?.requires_restatement ?? 0);
  }
  db.prepare("INSERT INTO secretary_events VALUES (?,?,?,?,?,?,?,?,?)").run(eventKey(event), eventHash(event), actor.id, conversation(event, actor), event.text, JSON.stringify(bounded), JSON.stringify(scope), now, event.responseMessageId ?? null);
  return bounded;
}
function log(db: DatabaseSync, actor: ChatUser, event: Event, action: string, details: Record<string, unknown>, now: number) {
  db.prepare("INSERT INTO audit_logs(actor_user_id,actor_name,action,entity_type,entity_id,details,created_at) VALUES(?,?,?,'secretary',?,?,?)")
    .run(actor.id, actor.name, action, eventKey(event), JSON.stringify({ summary: "محادثة سكرتير الإدارة", source: "whatsapp_secretary", sourceMessageId: event.messageId, senderNumber: event.senderNumber, originalText: event.text, ...details }), now);
}
function taskLink(task: Task) { return `${ORIGIN}/?project=${encodeURIComponent(task.projectId)}&task=${encodeURIComponent(task.id)}`; }
const PRIORITIES: Record<string, { icon: string; label: string; color: string }> = {
  red: { icon: "🔴", label: "قصوى", color: "الحمراء" },
  yellow: { icon: "🟡", label: "متوسطة", color: "الصفراء" },
  green: { icon: "🟢", label: "عادية", color: "الخضراء" },
};
export function formatSecretaryProjectHeadings(reply: string, state: Pick<Snapshot, "projects" | "tasks">) {
  return reply.split("\n").map(line => {
    const plain = line.replace(/\*/g, "");
    const content = plain.replace(/^\s*(?:(?:[-•]|\d+[.)])\s*)?(?:[🔵🔴🟡🟢⚪]\s*)?(?:المشروع:\s*)?/u, "");
    const project = [...state.projects].sort((a, b) => b.name.length - a.name.length).find(p =>
      content === p.name || content.startsWith(p.name + ":") || content.startsWith(p.name + " —") || content.startsWith(p.name + " -"));
    if (project) return `🔵 *${project.name.replace(/\*/g, "")}*${content.slice(project.name.length)}`;
    if (state.tasks.some(t => content === t.title || content.startsWith(t.title + " —") || content.startsWith(t.title + ":"))) return plain;
    return line;
  }).join("\n");
}
export function secretaryTaskCard(task: Task, state: Snapshot, now: number, detailed = false) {
  const project = state.projects.find(p => p.id === task.projectId);
  const latest = state.comments.filter(c => c.taskId === task.id).sort((a, b) => b.createdAt - a.createdAt)[0];
  const priority = PRIORITIES[task.priority];
  const overdue = task.status !== "completed" && task.dueDate && task.dueDate < new Date(now + 3 * 3600_000).toISOString().slice(0, 10);
  return `${project ? `🔵 *${clean(project.name, 90)}*\n\n` : ""}${priority?.icon || "⚪"} ${clean(task.title, 150)}\n${LABELS[task.status] || clean(task.status)}${overdue ? " • متأخرة عن الموعد" : ""}\nالأولوية: ${priority?.label || "غير محددة"}\nالمسؤول: ${clean(task.owner || task.suggestedOwner || "لم يُعيّن")} ${task.dueDate ? `• الموعد: ${clean(task.dueDate, 10)}` : ""}${detailed ? `\nالمطلوب: ${clean(task.details || "لا توجد تفاصيل إضافية", 600)}${latest ? `\nآخر تحديث (${clean(latest.author, 50)}): ${clean(latest.body, 500)}` : "\nلا يوجد تحديث مسجّل بعد."}` : ""}`;
}
function priorityReadReply(query: Extract<PriorityTaskQuery, { kind: "query" }>, state: Snapshot, now: number, text: string): { result: Result; scope: string[] } {
  const priority = PRIORITIES[query.priority];
  const today = new Date(now + 3 * 3600_000).toISOString().slice(0, 10);
  const owner = query.ownerId ? state.users.find(u => u.id === query.ownerId) : null;
  const tasks = state.tasks.filter(t => !t.archivedAt && t.priority === query.priority
    && (!query.projectId || t.projectId === query.projectId)
    && (!query.ownerId || !!owner && (t.owner || t.suggestedOwner) === owner.name)
    && (!query.status || (query.status === "overdue" ? t.status !== "completed" && !!t.dueDate && t.dueDate < today : t.status === query.status)))
    .sort((a, b) => a.projectId.localeCompare(b.projectId) || a.id.localeCompare(b.id, "en", { numeric: true }));
  const project = state.projects.find(p => p.id === query.projectId);
  const header = `${priority.icon} *المهام ${priority.color} — أولوية ${priority.label}*${project ? `\n🔵 *${clean(project.name, 100)}*` : ""}${owner ? `\nالمسؤول: ${clean(owner.name, 60)}` : ""}${query.status ? `\nالحالة: ${query.status === "overdue" ? "متأخرة عن الموعد" : LABELS[query.status]}` : ""}\nالمطابق ضمن صلاحياتك (دون الأرشيف): ${tasks.length}\nاللون للأولوية؛ حالة التنفيذ مذكورة لكل مهمة.\n`;
  const offset = query.offset || 0;
  const cards: string[] = [];
  for (const task of tasks.slice(offset, offset + 10)) {
    const card = `${offset + cards.length + 1}. ${secretaryTaskCard(task, state, now)}`;
    if ((header + cards.join("\n\n") + card).length > 3150) break;
    cards.push(card);
  }
  const next = offset + cards.length;
  const continuation = text.trim().replace(/\s+(?:ابتداء\s+)?من\s+(?:رقم\s+)?[0-9٠-٩۰-۹]+[.!؟?\s]*$/u, "").replace(/[.!؟?]+$/u, "");
  const footer = !tasks.length ? "\nما في مهام تطابق هذا الطلب حاليًا."
    : !cards.length ? `\nالقائمة فيها ${tasks.length} مهام فقط. ابدأ من 1.`
    : `\n\nعرض ${offset + 1}–${next} من ${tasks.length}.${next < tasks.length ? ` للتكملة اكتب: «${clean(continuation, 260)} من ${next + 1}».` : ""}`;
  return { result: { status: "summary", reply: header + "\n" + cards.join("\n\n") + footer }, scope: [...tasks.map(t => "t:" + t.id), ...(project ? ["p:" + project.id] : [])] };
}
function readReply(plan: SecretaryIntent, actor: ChatUser, state: Snapshot, now: number): { result: Result; scope: string[] } {
  const greeting = `أهلًا يا ${clean(actor.name, 60)}، `;
  if (plan.kind === "help") return { result: { status: "summary", reply: `${greeting}${SECRETARY_IDENTITY}\nاحكيلي بطريقتك: شو مهامي؟ اشرح المهمة، سجل تحديث، أو افتح مشروعًا (لباسم). وإذا قلت «جوابك غلط» براجع السؤال وجوابي على ضوء المعلومات المتاحة، وبستوضح أي نقص.\nالدخول للموقع برمز خاص على واتسابك المسجّل:\n${ORIGIN}/` }, scope: [] };
  if (plan.kind === "projects") return { result: { status: "summary", reply: greeting + "\n\n*المشاريع المتاحة إلك*\n\n" + (state.projects.length ? state.projects.slice(0, 16).map(p => `🔵 *${clean(p.name, 100)}* — ${LABELS[p.status] || clean(p.status)}`).join("\n\n") : "ما في مشاريع متاحة إلك حاليًا.") }, scope: state.projects.map(p => "p:" + p.id) };
  if (plan.kind === "details") {
    const task = state.tasks.find(t => t.id === plan.taskId);
    if (task) return { result: { status: "summary", reply: `${greeting}\n${secretaryTaskCard(task, state, now, true)}\n\nاحكيلي شو صار معك أو شو بدك أعمل عليها.`, taskId: task.id }, scope: ["t:" + task.id, "p:" + task.projectId] };
    if (plan.projectId) { const project = state.projects.find(p => p.id === plan.projectId); if (project) { const tasks = state.tasks.filter(t => t.projectId === project.id); return { result: { status: "summary", reply: `🔵 *${clean(project.name)}* — ${LABELS[project.status] || clean(project.status)}\n${tasks.length} مهام متاحة إلك، ${tasks.filter(t => t.status === "completed").length} معتمدة.\n\n${tasks.slice(0, 6).map(t => secretaryTaskCard(t, state, now)).join("\n\n")}` }, scope: ["p:" + project.id, ...tasks.map(t => "t:" + t.id)] }; } }
    return { result: { status: "clarify", reply: "أي مهمة أو مشروع بدك أشرح لك؟" }, scope: [] };
  }
  const tasks = state.tasks.filter(t => !t.archivedAt);
  const today = new Date(now + 3 * 3600_000).toISOString().slice(0, 10);
  const overdue = tasks.filter(t => t.status !== "completed" && t.dueDate && t.dueDate < today);
  const pending = tasks.filter(t => t.status === "approval");
  const header = plan.kind === "report" ? `📋 *ملخص الإدارة*\nالمشاريع: ${state.projects.length}\nمعتمدة: ${tasks.filter(t => t.status === "completed").length}\nقيد التنفيذ: ${tasks.filter(t => t.status === "progress").length}\nبانتظار باسم: ${pending.length}\nمتأخرة بموعد مسجل: ${overdue.length}\nبدون موعد: ${tasks.filter(t => !t.dueDate && t.status !== "completed").length}\n🔴 قصوى: ${tasks.filter(t => t.priority === "red").length} • 🟡 متوسطة: ${tasks.filter(t => t.priority === "yellow").length} • 🟢 عادية: ${tasks.filter(t => t.priority === "green").length}\n` : `${greeting}المهام المتاحة إلك: ${tasks.length}\n`;
  const ordered = [...tasks].sort((a, b) => Number(overdue.includes(b)) - Number(overdue.includes(a)) || Number(pending.includes(b)) - Number(pending.includes(a)));
  let body = "", shown = 0;
  const groups = new Map<string, Task[]>();
  for (const task of ordered) { const group = groups.get(task.projectId) || []; group.push(task); groups.set(task.projectId, group); }
  outer: for (const [projectId, group] of groups) {
    const name = state.projects.find(p => p.id === projectId)?.name || "مشروع غير محدد";
    let section = `\n\n🔵 *${clean(name, 100).replace(/\*/g, "")}*`;
    for (const task of group) {
      const priority = PRIORITIES[task.priority];
      const days = task.status !== "completed" && task.dueDate && task.dueDate < today ? Math.floor((Date.parse(today) - Date.parse(task.dueDate)) / 86400000) : 0;
      const item = `\n\n${priority?.icon || "⚪"} ${clean(task.title, 150).replace(/\*/g, "")}\n${LABELS[task.status] || clean(task.status)} • ${clean(task.owner || task.suggestedOwner || "غير معيّن", 50)}${days ? ` • 🔴 متأخرة ${days} يوم` : task.dueDate ? ` • الموعد: ${clean(task.dueDate, 10)}` : ""}`;
      if (header.length + body.length + section.length + item.length > 3500) break outer;
      section += item; shown++;
      body += section; section = "";
    }
  }
  const footer = shown < tasks.length ? `\n\nعرضت ${shown} من ${tasks.length} بسبب طول الرسالة. حدد اسم مشروع لأعرض مهامه.` : tasks.length ? `\n\nتم عرض جميع المهام (${shown}).` : "\nما في مهام متاحة إلك حاليًا.";
  return { result: { status: "summary", reply: header.trimEnd() + body + footer }, scope: tasks.map(t => "t:" + t.id) };
}
function commandFrom(plan: SecretaryIntent, state: Snapshot): Record<string, unknown> {
  const command: Record<string, unknown> = { action: plan.action };
  if (plan.taskId) command.taskId = plan.taskId;
  if (plan.projectId && (plan.action?.endsWith("_project") || plan.action === "add_task" || plan.action === "move_task")) command.projectId = plan.projectId;
  if (plan.action === "add_project") delete command.projectId;
  for (const [key, value] of Object.entries(plan.fields)) if (value !== null && key !== "remindAt") command[key === "body" ? "comment" : key] = value;
  const task = state.tasks.find(t => t.id === plan.taskId);
  const project = state.projects.find(p => p.id === (task?.projectId || plan.projectId));
  if (task) Object.assign(command, { expectedUpdatedAt: task.updatedAt, expectedStatus: task.status, expectedProjectId: task.projectId });
  if (project) Object.assign(command, { expectedProjectUpdatedAt: project.updatedAt ?? null, ...(project.status !== "archived" ? { expectedProjectStatus: project.status } : {}) });
  if (plan.action === "move_task") command.expectedTargetProjectUpdatedAt = state.projects.find(p => p.id === plan.projectId)?.updatedAt ?? null;
  return command;
}
function commandDescription(command: Record<string, unknown>, state: Snapshot) {
  const task = state.tasks.find(t => t.id === command.taskId); const project = state.projects.find(p => p.id === command.projectId);
  const employee = state.users.find(u => u.id === command.ownerId);
  const lines = [ACTION_LABELS[String(command.action)] || "التغيير المطلوب", task ? `المهمة: ${clean(task.title)}` : null, project ? `المشروع: ${clean(project.name)}` : null,
    command.title ? `العنوان: ${clean(command.title)}` : null, command.name ? `الاسم: ${clean(command.name)}` : null,
    command.details ? `التفاصيل: ${clean(command.details, 500)}` : null, employee ? `المسؤول: ${clean(employee.name)}` : null,
    command.comment ? `التعليق: ${clean(command.comment, 500)}` : null,
    command.priority ? `الأولوية: ${PRIORITIES[String(command.priority)]?.label || "غير محددة"}` : null,
    command.dueDate ? `الموعد: ${clean(command.dueDate)}` : null, command.reason ? `السبب: ${clean(command.reason, 350)}` : null];
  return lines.filter(Boolean).join("\n");
}
const AFFIRMATIONS = ["نعم", "موافق", "أكد", "اكد", "أكيد", "اكيد", "نفذ", "تمام", "yes", "confirm"];
function confirmationText(text: string) { return text.trim().replace(/[.!،]/g, "").replace(/\s+/g, " ").toLowerCase(); }
function isConfirmationAttempt(text: string) {
  const value = confirmationText(text);
  return AFFIRMATIONS.includes(value) || /^(?:(?:نعم|موافق|أكد|اكد|أكيد|اكيد|نفذ|تمام|yes|confirm) )?t[0-9a-f]{6}$/.test(value);
}
function isAffirmation(text: string, token: string, matchingQuote: boolean) {
  const value = confirmationText(text), expected = token.toLowerCase();
  return value === expected || AFFIRMATIONS.some(word => value === `${word} ${expected}`) || (matchingQuote && AFFIRMATIONS.includes(value));
}
function isCancellation(text: string) { return /^(?:لا|الغ[يِ]?|إلغاء|الغاء|ألغي|تراجع|cancel|no)[.!،\s]*$/iu.test(text.trim()); }
function confirmationView(db: DatabaseSync, key: string): ConfirmationView | undefined {
  return db.prepare("SELECT token,preview_event_key,requires_restatement FROM secretary_confirmation_views WHERE conversation_key=?").get(key) as ConfirmationView | undefined;
}
function clearConfirmationView(db: DatabaseSync, key: string) { db.prepare("DELETE FROM secretary_confirmation_views WHERE conversation_key=?").run(key); }
function rememberPendingPreview(db: DatabaseSync, event: Event, key: string, pending: Pending | undefined) {
  // Legacy pending proposals require a fresh visible preview before plain approval.
  if (pending && !confirmationView(db, key)) db.prepare("INSERT INTO secretary_confirmation_views VALUES(?,?,?,1)")
    .run(key, pending.token, eventKey({ ...event, messageId: pending.source_message_id }));
}
function visibleConfirmationReply(reply: string, token: string): string {
  // Change only the last generated instruction, never the exact user-supplied outgoing body.
  const instruction = `«موافق ${token}»`, at = reply.lastIndexOf(instruction);
  return at < 0 ? reply : reply.slice(0, at) + "«موافق»" + reply.slice(at + instruction.length);
}
function restateConfirmation(db: DatabaseSync, event: Event, actor: ChatUser, state: Snapshot, live: Pending, key: string, now: number): Result {
  const source = db.prepare("SELECT result_json,scope_json FROM secretary_events WHERE event_key=? AND conversation_key=?")
    .get(eventKey({ ...event, messageId: live.source_message_id }), key) as { result_json: string; scope_json: string } | undefined;
  const original = source ? JSON.parse(source.result_json) as Result : null;
  if (!source || original?.status !== "confirmation" || !scopeAllowed(JSON.parse(source.scope_json), state)) {
    db.prepare("DELETE FROM secretary_pending WHERE conversation_key=? AND token=?").run(key, live.token); clearConfirmationView(db, key);
    return save(db, event, actor, { status: "stale", reply: "ما قدرت أسترجع المعاينة الدقيقة؛ لم أنفّذ شيئًا. اذكر الطلب من جديد." }, [], now);
  }
  // This acknowledgement refreshes the exact visible proposal; a separate new reply must approve it.
  db.prepare("INSERT INTO secretary_confirmation_views VALUES(?,?,?,0) ON CONFLICT(conversation_key) DO UPDATE SET token=excluded.token,preview_event_key=excluded.preview_event_key,requires_restatement=0")
    .run(key, live.token, eventKey(event));
  return save(db, event, actor, { ...original, reply: "للتأكد من الطلب الحالي، راجع هذه المعاينة ثم اكتب «موافق»:\n\n" + visibleConfirmationReply(original.reply, live.token) }, JSON.parse(source.scope_json), now);
}

function intakeRow(db: DatabaseSync, key: string): IntakeRow | undefined {
  return db.prepare("SELECT draft_json,last_event_key,expires_at FROM secretary_task_intake WHERE conversation_key=?").get(key) as IntakeRow | undefined;
}
function pendingTaskDraft(pending: Pending | undefined, snapshotHash: string, now: number): TaskDraft | null {
  if (!pending || pending.expires_at <= now || pending.snapshot_hash !== snapshotHash) return null;
  const command = JSON.parse(pending.command_json);
  if (command.action !== "add_task") return null;
  return { projectId: typeof command.projectId === "string" ? command.projectId : null,
    title: typeof command.title === "string" ? command.title : null, details: typeof command.details === "string" ? command.details : null,
    priority: ["red", "yellow", "green"].includes(command.priority) ? command.priority : null,
    ownerId: command.ownerId === null ? "unassigned" : typeof command.ownerId === "string" ? command.ownerId : null,
    dueDate: command.dueDate === null ? "unscheduled" : typeof command.dueDate === "string" ? command.dueDate : null };
}
function availableDraft(draft: TaskDraft, state: Snapshot): TaskDraft {
  const date = draft.dueDate;
  const validDate = date === "unscheduled" || (typeof date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(date)
    && Number.isFinite(Date.parse(`${date}T00:00:00Z`)) && new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) === date);
  return { projectId: state.projects.some(project => project.id === draft.projectId && project.status === "active" && !project.archivedAt) ? draft.projectId : null,
    title: draft.title?.trim() || null, details: draft.details?.trim() || null,
    priority: draft.priority && ["red", "yellow", "green"].includes(draft.priority) ? draft.priority : null,
    ownerId: draft.ownerId === "unassigned" || state.users.some(user => user.id === draft.ownerId && user.active === 1) ? draft.ownerId : null,
    dueDate: validDate ? date : null };
}
function intakeQuestion(draft: TaskDraft, state: Snapshot): string | null {
  if (!draft.projectId) return `بأي مشروع بدك أضيف المهمة؟${state.projects.some(project => project.status === "active") ? ` المشاريع النشطة: ${state.projects.filter(project => project.status === "active").slice(0, 8).map(project => clean(project.name, 90)).join("، ")}.` : " ما في مشروع نشط حاليًا؛ لازم نجهّز مشروعًا أولًا."}`;
  if (!draft.title) return "شو المهمة أو الشغل المطلوب بالضبط؟";
  if (!draft.ownerId) return "مين بدك يمسك المهمة؟ اذكر الموظف، أو قل «بدون مسؤول حاليًا».";
  if (!draft.priority) return "شو أولويتها: 🔴 قصوى، 🟡 متوسطة، ولا 🟢 عادية؟ هاي أولوية الشغل، مش حالة تنفيذه.";
  if (!draft.dueDate) return "شو موعدها؟ اذكر التاريخ، أو قل «بدون موعد».";
  return null;
}
function choiceCatalogHash(state: Snapshot) {
  return hash({ projects: state.projects.map(project => ({ id: project.id, name: project.name, status: project.status, updatedAt: project.updatedAt, archivedAt: project.archivedAt })),
    users: state.users.map(user => ({ id: user.id, name: user.name, active: user.active, role: user.role })) });
}
function missingChoiceField(draft: TaskDraft): SecretaryChoiceField | null {
  if (!draft.projectId) return "projectId";
  if (!draft.title) return null;
  if (!draft.ownerId) return "ownerId";
  if (!draft.priority) return "priority";
  return draft.dueDate ? null : "dueDate";
}
function intakeChoices(db: DatabaseSync, actor: ChatUser, state: Snapshot, draft: TaskDraft, key: string, now: number): SecretaryChoices | undefined {
  const field = missingChoiceField(draft); if (!field) return undefined;
  const options = secretaryChoiceOptions(field, { projects: state.projects.filter(project => project.status === "active" && !project.archivedAt), users: state.users.filter(user => user.active === 1), now });
  if (!options.length) return undefined;
  const titles = { projectId: "اختار المشروع", ownerId: "مين المسؤول عن المهمة؟", priority: "اختار الأولوية، وليس حالة التنفيذ", dueDate: "اختار موعد المهمة بتوقيت عمّان" };
  return createSecretaryChoices(db, { conversationKey: key, actorId: actor.id, draftVersion: hash(intakeRow(db, key)), catalogHash: choiceCatalogHash(state),
    field, title: titles[field], options, now, expiresAt: Math.min(now + INTAKE_MS, intakeRow(db, key)?.expires_at ?? now) });
}
function currentIntakeQuestion(db: DatabaseSync, event: Event, actor: ChatUser, state: Snapshot, key: string, now: number): { result: Result; scope: string[] } | null {
  if (actor.id !== "basem" || actor.role !== "admin") return null;
  const live = intakeRow(db, key);
  if (!live || live.expires_at <= now) return null;
  const draft = availableDraft(JSON.parse(live.draft_json), state);
  const question = intakeQuestion(draft, state);
  if (!question) return { result: { status: "clarify", reply: "لم أنشئ المهمة؛ نحتاج معاينة نهائية وموافقتك عليها قبل التنفيذ." }, scope: draft.projectId ? ["p:" + draft.projectId] : [] };
  const choices = event.groupId === null ? intakeChoices(db, actor, state, draft, key, now) : undefined;
  return { result: { status: "clarify", reply: question + (choices ? `\n\n${choices.options.map(option => option.label).join("\n")}\nاختار خيارًا واحدًا، أو اكتب اسم الخيار بالكلام.` : ""), ...(choices ? { choices } : {}) }, scope: draft.projectId ? ["p:" + draft.projectId] : [] };
}
function taskIntake(db: DatabaseSync, event: Event, actor: ChatUser, state: Snapshot, plan: SecretaryIntent,
  key: string, existingDraft: TaskDraft | null, now: number, freeTextField?: SecretaryChoiceField): Result {
  if (actor.id !== "basem" || actor.role !== "admin") return save(db, event, actor, { status: "denied", reply: "إنشاء المهام وتعيينها من صلاحيات باسم فقط. أقدر أساعدك بتحديث مهامك الحالية." }, [], now);
  if (plan.intakeMode !== "start" && (plan.intakeMode !== "continue" || !existingDraft)) {
    db.prepare("DELETE FROM secretary_task_intake WHERE conversation_key=?").run(key);
    clearSecretaryChoices(db, key);
    return save(db, event, actor, { status: "clarify", reply: "ما في مسودة مهمة حالية نكمل عليها. احكيلي المهمة الجديدة المطلوبة من البداية." }, [], now);
  }
  const proposed: TaskDraft = { projectId: plan.projectId, title: plan.fields.title, details: plan.fields.details,
    priority: plan.fields.priority, ownerId: plan.fields.ownerId, dueDate: plan.fields.dueDate };
  if (plan.intakeMode === "continue" && existingDraft) {
    for (const field of Object.keys(proposed) as Array<keyof TaskDraft>) {
      if (proposed[field] === null) Object.assign(proposed, { [field]: existingDraft[field] });
    }
  }
  const draft = availableDraft(proposed, state);
  clearSecretaryChoices(db, key);
  // Collecting a new proposal never reuses an older task/send confirmation.
  db.prepare("DELETE FROM secretary_pending WHERE conversation_key=?").run(key);
  db.prepare("INSERT INTO secretary_task_intake VALUES(?,?,?,?) ON CONFLICT(conversation_key) DO UPDATE SET draft_json=excluded.draft_json,last_event_key=excluded.last_event_key,expires_at=excluded.expires_at")
    .run(key, JSON.stringify(draft), eventKey(event), now + INTAKE_MS);
  const question = intakeQuestion(draft, state);
  const scope = draft.projectId ? ["p:" + draft.projectId] : [];
  if (question) {
    if (freeTextField) return save(db, event, actor, { status: "clarify", reply: freeTextField === "dueDate" ? "اكتب التاريخ المطلوب باليوم والشهر والسنة." : freeTextField === "projectId" ? "اكتب اسم المشروع المقصود." : "اكتب اسم الموظف المقصود." }, scope, now);
    const choices = event.groupId === null ? intakeChoices(db, actor, state, draft, key, now) : undefined;
    return save(db, event, actor, { status: "clarify", reply: question + (choices ? `\n\n${choices.options.map(option => option.label).join("\n")}\nاختار خيارًا واحدًا، أو اكتب اسم الخيار بالكلام.` : ""), ...(choices ? { choices } : {}) }, scope, now);
  }
  const project = state.projects.find(item => item.id === draft.projectId)!;
  const owner = state.users.find(item => item.id === draft.ownerId);
  const token = "T" + randomBytes(3).toString("hex").toUpperCase();
  const command = { action: "add_task", projectId: draft.projectId, title: draft.title, ...(draft.details ? { details: draft.details } : {}),
    ownerId: draft.ownerId === "unassigned" ? null : draft.ownerId, priority: draft.priority,
    dueDate: draft.dueDate === "unscheduled" ? null : draft.dueDate, expectedProjectUpdatedAt: project.updatedAt ?? null, expectedProjectStatus: "active" };
  const reply = `للتأكيد قبل إنشاء المهمة:\nالمشروع: ${clean(project.name, 240)}\nالمهمة: ${draft.title}${draft.details ? `\nالمطلوب: ${draft.details}` : ""}\nالمسؤول: ${owner ? clean(owner.name, 200) : "بدون مسؤول حاليًا"}\nالأولوية: ${PRIORITIES[draft.priority!].icon} ${PRIORITIES[draft.priority!].label}\nالموعد: ${draft.dueDate === "unscheduled" ? "بدون موعد" : draft.dueDate}\nالحالة عند الإنشاء: مفتوحة بانتظار الاستلام.\n\nلم أنشئ المهمة بعد. اكتب «موافق ${token}» أو رد مباشرة بالموافقة على هذه المعاينة؛ وللتراجع اكتب «إلغاء». التأكيد صالح 10 دقائق.`;
  if (reply.length > 3700) return save(db, event, actor, { status: "clarify", reply: "تفاصيل المهمة طويلة للمعاينة الكاملة. اختصر التفاصيل حتى أعرضها كلها قبل التأكيد." }, scope, now);
  db.prepare("DELETE FROM secretary_task_intake WHERE conversation_key=?").run(key);
  db.prepare("INSERT INTO secretary_pending VALUES(?,?,?,?,?,?,?)").run(key, token, JSON.stringify(command), fingerprint(state), event.text, event.messageId, now + CONFIRM_MS);
  log(db, actor, event, "secretary_proposal", { summary: "عرض إنشاء مهمة بعد استكمال بياناتها", proposedCommand: command, confirmationRequired: true }, now);
  return save(db, event, actor, { status: "confirmation", reply }, scope, now);
}

function reminder(db: DatabaseSync, event: Event, actor: ChatUser, state: Snapshot, taskId: unknown, due: unknown, now: number): Result {
  const task = state.tasks.find(t => t.id === taskId);
  if (!task || typeof due !== "number" || !Number.isFinite(due) || due < now + 60_000 || due > now + 90 * 86400_000) return save(db, event, actor, { status: "clarify", reply: "حدد المهمة وموعدًا قادمًا للتذكير بالتاريخ والساعة بتوقيت عمّان/الرياض." }, [], now);
  if (Number((db.prepare("SELECT count(*) AS n FROM secretary_reminders WHERE actor_id=? AND state='pending'").get(actor.id) as { n: number }).n) >= 30) return save(db, event, actor, { status: "clarify", reply: "عندك 30 تذكيرًا قادمًا. خلينا نراجعها قبل إضافة المزيد." }, [], now);
  const id = randomBytes(16).toString("hex");
  db.prepare("INSERT INTO secretary_reminders(id,actor_id,sender_number,group_id,task_id,due_at,created_at,reply_message_id) VALUES(?,?,?,?,?,?,?,?)").run(id, actor.id, event.senderNumber, event.groupId, task.id, due, now, "TITANIUMREM" + id.toUpperCase());
  log(db, actor, event, "secretary_reminder", { summary: "جدول تذكيرًا لمهمة", taskId: task.id, dueAt: due }, now);
  return save(db, event, actor, { status: "scheduled", reply: `جدولت تذكيرك عن «${clean(task.title)}» يوم ${new Intl.DateTimeFormat("ar-JO", { timeZone: "Asia/Amman", dateStyle: "medium", timeStyle: "short" }).format(due)} في نفس المحادثة.`, taskId: task.id }, ["t:" + task.id], now);
}

// Search only an exact user-authored question, never model-extracted history or a
// task catalog. Private/project questions are answered through authorized DB reads.
function privateSearchQuestion(query: string, state: Snapshot): boolean {
  const normalize = (value: string) => value.normalize("NFKC").replace(/[\u064b-\u065f\u0670\u0640]/g, "").replace(/[أإآ]/g, "ا").replace(/ى/g, "ي").replace(/ة/g, "ه").toLowerCase();
  const value = normalize(query);
  return !query.trim() || query.length > 500 || (value.match(/[0-9٠-٩۰-۹]/gu)?.length ?? 0) >= 6
    || /@|https?:\/\/|(?:مهمتي|مهامي|مشاريعي|مشروعنا|موظف|مريض|رقم الهويه|رمز الدخول|كلمه السر|ارقام الفريق|ارقام فريق|ارقام الشباب|فريقنا|شركتنا|راتب|رواتب)|\b(?:otp|password|pin|api.?key)\b/u.test(value)
    || [...state.tasks.map(t => t.title), ...state.projects.map(p => p.name), ...state.users.map(u => u.name)]
      .some(title => title.length > 2 && value.includes(normalize(title)));
}

export async function handleSecretaryEvent(db: DatabaseSync, event: Event, config: TeamChatConfig, dependencies: {
  infer: (input: SecretaryModelInput) => Promise<SecretaryIntent>; search?: (query: string) => Promise<string>; now?: () => number;
}): Promise<Result> {
  migrateSecretary(db); const now = (dependencies.now || Date.now)();
  const actor = actorFor(db, event, config); if (!actor) return { status: "denied", reply: "" };
  const initial = stateFor(db, actor); const previous = lookup(db, event, actor, initial); if (previous) return previous;
  const key = conversation(event, actor); const initialHash = fingerprint(initial);
  const profileCommand = personalMemoryCommand(event.text);
  if (profileCommand && actor.id === "basem" && actor.role === "admin" && event.groupId === null && !event.replyToMessageId) {
    return transaction(db, () => {
      const fresh = actorFor(db, event, config);
      if (!config.enabled || !fresh || JSON.stringify(fresh) !== JSON.stringify(actor)) return { status: "denied", reply: "" };
      const duplicate = lookup(db, event, fresh, stateFor(db, fresh)); if (duplicate) return duplicate;
      updatePersonalMemory(db, fresh.id, profileCommand, now);
      return save(db, event, fresh, { status: "applied", reply: profileCommand.body === null
        ? `حذفت «${profileCommand.topic}» من ذاكرتك الشخصية.`
        : `حفظت في ذاكرتك الشخصية: ${profileCommand.topic} — ${profileCommand.body}\nتقدر تعدّل نفس الموضوع أو تقول «انس عني: ${profileCommand.topic}».` }, [], now);
    });
  }
  const pending = db.prepare("SELECT * FROM secretary_pending WHERE conversation_key=?").get(key) as Pending | undefined;
  const storedIntake = intakeRow(db, key);
  const pendingDraft = pendingTaskDraft(pending, initialHash, now);
  const draftCandidate = storedIntake && storedIntake.expires_at > now ? JSON.parse(storedIntake.draft_json) : pendingDraft;
  const taskDraft = draftCandidate && actor.id === "basem" && actor.role === "admin" ? availableDraft(draftCandidate, initial) : null;
  const eventChoice = event.choice;
  if (eventChoice) return transaction(db, () => {
    const freshActor = actorFor(db, event, config);
    if (!config.enabled || !freshActor || JSON.stringify(freshActor) !== JSON.stringify(actor) || freshActor.id !== "basem" || freshActor.role !== "admin"
      || event.groupId !== null || event.inputKind === "voice" || event.replyToMessageId) return { status: "denied", reply: "" };
    const state = stateFor(db, freshActor); const duplicate = lookup(db, event, freshActor, state); if (duplicate) return duplicate;
    try {
      const liveIntake = intakeRow(db, key);
      if (!taskDraft || !storedIntake || !liveIntake || liveIntake.expires_at <= now || hash(liveIntake) !== hash(storedIntake)) throw new SecretaryChoiceError();
      const selected = consumeSecretaryChoice(db, { conversationKey: key, actorId: freshActor.id, draftVersion: hash(liveIntake), catalogHash: choiceCatalogHash(state), now }, eventChoice);
      const current = availableDraft(JSON.parse(liveIntake.draft_json), state);
      // Only the stored opaque option selects a value; the submitted display label is not an instruction.
      const draft = { ...current, ...(selected.value === null ? {} : { [selected.field]: selected.value }) } as TaskDraft;
      const plan: SecretaryIntent = { kind: "task_draft", intakeMode: "continue", action: null, taskId: null, projectId: draft.projectId, recipientIds: [], message: null,
        fields: { title: draft.title, details: draft.details, ownerId: draft.ownerId, priority: draft.priority, dueDate: draft.dueDate, name: null, reason: null, body: null, remindAt: null } };
      return taskIntake(db, event, freshActor, state, plan, key, current, now, selected.value === null ? selected.field : undefined);
    } catch (error) {
      if (!(error instanceof SecretaryChoiceError)) throw error;
      return save(db, event, freshActor, { status: "clarify", reply: error.message }, [], now);
    }
  });
  const quote = event.replyToMessageId ? db.prepare("SELECT event_key,original_text,result_json,scope_json,created_at,rowid AS sequence FROM secretary_events WHERE conversation_key=? AND response_message_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1").get(key, event.replyToMessageId) as { event_key: string; original_text: string; result_json: string; scope_json: string; created_at: number; sequence: number } | undefined : undefined;
  if (event.replyToMessageId && (!quote || !scopeAllowed(JSON.parse(quote.scope_json), initial))) return transaction(db, () => save(db, event, actor, { status: "clarify", reply: "ما قدرت أربط هذا الرد بطلب متاح إلك. اذكر المهمة والتغيير المطلوب بدل الرد على رسالة قديمة أو لشخص آخر." }, [], now));
  const historyRows = conversationHistory(db, key, initial, now);
  const focusResult = quote ? JSON.parse(quote.result_json) : historyRows.length ? JSON.parse(historyRows[historyRows.length - 1].result_json) : null;
  const focusedTask = initial.tasks.find(task => task.id === focusResult?.taskId);
  const focusedTaskId = focusedTask?.id ?? null;
  const history = boundedHistory(historyRows, quote);
  // A reply to an earlier review must recover that review's original question,
  // never a newer unrelated question after the quoted event.
  const reviewingReview = quote && secretaryReviewRequest(quote.original_text, []) !== null;
  const reviewRequest = reviewingReview
    ? secretaryReviewRequest(event.text, boundedHistory(conversationHistory(db, key, initial, now, quote)))
    : secretaryReviewRequest(event.text, history, quote ? { question: quote.original_text, previousAnswer: String(JSON.parse(quote.result_json).reply) } : undefined);
  const earlyRead = (result: Result, scope: string[] = []) => transaction(db, () => {
    const freshActor = actorFor(db, event, config);
    if (!config.enabled || !freshActor || JSON.stringify(freshActor) !== JSON.stringify(actor)) return { status: "denied", reply: "" };
    const state = stateFor(db, freshActor); const duplicate = lookup(db, event, freshActor, state); if (duplicate) return duplicate;
    if (fingerprint(state) !== initialHash) return save(db, event, freshActor, { status: "stale", reply: "تغيّرت بيانات العمل؛ خلينا نراجع آخر وضع." }, [], now);
    rememberPendingPreview(db, event, key, db.prepare("SELECT * FROM secretary_pending WHERE conversation_key=?").get(key) as Pending | undefined);
    return save(db, event, freshActor, result, scope, now);
  });
  const callerQuestion = event.text.normalize("NFKC").replace(/[أإآ]/g, "ا").replace(/[\u064b-\u065f\u0670\u0640]/g, "").trim();
  const callerMatch = /^(?:(?:مرحبا|هلا|اهلا)[،,!\s]+)?(?:مين انا|بتعرفني|من انا)[؟?،,\s]*(?:(?:و\s*)?(?:شو|ايش|ما هي)\s+المشاريع(?:\s+(?:الموجودة|الموجوده|النشطة|النشطه))?(?:\s+(?:عندنا|عنا))?[؟?!.\s]*)?$/u.exec(callerQuestion);
  if (callerMatch && !event.replyToMessageId) {
    const projects = callerQuestion.includes("المشاريع") ? initial.projects : [];
    return earlyRead({ status: "summary", reply: `أهلًا ${clean(actor.name, 60)}، بعرفك من رقمك المسجّل عندنا.` + (callerQuestion.includes("المشاريع")
      ? `\n\n*المشاريع المتاحة إلك*\n\n${projects.length ? projects.map(p => `🔵 *${clean(p.name, 100)}*\nالحالة: ${LABELS[p.status] || clean(p.status)}`).join("\n\n") : "ما في مشاريع متاحة حاليًا."}` : "") }, projects.map(p => "p:" + p.id));
  }
  if (isSecretaryIdentityQuery(event.text)) return earlyRead({ status: "summary", reply: SECRETARY_IDENTITY });
  if (reviewRequest?.kind === "clarify") return earlyRead({ status: "clarify", reply: reviewRequest.reply });
  const review = reviewRequest?.kind === "review" ? reviewRequest : null;
  if (storedIntake && isCancellation(event.text)) return transaction(db, () => {
    const freshActor = actorFor(db, event, config); if (!freshActor || JSON.stringify(freshActor) !== JSON.stringify(actor)) return { status: "denied", reply: "" };
    const duplicate = lookup(db, event, freshActor, stateFor(db, freshActor)); if (duplicate) return duplicate;
    db.prepare("DELETE FROM secretary_task_intake WHERE conversation_key=?").run(key);
    db.prepare("DELETE FROM secretary_pending WHERE conversation_key=?").run(key);
    clearConfirmationView(db, key);
    clearSecretaryChoices(db, key);
    return save(db, event, freshActor, { status: "cancelled", reply: "ألغيت مسودة المهمة. لم أنشئ مهمة أو أنفّذ طلبًا سابقًا." }, [], now);
  });
  if (!pending && isConfirmationAttempt(event.text)) return transaction(db, () => {
    const freshActor = actorFor(db, event, config); if (!freshActor || JSON.stringify(freshActor) !== JSON.stringify(actor)) return { status: "denied", reply: "" };
    const state = stateFor(db, freshActor); const duplicate = lookup(db, event, freshActor, state); if (duplicate) return duplicate;
    const focusSource = quote ?? historyRows[historyRows.length - 1];
    const visibleFocus = focusSource && scopeAllowed(JSON.parse(focusSource.scope_json), state) ? state.tasks.find(task => task.id === focusedTaskId) : undefined;
    if (!AFFIRMATIONS.includes(confirmationText(event.text))) return save(db, event, actor, { status: "clarify", reply: "ما في طلب معلّق مطابق للتأكيد. اذكر التغيير المطلوب لأعرضه عليك من جديد." }, [], now);
    const currentQuestion = currentIntakeQuestion(db, event, freshActor, state, key, now);
    if (currentQuestion) return save(db, event, freshActor, currentQuestion.result, currentQuestion.scope, now);
    return save(db, event, freshActor, { status: "summary", reply: `تمام يا ${clean(freshActor.name, 60)}، أنا معك.${visibleFocus ? ` نكمل على «${clean(visibleFocus.title, 120)}»؛ احكيلي شو المطلوب.` : " احكيلي كيف أقدر أساعدك."}`, ...(visibleFocus ? { taskId: visibleFocus.id } : {}) }, visibleFocus ? ["t:" + visibleFocus.id, "p:" + visibleFocus.projectId] : [], now);
  });
  if (pending && (isConfirmationAttempt(event.text) || isCancellation(event.text))) {
    return transaction(db, () => {
      const freshActor = actorFor(db, event, config); if (!freshActor) return { status: "denied", reply: "" };
      const state = stateFor(db, freshActor); const duplicate = lookup(db, event, freshActor, state); if (duplicate) return duplicate;
      const live = db.prepare("SELECT * FROM secretary_pending WHERE conversation_key=?").get(key) as Pending | undefined;
      if (!live || live.token !== pending.token) return save(db, event, freshActor, { status: "clarify", reply: "تغيّر الطلب المعلّق. اذكر التغيير المطلوب من جديد." }, [], now);
      // Expiry is checked against the live row under the lock BEFORE displaying its token.
      if (live.expires_at <= now && !isCancellation(event.text)) {
        db.prepare("DELETE FROM secretary_pending WHERE conversation_key=? AND token=? AND expires_at<=?").run(key, live.token, now);
        clearConfirmationView(db, key);
        clearSecretaryChoices(db, key);
        const currentQuestion = AFFIRMATIONS.includes(confirmationText(event.text)) ? currentIntakeQuestion(db, event, freshActor, state, key, now) : null;
        if (currentQuestion) return save(db, event, freshActor, currentQuestion.result, currentQuestion.scope, now);
        return save(db, event, freshActor, { status: "stale", reply: "انتهى وقت الطلب السابق؛ لم أنفّذ شيئًا. احكيلي المطلوب من جديد لنراجعه بتأكيد جديد." }, [], now);
      }
      if (live.snapshot_hash !== fingerprint(state) && !isCancellation(event.text)) {
        db.prepare("DELETE FROM secretary_pending WHERE conversation_key=? AND token=?").run(key, live.token); clearConfirmationView(db, key);
        return save(db, event, freshActor, { status: "stale", reply: "تغيّرت البيانات أو الصلاحيات؛ لم أنفّذ الطلب. اذكره من جديد لأعرض الوضع الحالي." }, [], now);
      }
      const view = confirmationView(db, key);
      const originalPreviewKey = eventKey({ ...event, messageId: live.source_message_id });
      const matchingQuote = !!quote && JSON.parse(quote.result_json).status === "confirmation"
        && (quote.event_key === originalPreviewKey || (view?.token === live.token && quote.event_key === view.preview_event_key));
      if (quote && !matchingQuote) return save(db, event, freshActor, { status: "clarify", reply: "هذا الرد ليس على الطلب الحالي. رد بالموافقة على معاينته الحالية، أو اكتب «موافق» لأعيد عرضها قبل التنفيذ." }, [], now);
      if (!isCancellation(event.text) && !isAffirmation(event.text, live.token, matchingQuote)) {
        if (!AFFIRMATIONS.includes(confirmationText(event.text))) return save(db, event, freshActor, { status: "clarify", reply: "هذه الموافقة ليست للطلب الحالي. رد على معاينته الحالية، أو اكتب «موافق» لأراجعه معك." }, [], now);
        const latest = db.prepare("SELECT event_key,result_json FROM secretary_events WHERE conversation_key=? ORDER BY created_at DESC,rowid DESC LIMIT 1").get(key) as { event_key: string; result_json: string } | undefined;
        const latestMatches = view?.token === live.token && view.requires_restatement === 0 && !!latest && latest.event_key === view.preview_event_key && JSON.parse(latest.result_json).status === "confirmation";
        if (!latestMatches) return restateConfirmation(db, event, freshActor, state, live, key, now);
      }
      db.prepare("DELETE FROM secretary_pending WHERE conversation_key=?").run(key);
      clearConfirmationView(db, key);
      clearSecretaryChoices(db, key);
      if (isCancellation(event.text)) { log(db, freshActor, event, "secretary_cancel", { summary: "ألغى الطلب قبل التنفيذ" }, now); return save(db, event, freshActor, { status: "cancelled", reply: "ألغيت الطلب المعلّق، ما غيّرت المهمة أو المشروع." }, [], now); }
      if (live.expires_at <= now || live.snapshot_hash !== fingerprint(state)) return save(db, event, freshActor, { status: "stale", reply: "انتهى وقت التأكيد أو تغيّرت البيانات/الصلاحيات. ما نفذت الطلب؛ اذكره من جديد لأعرض الوضع الحالي." }, [], now);
      const command = JSON.parse(live.command_json);
      if (command.action === "message_team") {
        try {
          const batch = confirmSecretaryOutboxPreview(db, { batchId: command.batchId, actor: freshActor,
            origin: { senderNumber: event.senderNumber, groupId: event.groupId }, confirmationMessageId: eventKey(event) }, config, { now });
          log(db, freshActor, event, "secretary_message_queued", { summary: "أكد إرسال رسالة منفصلة للموظفين", batchId: batch.batchId, recipientCount: batch.recipientCount, sourceMessageId: live.source_message_id }, now);
          return save(db, event, freshActor, { status: "queued", batchId: batch.batchId, reply: `أكدت الطلب وأضفت الرسالة لطابور الإرسال على الخاص إلى ${batch.recipientCount} موظفين، كل واحد لحاله. هذا ليس تأكيد وصول؛ رح يوصلك تقرير بنتيجة الإرسال.` }, [], now);
        } catch (error) { if (!(error instanceof SecretaryOutboxError)) throw error; return save(db, event, freshActor, { status: "clarify", reply: error.message }, [], now); }
      }
      if (command.action === "schedule_reminder") return reminder(db, event, freshActor, state, command.taskId, command.dueAt, now);
      if (command.action === "create_project_bundle" || command.action === "decide_approval") {
        try {
          const result = command.action === "create_project_bundle"
            ? createProjectBundle(db, freshActor, { name: String(command.name), goal: String(command.goal ?? ""), tasks: Array.isArray(command.tasks) ? command.tasks : [], suppressNotices: command.suppressNotices === true }, now, { originalText: live.original_text, sourceMessageId: live.source_message_id, confirmationRequired: true, confirmedBy: freshActor.id, confirmationMessageId: event.messageId, senderNumber: event.senderNumber, origin: "whatsapp" })
            : applyDecision(db, freshActor, { approvalId: String(command.approvalId), decision: command.decision === "approved" ? "approved" : "rejected", note: typeof command.note === "string" ? command.note : undefined }, now);
          deliverAgentSideEffects(db, freshActor, result, now);
          return save(db, event, freshActor, { status: result.status, reply: result.reply }, [], now);
        } catch (error) { if (!(error instanceof ManagementActionError)) throw error; return save(db, event, freshActor, { status: "clarify", reply: error.message }, [], now); }
      }
      return perform(db, event, freshActor, state, command, now, { originalText: live.original_text, sourceMessageId: live.source_message_id, confirmationRequired: true, confirmedBy: freshActor.id, confirmationMessageId: event.messageId });
    });
  }
  const canMessageTeam = actor.id === "basem" && actor.role === "admin" && event.groupId === null;
  const pendingCommand = canMessageTeam && pending && pending.expires_at > now ? JSON.parse(pending.command_json) : null;
  const input: SecretaryModelInput = { text: event.text, actor: { id: actor.id, name: actor.name, role: actor.role }, focusedTaskId, taskDraft: review ? null : taskDraft,
    ...(review ? { review: { previousQuestion: review.question, previousAnswer: review.previousAnswer } } : {}),
    canMessageTeam, messageRecipients: canMessageTeam ? getSecretaryOutboxRecipients(db, config).map(user => ({ id: user.userId, name: user.name })) : [],
    pendingMessagePreview: pendingCommand?.action === "message_team" && typeof pendingCommand.text === "string" && Array.isArray(pendingCommand.recipientIds) ? { text: pendingCommand.text, recipientIds: pendingCommand.recipientIds } : null,
    tasks: initial.tasks.map(t => ({ id: t.id, title: t.title, projectId: t.projectId, status: t.status, priority: t.priority })),
    projects: initial.projects.map(p => ({ id: p.id, name: p.name, status: p.status })), users: initial.users.filter(u => u.active === 1).map(u => ({ id: u.id, name: u.name })), history, now: new Date(now).toISOString(),
    pendingApprovals: safeApprovals(db, actor), rules: safeRules(db),
    personalContext: actor.id === "basem" && actor.role === "admin" && event.groupId === null ? personalMemory(db, actor.id) : [],
    learningMemory: event.groupId === null ? recallSecretaryMemory(db, { conversation: key, role: actor.role,
      query: review?.question || event.text, now,
      allowedScope: new Set([...initial.tasks.map(t => "t:" + t.id), ...initial.projects.map(p => "p:" + p.id)]) }) : [],
    knowledgeContext: event.groupId === null ? safeKnowledge(db, actor, review?.question || event.text)
      .slice(0, 3).map(hit => ({ title: hit.title, snippet: hit.snippet.slice(0, 600) })) : [] };
  const directCreation = !review && event.inputKind !== "voice" && !event.replyToMessageId ? directTaskCreationIntent(input) : null;
  // A bare color can answer an active creation question; explicit list requests switch topic.
  const readQuestion = review?.question || event.text;
  const priorityQuery = review ? priorityTaskQuery(readQuestion, input)
    : !event.replyToMessageId && (!taskDraft || /مهام|اعط|أعط|وريني|اعرض|اسرد/u.test(event.text)) ? priorityTaskQuery(event.text, input) : null;
  let plan: SecretaryIntent;
  const listText = event.text.normalize("NFKC").replace(/[أإآ]/g, "ا").replace(/[\u064B-\u065F\u0670ـ؟?!.،,]/g, "").replace(/\s+/g, " ").trim();
  const directTaskList = !review && !taskDraft && !event.replyToMessageId
    && /^(?:وريني|اعرض|اعرضلي|اعطيني|شو) المهام(?: المطلوبة| المطلوبه| المتاحة| المتاحه| الموجودة| الموجوده)?(?: كلها| جميعها)?(?: كمان مره| كمان مرة| مرة ثانية| مره ثانيه)?$/.test(listText);
  try {
    plan = priorityQuery ? emptySecretaryIntent(priorityQuery.kind === "clarify" ? "clarify" : "summary", priorityQuery.kind === "clarify" ? priorityQuery.reply : null)
      : directTaskList ? emptySecretaryIntent("summary") : directCreation ?? validateSecretaryIntent(await dependencies.infer(input), input);
  } catch (error) {
    // Only standalone, unqualified read questions may recover from provider failure.
    // Never reinterpret a write, project filter, quoted reply, or active intake.
    const generalTasks = event.text.normalize("NFKC").replace(/[أإآ]/g, "ا").replace(/[\u064B-\u065F\u0670ـ]/g, "").replace(/[؟?!.،,]/g, "").replace(/\s+/g, " ").trim();
    if (!review && !event.replyToMessageId && !taskDraft
      && /^(?:(?:شو|ايش|ما هي|اعرض|اعرضلي|وريني) )?(?:المهام(?: المطلوب[ةه]| المتاح[ةه]| الموجود[ةه])?|مهامي)(?: عندنا| عندي)?$/.test(generalTasks)) {
      plan = emptySecretaryIntent("summary");
    } else {
      if (!review) throw error;
      plan = emptySecretaryIntent("clarify", "ما قدرت أكمل مراجعة الجواب الآن، وما بدي أخمّن أو أكرر نتيجة غير مؤكدة. حدد النقطة المختلف عليها لنراجعها؛ لم أنفّذ أي تغيير.");
    }
  }
  // Independent of the provider validator: criticism never grants a write/replay.
  if (review && !["summary", "details", "projects", "report", "help", "chat", "clarify", "search", "message_status"].includes(plan.kind)) {
    plan = emptySecretaryIntent("clarify", "براجع الجواب معك؛ لم أنفّذ أو أعد إرسال أي طلب. اكتب التغيير المطلوب كطلب جديد إذا بدك تنفيذه.");
  }
  let publicReply: string | null = null;
  if (plan.kind === "search") {
    const query = readQuestion.trim(); // Exact current/prior user question, not plan.message.
    const internal = review ? [] : safeKnowledge(db, actor, query);
    if (internal.length) publicReply = `من قاعدة المعرفة الداخلية:\n\n${formatKnowledgeHits(internal)}\n\n(قل «ابحث على الإنترنت» إذا بدك مصادر عامة.)`;
    else if (privateSearchQuestion(query, initial)) publicReply = "هذا السؤال قد يتضمن معلومات داخلية؛ ما أرسلته لبحث عام. حدد المهمة أو المعلومة العامة المطلوبة بدون بيانات خاصة.";
    else if (!dependencies.search) publicReply = "البحث العام غير مفعّل حاليًا؛ ما عملت بحثًا. أقدر أراجع بيانات الموقع أو أوضح ما يلزم للتحقق.";
    else try { publicReply = await dependencies.search(query); }
    catch (error) {
      if (!review) throw error;
      publicReply = "حاولت البحث للتحقق من السؤال السابق، لكن البحث تعذّر؛ ما عندي مصدر أؤكد منه التصحيح الآن. لم أنفّذ أي تغيير.";
      plan = emptySecretaryIntent("clarify", publicReply);
    }
  }
  return transaction(db, () => {
    const freshActor = actorFor(db, event, config); if (!freshActor || JSON.stringify(freshActor) !== JSON.stringify(actor)) return { status: "denied", reply: "" };
    const state = stateFor(db, freshActor); const duplicate = lookup(db, event, freshActor, state); if (duplicate) return duplicate;
    if (fingerprint(state) !== initialHash) return save(db, event, freshActor, { status: "stale", reply: "تغيّرت بيانات العمل أثناء قراءة رسالتك. ما عدّلتها؛ أعد الطلب لأراجع آخر وضع." }, [], now);
    if (hash(intakeRow(db, key) ?? null) !== hash(storedIntake ?? null)) return save(db, event, freshActor, { status: "stale", reply: "تغيّرت مسودة المهمة أثناء قراءة رسالتك. لم أنشئ شيئًا؛ أعد آخر جواب لنكمل على التفاصيل الحالية." }, [], now);
    if ((plan.kind === "task_draft" || pendingDraft) && hash(db.prepare("SELECT * FROM secretary_pending WHERE conversation_key=?").get(key) ?? null) !== hash(pending ?? null)) return save(db, event, freshActor, { status: "stale", reply: "تغيّرت معاينة التأكيد أثناء قراءة رسالتك. لم أنشئ شيئًا؛ أعد التصحيح على المعاينة الحالية." }, [], now);
    if (review && event.groupId === null) rememberSecretaryMistake(db, { conversation: key, role: freshActor.role,
      question: review.question, answer: review.previousAnswer, now,
      scope: [...initial.tasks.map(t => "t:" + t.id), ...initial.projects.map(p => "p:" + p.id)] });
    rememberPendingPreview(db, event, key, db.prepare("SELECT * FROM secretary_pending WHERE conversation_key=?").get(key) as Pending | undefined);
    if (plan.kind === "task_draft") return taskIntake(db, event, freshActor, state, plan, key, taskDraft, now);
    // Only an explicit task_draft plan may continue intake; unrelated subjects cannot revive it later.
    if (!review) {
      if (storedIntake) db.prepare("DELETE FROM secretary_task_intake WHERE conversation_key=?").run(key);
      if (pendingDraft) db.prepare("DELETE FROM secretary_pending WHERE conversation_key=?").run(key);
      clearSecretaryChoices(db, key);
    }
    if (priorityQuery?.kind === "query") {
      const read = priorityReadReply(priorityQuery, state, now, readQuestion);
      return save(db, event, freshActor, read.result, read.scope, now);
    }
    if (plan.kind === "message_status") {
      try {
        const batch = getSecretaryOutboxStatus(db, { actor: freshActor, origin: { senderNumber: event.senderNumber, groupId: event.groupId } }, config);
        return save(db, event, freshActor, { status: "summary", ...(batch ? { batchId: batch.batchId } : {}), reply: batch ? `نتيجة آخر طلب إرسال وافقت عليه للتيم:\n${batch.recipients.map(user => `• ${clean(user.name, 80)}: ${secretaryOutboxDeliveryLabel(user)}`).join("\n")}\nإقرار خادم واتساب: ${batch.acceptedCount}؛ وصول للجهاز: ${batch.deliveredCount}؛ قراءة: ${batch.readCount}. نجاح محاولة النقل وحده لا يثبت الوصول أو القراءة.` : "ما في طلب إرسال للتيم وافقت عليه ومسجّل بعد." }, [], now);
      } catch(error) { if (!(error instanceof SecretaryOutboxError)) throw error; return save(db, event, freshActor, { status: "clarify", reply: error.message }, [], now); }
    }
    if (plan.kind === "command" || plan.kind === "remind" || plan.kind === "message_team") db.prepare("DELETE FROM secretary_pending WHERE conversation_key=?").run(key);
    if (plan.kind === "message_team") {
      try {
        const preview = createSecretaryOutboxPreview(db, { actor: freshActor, origin: { senderNumber: event.senderNumber, groupId: event.groupId },
          sourceMessageId: eventKey(event), text: plan.fields.body || "", recipientIds: plan.recipientIds[0] === "all-team" ? "all-team" : plan.recipientIds }, config, { now });
        const token = "T" + randomBytes(3).toString("hex").toUpperCase();
        const reply = `${event.inputKind === "voice" ? "فهمت من الصوت الطلب التالي:\n" : ""}رح أرسل من رقم الإدارة لكل موظف لحاله على الخاص، وليس على الجروب.\nالمستلمون: ${preview.recipients.map(user => user.name).join("، ")}\n\nالنص الذي سيُرسل:\n${preview.text}\n\nلم أرسل شيئًا بعد. اكتب «موافق ${token}» أو رد بالموافقة مباشرة على هذه المعاينة؛ وللتراجع اكتب «إلغاء». التأكيد صالح 10 دقائق.`;
        if (reply.length > 3700) return save(db, event, freshActor, { status: "clarify", reply: "المعاينة طويلة؛ اختصر نص الرسالة أو اختر عددًا أقل من المستلمين حتى أعرضها كاملة قبل التأكيد." }, [], now);
        const command = { action: "message_team", batchId: preview.batchId, text: preview.text, recipientIds: preview.recipients.map(user => user.userId) };
        db.prepare("INSERT INTO secretary_pending VALUES(?,?,?,?,?,?,?)").run(key, token, JSON.stringify(command), initialHash, event.text, event.messageId, now + CONFIRM_MS);
        log(db, freshActor, event, "secretary_message_preview", { summary: "عرض رسالة للتيم قبل الإرسال", batchId: preview.batchId, recipientIds: preview.recipients.map(user => user.userId), confirmationRequired: true }, now);
        return save(db, event, freshActor, { status: "confirmation", batchId: preview.batchId, reply }, [], now);
      } catch(error) { if (!(error instanceof SecretaryOutboxError)) throw error; return save(db, event, freshActor, { status: "clarify", reply: error.message }, [], now); }
    }
    if (AGENT_KINDS.has(plan.kind)) {
      db.prepare("DELETE FROM secretary_pending WHERE conversation_key=?").run(key);
      const result = handleAgentIntent(plan, { db, actor: freshActor, now, inputKind: event.inputKind, suppressNotices: event.groupId === null && /(?:لا|ما)\s+(?:تبعت|تبعث|ترسل)|بدون\s+(?:رسائل|إشعارات|اشعارات)/u.test(event.text), users: state.users, tasks: state.tasks, projects: state.projects,
        stash: command => { const token = "T" + randomBytes(3).toString("hex").toUpperCase(); db.prepare("INSERT INTO secretary_pending VALUES(?,?,?,?,?,?,?)").run(key, token, JSON.stringify(command), initialHash, event.text, event.messageId, now + CONFIRM_MS); log(db, freshActor, event, "secretary_proposal", { summary: "عرض تغييرًا ينتظر التأكيد", proposedCommand: command, confirmationRequired: true }, now); return token; } });
      if (result) { deliverAgentSideEffects(db, freshActor, result, now); return save(db, event, freshActor, { status: result.status, reply: result.reply, ...(result.taskId ? { taskId: result.taskId } : {}) }, result.taskId ? ["t:" + result.taskId] : [], now); }
    }
    if (plan.kind === "command") {
      const command = commandFrom(plan, state);
      if (freshActor.id !== "basem" && !["claim", "cancel_claim", "comment", "submit"].includes(String(command.action))) return save(db, event, freshActor, { status: "denied", reply: "هذا القرار من صلاحيات باسم. أقدر أساعدك بتحديث مهامك أو إرسالها للمراجعة." }, [], now);
      if (SENSITIVE.has(String(command.action)) || event.inputKind === "voice") {
        const token = "T" + randomBytes(3).toString("hex").toUpperCase();
        db.prepare("INSERT INTO secretary_pending VALUES(?,?,?,?,?,?,?)").run(key, token, JSON.stringify(command), initialHash, event.text, event.messageId, now + CONFIRM_MS);
        const scope = [...(plan.taskId ? ["t:" + plan.taskId] : []), ...(plan.projectId ? ["p:" + plan.projectId] : [])];
        log(db, freshActor, event, "secretary_proposal", { summary: "عرض تغييرًا ينتظر التأكيد", proposedCommand: command, confirmationRequired: true }, now);
        return save(db, event, freshActor, { status: "confirmation", reply: `${event.inputKind === "voice" ? `فهمت من الصوت: «${clean(event.text, 450)}»\n` : ""}للتأكيد قبل التنفيذ:\n${commandDescription(command, state)}\n\nاكتب «موافق ${token}» للتنفيذ أو «إلغاء». الطلب صالح 10 دقائق ولن يُنفّذ إذا تغيّرت بياناته.`, ...(plan.taskId ? { taskId: plan.taskId } : {}) }, scope, now);
      }
      return perform(db, event, freshActor, state, command, now, { originalText: event.text, sourceMessageId: event.messageId, confirmationRequired: false });
    }
    if (plan.kind === "remind") {
      const task = state.tasks.find(t => t.id === plan.taskId); const due = Date.parse(plan.fields.remindAt || "");
      if (!task || !Number.isFinite(due) || due < now + 60_000 || due > now + 90 * 86400_000 || !/(?:Z|[+-]\d{2}:\d{2})$/.test(plan.fields.remindAt || "")) return save(db, event, freshActor, { status: "clarify", reply: "حدد المهمة وموعد التذكير بالتاريخ والساعة بتوقيت عمّان/الرياض." }, [], now);
      if (event.inputKind === "voice") {
        const token = "T" + randomBytes(3).toString("hex").toUpperCase();
        db.prepare("INSERT INTO secretary_pending VALUES(?,?,?,?,?,?,?)").run(key, token, JSON.stringify({ action: "schedule_reminder", taskId: task.id, dueAt: due }), initialHash, event.text, event.messageId, now + CONFIRM_MS);
        return save(db, event, freshActor, { status: "confirmation", reply: `فهمت من الصوت: «${clean(event.text, 450)}»\nأجدول تذكيرًا عن «${clean(task.title)}» في ${new Intl.DateTimeFormat("ar-JO", { timeZone: "Asia/Amman", dateStyle: "medium", timeStyle: "short" }).format(due)}؟\nاكتب «موافق ${token}» أو «إلغاء».` }, ["t:" + task.id], now);
      }
      return reminder(db, event, freshActor, state, task.id, due, now);
    }
    if (plan.kind === "chat" || plan.kind === "clarify" || plan.kind === "search") {
      let reply = publicReply || plan.message || "أي مهمة أو مشروع تقصد، وشو المطلوب؟";
      if (plan.kind === "chat" || plan.kind === "clarify") reply = formatSecretaryProjectHeadings(safeConversationalReply(reply), state);
      // The planner explicitly identifies contextual replies; an unrelated topic has no focus.
      const contextTaskId = plan.kind !== "search" && state.tasks.some(task => task.id === plan.taskId) ? plan.taskId : null;
      return save(db, event, freshActor, { status: plan.kind === "clarify" ? "clarify" : "summary", reply, ...(contextTaskId ? { taskId: contextTaskId } : {}) }, plan.kind !== "search" ? [...state.tasks.map(t => "t:" + t.id), ...state.projects.map(p => "p:" + p.id)] : [], now);
    }
    const read = readReply(plan, freshActor, state, now); return save(db, event, freshActor, read.result, read.scope, now);
  });
}
function perform(db: DatabaseSync, event: Event, actor: ChatUser, state: Snapshot, command: Record<string, unknown>, now: number, context: Record<string, unknown>): Result {
  try {
    const result = executeManagementAction(db, actor, command as ManagementCommand, { now, source: "whatsapp_secretary", auditContext: { ...context, senderNumber: event.senderNumber, origin: "whatsapp", proposedCommand: command } });
    const taskId = typeof command.taskId === "string" ? command.taskId : result.entityType === "task" ? result.entityId : undefined;
    if (taskId) db.prepare("UPDATE secretary_reminders SET responded_at=? WHERE actor_id=? AND task_id=? AND group_id IS ? AND state='sent' AND responded_at IS NULL").run(now, actor.id, taskId, event.groupId);
    const scope = [...(taskId && state.tasks.some(t => t.id === taskId) && command.action !== "delete_task" ? ["t:" + taskId] : []), ...(typeof command.projectId === "string" && command.action !== "delete_project" ? ["p:" + command.projectId] : [])];
    // File blobs from confirmed deletions remain recoverable on disk; DB links are removed atomically.
    return save(db, event, actor, { status: "applied", reply: `✅ ${result.message}`, ...(taskId ? { taskId } : {}) }, scope, now);
  } catch (error) {
    if (!(error instanceof ManagementActionError)) throw error;
    return save(db, event, actor, { status: "clarify", reply: error.message }, [], now);
  }
}

function safeApprovals(db: DatabaseSync, actor: ChatUser) {
  try { return listApprovals(db, actor, { status: "pending", limit: 20 }).map(a => ({ id: a.id, type: a.type, summary: a.summary, requestedBy: a.requestedByName })); } catch { return []; }
}
function safeRules(db: DatabaseSync) {
  try { return activeRules(db).slice(0, 30).map(rule => ({ id: rule.id, statement: rule.statement })); } catch { return []; }
}
function safeKnowledge(db: DatabaseSync, actor: ChatUser, query: string) {
  try { return searchKnowledge(db, actor, query, 3); } catch { return []; }
}
/** Private notifications and group notices produced by agent actions go to the durable queue; the bridge delivers them. */
function deliverAgentSideEffects(db: DatabaseSync, actor: ChatUser, result: AgentResult, now: number) {
  for (const item of result.notify ?? []) if (item.userId !== actor.id) enqueueAgentMessage(db, { toUser: item.userId, text: item.text }, now);
  if (result.groupNotice) enqueueAgentMessage(db, { toUser: "group", text: result.groupNotice }, now);
}


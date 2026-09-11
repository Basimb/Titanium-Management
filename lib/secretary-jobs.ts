/** Durable, explicit user-requested reminders. No model, credentials or browser state. */
import type { DatabaseSync } from "node:sqlite";
import { getManagementSnapshot, isManagementAdmin } from "./management-actions.ts";
import { resolveChatUser, type ChatUser, type ChatContact } from "./team-chat-policy.ts";
type Config = { enabled: boolean; contacts: ChatContact[]; allowedGroupIds: string[] };
type Reminder = { id: string; actor_id: string; sender_number: string; group_id: string | null; task_id: string; due_at: number; reply_message_id: string };
export function createSecretaryJobs({ db, config, now = Date.now }: { db: DatabaseSync; config: Config | (() => Config); now?: () => number }) {
  let running = false;
  function current() { return typeof config === "function" ? config() : config; }
  function resolve(row: Reminder) {
    const cfg = current(); if (!cfg.enabled) return null;
    const actor = resolveChatUser({ senderNumber: row.sender_number, groupId: row.group_id }, cfg.contacts,
      db.prepare("SELECT id,name,role,active FROM users").all() as ChatUser[], cfg.allowedGroupIds);
    if (!actor || actor.id !== row.actor_id) return null;
    const snapshot = getManagementSnapshot(db, actor); const task = snapshot.tasks.find(t => t.id === row.task_id);
    if (!task || task.archivedAt || task.status === "completed") return null;
    if (!isManagementAdmin(actor) && task.owner !== actor.name && task.suggestedOwner !== actor.name) return null;
    const clean = (text: string) => text.replace(/[\x00-\x1f\u202a-\u202e\u2066-\u2069]/g, " ").slice(0, 180);
    return { to: row.group_id || `${row.sender_number}@s.whatsapp.net`,
      text: `⏰ يا ${clean(actor.name)}، هذا التذكير الذي طلبته:\n*${clean(task.title)}*\nاحكيلي شو صار معك؛ أقدر أسجّل تحديثك على المهمة.\nhttps://www.management.titanium-pharmacy.com/?task=${encodeURIComponent(task.id)}`,
      messageId: row.reply_message_id };
  }
  return { async deliverNext(send: (message: { to: string; text: string; messageId: string; signal: AbortSignal }) => Promise<unknown>) {
    if (running || !current().enabled || !db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='secretary_reminders'").get()) return { status: "idle" as const };
    running = true;
    try {
      // An interrupted/ambiguous delivery is never automatically sent again.
      db.prepare("UPDATE secretary_reminders SET state='failed' WHERE state='sending' AND sending_at<=?").run(now() - 60_000);
      const row = db.prepare("SELECT * FROM secretary_reminders WHERE state='pending' AND due_at<=? ORDER BY due_at,id LIMIT 1").get(now()) as Reminder | undefined;
      if (!row) return { status: "idle" as const };
      const delivery = resolve(row);
      if (!delivery || now() - row.due_at > 86400_000) { db.prepare("UPDATE secretary_reminders SET state='cancelled' WHERE id=? AND state='pending'").run(row.id); return { status: "failed" as const }; }
      const claimed = db.prepare("UPDATE secretary_reminders SET state='sending',sending_at=? WHERE id=? AND state='pending'").run(now(), row.id);
      if (Number(claimed.changes) !== 1) return { status: "idle" as const };
      try {
        const latest = resolve(row); if (!latest) throw new Error("authorization_changed");
        const controller = new AbortController(); let timeout: ReturnType<typeof setTimeout> | undefined;
        try { await Promise.race([send({ ...latest, signal: controller.signal }), new Promise<never>((_, reject) => { timeout = setTimeout(() => { controller.abort(); reject(new Error("delivery_uncertain")); }, 15000); })]); }
        finally { clearTimeout(timeout); }
        db.prepare("UPDATE secretary_reminders SET state='sent',sent_at=? WHERE id=? AND state='sending'").run(now(), row.id);
        return { status: "sent" as const };
      } catch {
        db.prepare("UPDATE secretary_reminders SET state='failed' WHERE id=? AND state='sending'").run(row.id);
        return { status: "failed" as const };
      }
    } finally { running = false; }
  } };
}

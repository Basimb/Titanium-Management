import { DatabaseSync } from 'node:sqlite';
import { enqueueAgentMessage } from './lib/agent-followups.ts';

const db = new DatabaseSync(process.env.DB);
const now = Date.now();
const CANCEL = "✖️ ولا إشي — ألغِ الطلب";
const users = db.prepare("SELECT id,name FROM users WHERE active=1").all();
const idFor = name => (users.find(u => u.name === name) || {}).id;

const tasks = db.prepare(
  "SELECT id,title,suggested_owner AS owner FROM tasks WHERE archived_at IS NULL AND status='open' AND owner IS NULL AND suggested_owner IS NOT NULL"
).all();

let sent = 0;
for (const t of tasks) {
  const userId = idFor(t.owner);
  if (!userId) { console.log('SKIP (no user): ' + t.owner + ' / ' + t.title); continue; }
  const base = 'TSK' + t.id;
  const choices = { id: 'TSKQ' + t.id, title: "شو بدك تعمل بهالمهمة؟",
    expiresAt: now + 24 * 60 * 60 * 1000,
    options: [
      { id: base + 'CLAIM', label: "👋 استلمت المهمة" },
      { id: base + 'TRANSFER', label: "🔄 حوّلها لحدا غيري" },
      { id: base + 'EDIT', label: "🔧 غيّر الأولوية" },
      { id: base + 'NONE', label: CANCEL },
    ] };
  const text = "📌 عيّن لك باسم مهمة «" + t.title.slice(0, 200)
    + "». اضغط «استلمت المهمة» لبدء التنفيذ.";
  enqueueAgentMessage(db, { toUser: userId, text, choices }, now + sent);
  console.log('QUEUED -> ' + t.owner + ' : ' + t.title);
  sent += 1;
}
console.log('queued ' + sent + ' claim requests.');

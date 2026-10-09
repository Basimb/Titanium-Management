import { DatabaseSync } from 'node:sqlite';
import { lstatSync, realpathSync, chmodSync } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { groupJid, withAbortSignal } from './group-privacy.mjs';

export const GROUP_INTRO = 'أهلًا، أنا سكرتير فريق إدارة تيتانيوم الذكي 👋\n\nأساعدكم في إنشاء المشاريع والمهام، وشرح المطلوب، وتسجيل تحديثاتكم، والتذكير بالموعد الذي تطلبونه، والبحث عن المعلومات.\n\nأتعرف على كل عضو من رقم هاتفه المسجّل وأتعامل معه حسب صلاحياته. باسم، صاحب الرقم المنتهي بـ981، هو صاحب الصلاحية العليا.\n\nلا تحتاجون إلى حفظ أوامر محددة؛ احكوا معي بطريقتكم الطبيعية. وإذا لم أفهم المقصود بدقة، بسألكم قبل أي تغيير. التغييرات الحساسة، وأي تعديل من رسالة صوتية، أعرضها للتأكيد قبل التنفيذ.\n\nيمكنكم أن تسألوني مثلًا:\n• شو مهامي؟\n• اشرحلي المهمة.\n• خلصت المهمة.\n• سجل هذا تعليق.\n• شو المتأخر عليّ؟\n• اعرض آخر تحديث.\n• ابحثلي عن…\n• ذكّرني بالمهمة بكرا الساعة 10.\n\nردودي هنا يشاهدها أعضاء الجروب. لا ترسلوا رموز الدخول أو كلمات المرور أو بيانات المرضى. للرسائل الصوتية: مقطع واضح لا يتجاوز دقيقة.';

export function openControl(directory, { now = Date.now } = {}) {
  if (!path.isAbsolute(directory) || realpathSync(directory) !== path.resolve(directory)) throw new Error('invalid_control_directory');
  const dirStat = lstatSync(directory);
  if (!dirStat.isDirectory() || dirStat.isSymbolicLink() ||
    (process.platform !== 'win32' && (dirStat.mode & 0o777) !== 0o700)) throw new Error('invalid_control_directory');
  const filename = path.join(directory, 'control.sqlite');
  try {
    const stat = lstatSync(filename);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('invalid_control_file');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const db = new DatabaseSync(filename);
  if (process.platform !== 'win32') chmodSync(filename, 0o600);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS control_jobs (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, target TEXT NOT NULL, state TEXT NOT NULL,
      created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, started_at INTEGER,
      result TEXT, dedupe_key TEXT UNIQUE, message_id TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS privacy_alerts (id TEXT PRIMARY KEY, attempted_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS voice_requests (id TEXT PRIMARY KEY,actor_hash TEXT NOT NULL,created_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS control_pending ON control_jobs(state,created_at);`);
  const publicJob = row => row ? { id: row.id, kind: row.kind, state: row.state,
    ...(row.result ? { result: JSON.parse(row.result) } : {}) } : null;
  return {
    close: () => db.close(),
    reserveVoice(body) {
      const id = createHash('sha256').update(JSON.stringify([body.senderNumber,body.groupId,body.messageId])).digest('hex');
      const actor = createHash('sha256').update(body.senderNumber).digest('hex');
      db.exec('BEGIN IMMEDIATE');
      try {
        const total = db.prepare('SELECT count(*) AS n FROM voice_requests WHERE created_at>?').get(now()-60000).n;
        const own = db.prepare('SELECT count(*) AS n FROM voice_requests WHERE actor_hash=? AND created_at>?').get(actor,now()-60000).n;
        const duplicate = db.prepare('SELECT id FROM voice_requests WHERE id=?').get(id);
        if (total >= 12 || own >= 3 || duplicate) { db.exec('COMMIT'); return false; }
        db.prepare('INSERT INTO voice_requests VALUES(?,?,?)').run(id,actor,now());
        db.exec('COMMIT'); return true;
      } catch(error) { db.exec('ROLLBACK'); throw error; }
    },
    // Only called by the single running bridge, never a status-reading CLI.
    recover() { db.prepare("UPDATE control_jobs SET state='failed',result=? WHERE state='running'")
      .run(JSON.stringify({ reason: 'interrupted_no_automatic_retry' })); },
    request(kind, target) {
      if (!['discover', 'status', 'intro'].includes(kind) || typeof target !== 'string' ||
        (kind === 'discover' ? !target.trim() || target.length > 100 || /[\u0000-\u001F\u007F]/.test(target) : !groupJid(target))) {
        throw new Error('invalid_control_request');
      }
      const at = now();
      const dedupe = kind === 'intro' ? createHash('sha256').update(`intro-v1:${target}`).digest('hex') : null;
      const previous = dedupe && db.prepare('SELECT * FROM control_jobs WHERE dedupe_key=?').get(dedupe);
      if (previous) return publicJob(previous);
      if (db.prepare('SELECT count(*) AS count FROM control_jobs WHERE created_at>?').get(at - 3_600_000).count >= 20 ||
        db.prepare("SELECT count(*) AS count FROM control_jobs WHERE state IN ('queued','running')").get().count >= 20) {
        throw new Error('control_rate_limited');
      }
      const id = randomUUID();
      db.prepare('INSERT INTO control_jobs(id,kind,target,state,created_at,expires_at,dedupe_key,message_id) VALUES(?,?,?,\'queued\',?,?,?,?)')
        .run(id, kind, target.trim().normalize('NFC'), at, at + 300_000, dedupe, `TITANIUMCTRL${id.replaceAll('-', '').toUpperCase()}`);
      return publicJob(db.prepare('SELECT * FROM control_jobs WHERE id=?').get(id));
    },
    get(id) {
      if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id)) throw new Error('invalid_job_id');
      return publicJob(db.prepare('SELECT * FROM control_jobs WHERE id=?').get(id));
    },
    claim() {
      db.exec('BEGIN IMMEDIATE');
      try {
        db.prepare("UPDATE control_jobs SET state='failed',result=? WHERE state='queued' AND expires_at<=?")
          .run(JSON.stringify({ reason: 'expired' }), now());
        const row = db.prepare("SELECT * FROM control_jobs WHERE state='queued' ORDER BY created_at,id LIMIT 1").get();
        if (row) db.prepare("UPDATE control_jobs SET state='running',started_at=? WHERE id=?").run(now(), row.id);
        db.exec('COMMIT');
        return row || null;
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    },
    finish(id, result, ok = true) {
      const value = JSON.stringify(result);
      if (value.length > 8000) throw new Error('control_result_too_large');
      db.prepare("UPDATE control_jobs SET state=?,result=? WHERE id=? AND state='running'").run(ok ? 'done' : 'failed', value, id);
    },
    reservePrivacyAlert(group, sender) {
      if (!groupJid(group) || !/^[1-9]\d{7,14}$/.test(sender)) return false;
      const id = createHash('sha256').update(`${group}:${sender}`).digest('hex');
      return db.prepare(`INSERT INTO privacy_alerts(id,attempted_at) VALUES(?,?) ON CONFLICT(id) DO UPDATE
        SET attempted_at=excluded.attempted_at WHERE privacy_alerts.attempted_at<=?`).run(id, now(), now() - 3_600_000).changes === 1;
    },
  };
}

export async function processControlJob({ control, socket, config, inspectGroup, sendGroup, now = Date.now }) {
  const job = control.claim();
  if (!job) return false;
  const signal = AbortSignal.timeout(15_000);
  try {
    if (now() >= job.expires_at) throw new Error();
    if (job.kind === 'discover') {
      // All metadata is transient; persist only exact-subject matches and safe counts.
      const groups = await withAbortSignal(() => socket.groupFetchAllParticipating(), signal);
      if (!groups || typeof groups !== 'object' || Object.keys(groups).length > 2000) throw new Error();
      const matches = Object.values(groups).filter(group => typeof group?.subject === 'string' &&
        group.subject.trim().normalize('NFC') === job.target);
      if (matches.length > 10) throw new Error();
      const results = [];
      for (const group of matches) {
        const inspection = await withAbortSignal(() => inspectGroup(group.id, false), signal);
        results.push({ groupId: group.id, subject: job.target, ...inspection });
      }
      control.finish(job.id, { matches: results });
    } else if (job.kind === 'status') {
      if (!config.allowedGroups.has(job.target)) { control.finish(job.id, { reason: 'group_not_allowlisted' }, false); return true; }
      control.finish(job.id, { groupId: job.target, ...await withAbortSignal(() => inspectGroup(job.target), signal) });
    } else if (job.kind === 'intro') {
      if (!config.allowedGroups.has(job.target) || config.tasksEnabled === false) throw new Error();
      // No automatic retry after an ambiguous send. The same intro is deduplicated forever.
      await withAbortSignal(() => sendGroup(job.target, GROUP_INTRO, job.message_id, signal), signal);
      control.finish(job.id, { groupId: job.target, accepted: true });
    }
  } catch { control.finish(job.id, { reason: 'unavailable_or_privacy_blocked_no_automatic_retry' }, false); }
  return true;
}

export function runControlCli(args = process.argv.slice(2), output = console) {
  let control;
  try {
    if (args.length !== 3) throw new Error();
    const [directory, command, target] = args;
    control = openControl(directory);
    const result = command === 'result' ? control.get(target) : control.request(command, target);
    output.info(JSON.stringify(result));
    return 0;
  } catch { output.error('Private group control request could not proceed. No account session was opened or changed.'); return 1; }
  finally { control?.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) process.exitCode = runControlCli();

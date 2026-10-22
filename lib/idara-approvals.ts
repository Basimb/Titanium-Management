/**
 * IDARA approvals from the phone (Basim, 2026-10-11: «الموافقه من موقع
 * الموافقات او من الجوال»).
 *
 * IDARA (titanium-pharmacy.com/idara) queues a WhatsApp message for every new
 * approval request, carrying a poll whose option ids are IDA<id>Y / IDA<id>N /
 * IDA<id>I. A tap on one of those -- or a short typed «طلباتي» -- is answered
 * here, before the secretary sees it, by asking IDARA's approvals gateway
 * (idara/apvbot.php). IDARA decides everything: who may decide what, whether
 * the phone is linked, and the Odoo write itself, run under the decider's own
 * personal Odoo key. This file only signs the request and turns the answer
 * into a reply and a poll. Anything that is not an IDARA tap or command
 * returns null and goes to the secretary exactly as before.
 */
import { createHmac } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";

const GATEWAY = "https://titanium-pharmacy.com/idara/apvbot.php";
const KEY_FILE = "/home/titani24/qa_data/idara_botkey.txt";
const POLL_MS = 23 * 60 * 60_000;

type Body = { senderNumber?: string; groupId?: string | null; text?: string; choice?: { questionId?: string; optionId?: string } };
type Poll = { kind: "decide"; id: number } | { kind: "pick"; opts: Array<{ id: number; label: string }> } | { kind: "filter"; opts: Array<{ f: string; label: string }> };
type Choices = { id: string; title: string; expiresAt: number; options: Array<{ id: string; label: string }> };

const norm = (s: string) => s.replace(/[ً-ْـ]/g, "").replace(/[أإآ]/g, "ا").replace(/ة/g, "ه").replace(/ى/g, "ي").replace(/\s+/g, " ").trim();
const COMMANDS: Record<string, string> = {
  "طلباتي": "all", "موافقاتي": "all", "الموافقات": "all", "طلبات الموافقه": "all", "طلبات الموافقات": "all",
  "طلبات المشتريات": "purch", "طلبات الموردين": "purch", "طلبات المورد": "purch",
  "طلبات المواد": "prod", "طلبات كروت المواد": "prod", "كروت المواد": "prod",
};
const label = (s: string) => s.replace(/[\r\n\t]+/g, " ").trim().slice(0, 95);

function decidePoll(id: number, at: number): Choices {
  return { id: `IDAQ${id}`, title: `قرارك على الطلب #${id}؟`, expiresAt: at + POLL_MS,
    options: [{ id: `IDA${id}Y`, label: "✅ موافق" }, { id: `IDA${id}N`, label: "❌ رفض" }, { id: `IDA${id}I`, label: "📋 التفاصيل" }] };
}
function toChoices(poll: Poll | undefined, at: number): Choices | undefined {
  if (!poll) return undefined;
  if (poll.kind === "decide" && Number.isSafeInteger(poll.id)) return decidePoll(poll.id, at);
  if (poll.kind === "pick" && poll.opts?.length >= 2) return { id: "IDAPK", title: "أي طلب بدك تقرر فيه؟", expiresAt: at + POLL_MS,
    options: poll.opts.slice(0, 10).map(o => ({ id: `IDL${o.id}`, label: label(o.label) })) };
  if (poll.kind === "filter" && poll.opts?.length >= 1) {
    const options = poll.opts.slice(0, 8).filter(o => /^[a-z]{2,10}$/.test(o.f)).map(o => ({ id: `IDF${o.f}`, label: label(o.label) }));
    options.push({ id: "IDFall", label: "📋 كل الطلبات" });
    return options.length >= 2 ? { id: "IDAFQ", title: "أي طلبات بدك تشوف؟", expiresAt: at + POLL_MS, options } : undefined;
  }
  return undefined;
}

/** What the tap or text asks IDARA for, or null when it is not ours. */
function intent(body: Body): { act: string; id?: number; flt?: string } | null {
  if (body.groupId) return null;
  const opt = body.choice?.optionId ?? "";
  let m = /^IDA(\d{1,9})([YNI])$/.exec(opt);
  if (m) return { act: m[2] === "Y" ? "ok" : m[2] === "N" ? "no" : "show", id: Number(m[1]) };
  m = /^IDL(\d{1,9})$/.exec(opt);
  if (m) return { act: "show", id: Number(m[1]) };
  m = /^IDF([a-z]{2,10})$/.exec(opt);
  if (m) return { act: "list", flt: m[1] };
  if (body.choice) return null;
  const t = norm(String(body.text ?? ""));
  if (t.length > 25) return null;
  const f = COMMANDS[t];
  return f ? { act: "list", flt: f } : null;
}

function userIdFor(number: string): string | null {
  try {
    const cfg = JSON.parse(readFileSync(process.env.TITANIUM_TEAM_CHAT_CONFIG || "/home/titani24/.titanium-team-chat/config.json", "utf8"));
    const contacts = JSON.parse(cfg.TEAM_CHAT_CONTACTS_JSON || "[]") as Array<{ userId: string; number: string }>;
    const clean = (n: string) => String(n).replace(/\D/g, "").replace(/^00/, "");
    return contacts.find(c => clean(c.number) === clean(number))?.userId ?? null;
  } catch { return null; }
}

function reply(text: string, choices?: Choices): Response {
  return new Response(JSON.stringify({ status: "ok", reply: text.slice(0, 3900), ...(choices ? { choices } : {}) }),
    { status: 200, headers: { "content-type": "application/json", "cache-control": "private, no-store" } });
}

/** Answer an IDARA tap/command, or return null to let the secretary handle the message. */
export async function idaraIntercept(init: RequestInit, now = Date.now): Promise<Response | null> {
  let body: Body;
  try { body = JSON.parse(String(init.body ?? "")); } catch { return null; }
  // Amin's approval polls (Basim 2026-10-13: «اي طلب موافقه لاي احد يجي بنظام التصويت»).
  // Option ids AMN<question>_<Y|N>: the tap is recorded for Amin, nothing is executed here.
  // Training arena daily question (Basim 2026-10-15): option ids TRN<n><A-D>. Recorded only; IDARA grades it.
  const tr = /^TRN(\d{1,9})([ABCD])$/.exec(body.choice?.optionId ?? "");
  if (tr && !body.groupId) {
    const who = userIdFor(String(body.senderNumber ?? ""));
    if (!who) return reply("ما قدرت أعرف رقمك.");
    try {
      appendFileSync("/home/titani24/qa_data/idara_training/votes.jsonl",
        JSON.stringify({ at: now(), uid: who, n: Number(tr[1]), v: tr[2] }) + "\n");
    } catch { return reply("⚠️ ما قدرت أسجّل جوابك — جرّب كمان مرة."); }
    return reply("✅ وصل جوابك. النتيجة والشرح بيوصلوك بعد شوي.");
  }
  const am = /^AMN([A-Za-z0-9]{1,60})_([YN])$/.exec(body.choice?.optionId ?? "");
  if (am && !body.groupId) {
    const who = userIdFor(String(body.senderNumber ?? ""));
    if (!who) return reply("ما قدرت أعرف رقمك.");
    try {
      appendFileSync("/home/titani24/qa_data/amin/votes.jsonl",
        // src:"wa" marks a vote that really came from a WhatsApp poll tap (Basim 22/10: approvals count only these).
        JSON.stringify({ at: now(), uid: who, q: am[1], v: am[2], src: "wa" }) + "\n");
    } catch { return reply("⚠️ ما قدرت أسجّل تصويتك — احكيه لأمين كتابة."); }
    return reply(am[2] === "Y" ? "✅ تمام، انسجّلت موافقتك. أمين بكمّل." : "❌ تمام، انسجّل الرفض. ما رح يتنفّذ إشي.");
  }
  const want = intent(body);
  if (!want) return null;
  const uid = userIdFor(String(body.senderNumber ?? ""));
  if (!uid) return reply("ما قدرت أعرف رقمك.");
  let key = "";
  try { key = readFileSync(KEY_FILE, "utf8").trim(); } catch { key = ""; }
  if (key.length < 32) return reply("الموافقة من الجوال مش مفعّلة لسا — قرّر من صفحة الموافقات باللوحة.");
  const raw = JSON.stringify({ uid, ...want });
  const ts = String(now());
  try {
    const res = await fetch(GATEWAY, { method: "POST", body: raw, redirect: "error", signal: AbortSignal.timeout(70_000),
      headers: { "content-type": "application/json", "x-idara-ts": ts, "x-idara-sig": createHmac("sha256", key).update(`${ts}\n${raw}`).digest("hex") } });
    const text = await res.text();
    if (text.length > 16_000) return reply("⚠️ رد IDARA طويل — افتح صفحة الموافقات.");
    const j = JSON.parse(text) as { ok?: boolean; reply?: string; poll?: Poll };
    if (typeof j.reply !== "string" || !j.reply) return reply("⚠️ ما وصل رد واضح من IDARA — الطلب ما انلمس. قرّر من صفحة الموافقات.");
    return reply(j.reply, toChoices(j.poll, now()));
  } catch {
    // A timeout can follow a decision IDARA already made: say so, never "nothing happened".
    return reply("⚠️ ما تأكدت من رد IDARA. افتح صفحة الموافقات وشوف حالة الطلب قبل ما تعيد.");
  }
}

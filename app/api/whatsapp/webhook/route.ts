import { db } from "@/lib/titanium-server";
import { BASIM_WHATSAPP, ensureWhatsAppTables, normalizeWhatsAppNumber, sendWhatsAppText, verifyMetaSignature } from "@/lib/whatsapp";

type IncomingMessage = { id?:string; from?:string; type?:string; text?:{body?:string} };

export async function GET(request:Request) {
  const url = new URL(request.url);
  const mode = url.searchParams.get("hub.mode");
  const token = url.searchParams.get("hub.verify_token");
  const challenge = url.searchParams.get("hub.challenge");
  if (mode === "subscribe" && token && token === process.env.META_WA_VERIFY_TOKEN) return new Response(challenge || "", { status:200 });
  return new Response("Forbidden", { status:403 });
}

export async function POST(request:Request) {
  if (process.env.WHATSAPP_ENABLED !== "1") return Response.json({ ok:true, skipped:"whatsapp_disabled" });
  const raw = await request.text();
  if (!verifyMetaSignature(raw, request.headers.get("x-hub-signature-256"))) return new Response("Invalid signature", { status:401 });
  try {
    const payload = JSON.parse(raw) as {entry?:Array<{changes?:Array<{value?:{messages?:IncomingMessage[]}}>}>};
    const messages = payload.entry?.flatMap(entry => entry.changes?.flatMap(change => change.value?.messages || []) || []) || [];
    for (const message of messages) await processMessage(message);
    return Response.json({ ok:true });
  } catch (error) {
    return Response.json({ error:error instanceof Error ? error.message : "Invalid webhook" }, { status:400 });
  }
}


// The Meta Cloud API path no longer executes management commands. The private
// bridge + secretary (app/api/whatsapp/team-chat) is the single conversational
// entry point. This webhook keeps signature verification, deduplication and the
// Meta-required data-deletion flow; every other inbound message is redirected.
async function processMessage(message:IncomingMessage) {
  if (!message.id || message.type !== "text" || !message.text?.body) return;
  const sender = normalizeWhatsAppNumber(message.from || "");
  const body = message.text.body.trim();
  await ensureWhatsAppTables();
  const inserted = await db().prepare("INSERT OR IGNORE INTO whatsapp_messages (message_id, sender, body, processed_at, result) VALUES (?, ?, ?, ?, '')")
    .bind(message.id, sender, body, Date.now()).run();
  if (inserted.meta.changes === 0) return;
  if (isDeletionRequest(body)) {
    const acknowledgement = "✅ تم استلام طلب حذف بياناتك. سيراجعه مدير النظام ويؤكد النتيجة عبر نفس الرقم.";
    await db().prepare("UPDATE whatsapp_messages SET result = 'deletion_request_received' WHERE message_id = ?").bind(message.id).run();
    const notifications:Promise<unknown>[] = [sendWhatsAppText(sender, acknowledgement)];
    if (BASIM_WHATSAPP) notifications.push(sendWhatsAppText(BASIM_WHATSAPP, `🗑️ طلب حذف بيانات WhatsApp من الرقم: ${sender}`));
    await Promise.allSettled(notifications);
    return;
  }
  if (sender !== BASIM_WHATSAPP) {
    await db().prepare("UPDATE whatsapp_messages SET result = 'ignored_non_admin' WHERE message_id = ?").bind(message.id).run();
    return;
  }
  await db().prepare("UPDATE whatsapp_messages SET result = 'redirected_to_secretary' WHERE message_id = ?").bind(message.id).run();
  await sendWhatsAppText(sender, "هذا الرقم للإشعارات فقط. راسل سكرتير باسم على رقم الإدارة الخاص لإدارة المشاريع والمهام.");
}

function isDeletionRequest(value:string) {
  const normalized = value.trim().toLowerCase().replace(/\s+/g, " ");
  return normalized === "حذف بياناتي" || normalized === "delete my data" || normalized === "حذف بياناتي | delete my data";
}

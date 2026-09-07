import { createHmac, timingSafeEqual } from "node:crypto";
import { SecretaryProviderError } from "./secretary-intent.ts";
import type { DatabaseSync } from "node:sqlite";
import { inferWhatsAppIntent, type IntentInput, type ParsedIntent } from "./whatsapp-intent.ts";
import { normalizeContactNumber, type ChatContact } from "./team-chat-policy.ts";
import { applyTeamChatIntent, getTeamChatCatalog, lookupTeamChatEvent, migrateTeamChatStore } from "./team-chat-store.ts";
import { resolveChatUser, type ChatUser } from "./team-chat-policy.ts";

export type TeamChatConfig = {
  enabled: boolean;
  sharedKey: string;
  contacts: ChatContact[];
  allowedGroupIds: string[];
};

const RESPONSE_HEADERS = { "cache-control": "private, no-store", "cdn-cache-control": "no-store" };
const MAX_BODY_BYTES = 16_384;
const MAX_MESSAGE_AGE = 10 * 60_000;
const MAX_SIGNATURE_AGE = 5 * 60_000;
const response = (body: unknown, status = 200) => Response.json(body, { status, headers: RESPONSE_HEADERS });

export function teamChatConfigFromEnv(env: Record<string, string | undefined> = process.env): TeamChatConfig {
  const disabled = { enabled: false, sharedKey: "", contacts: [], allowedGroupIds: [] };
  if (env.TEAM_CHAT_ENABLED !== "1") return disabled;
  try {
    const sharedKey = env.TEAM_CHAT_SHARED_KEY ?? "";
    const contacts: unknown = JSON.parse(env.TEAM_CHAT_CONTACTS_JSON ?? "[]");
    const groups: unknown = JSON.parse(env.TEAM_CHAT_GROUP_IDS_JSON ?? "[]");
    if (!/^[a-f0-9]{64}$/i.test(sharedKey) || !Array.isArray(contacts) || !contacts.length || contacts.length > 200
      || contacts.some(c => !c || typeof c !== "object" || typeof c.userId !== "string" || !c.userId.trim()
        || c.userId.length > 100 || typeof c.number !== "string" || !normalizeContactNumber(c.number))
      || new Set(contacts.map(c => normalizeContactNumber(c.number))).size !== contacts.length
      || !Array.isArray(groups) || groups.length > 50
      || groups.some(g => typeof g !== "string" || !/^\d+(?:-\d+)?@g\.us$/.test(g))) return disabled;
    return { enabled: true, sharedKey, contacts: contacts as ChatContact[], allowedGroupIds: groups as string[] };
  } catch { return disabled; }
}

export function signTeamChatBody(rawBody: string, timestamp: string, sharedKey: string): string {
  return createHmac("sha256", Buffer.from(sharedKey, "hex")).update(`${timestamp}\n${rawBody}`).digest("hex");
}

export function verifyTeamChatSignature(rawBody: string, headers: Headers, sharedKey: string, now: number): boolean {
  const timestamp = headers.get("x-titanium-chat-timestamp") ?? "";
  const signature = headers.get("x-titanium-chat-signature") ?? "";
  if (!/^[a-f0-9]{64}$/i.test(sharedKey) || !/^\d{13}$/.test(timestamp) || !/^[a-f0-9]{64}$/i.test(signature)
    || Math.abs(now - Number(timestamp)) > MAX_SIGNATURE_AGE) return false;
  return timingSafeEqual(Buffer.from(signature, "hex"), Buffer.from(signTeamChatBody(rawBody, timestamp, sharedKey), "hex"));
}

async function boundedBody(request: Request): Promise<string> {
  if (Number(request.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) throw new Error("body");
  if (!request.body) throw new Error("body");
  const reader = request.body.getReader();
  const pieces: Uint8Array[] = [];
  let total = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      new Promise<never>((_, reject) => { timer = setTimeout(() => { void reader.cancel().catch(() => {}); reject(new Error("timeout")); }, 10_000); }),
      (async () => {
        for (;;) {
          const item = await reader.read();
          if (item.done) break;
          total += item.value.byteLength;
          if (total > MAX_BODY_BYTES) { await reader.cancel(); throw new Error("body"); }
          pieces.push(item.value);
        }
        return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(pieces));
      })(),
    ]);
  } finally { clearTimeout(timer); }
}

export type TeamChatEnvelope = {
  messageId: string;
  senderNumber: string;
  groupId: string | null;
  text: string;
  receivedAt: number;
  replyToMessageId?: string | null;
  responseMessageId?: string | null;
  inputKind?: "text" | "voice";
  choice?: { questionId: string; optionId: string };
};

function envelope(value: unknown): TeamChatEnvelope | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (Object.keys(v).some(key => !["groupId", "messageId", "receivedAt", "senderNumber", "text", "replyToMessageId", "responseMessageId", "inputKind", "choice"].includes(key))
    || (v.inputKind !== undefined && v.inputKind !== "text" && v.inputKind !== "voice")
    || ["replyToMessageId", "responseMessageId"].some(key => v[key] != null && (typeof v[key] !== "string" || !/^[A-Za-z0-9._:@-]{1,160}$/.test(v[key] as string)))
    || typeof v.messageId !== "string" || !/^[A-Za-z0-9._:@-]{1,160}$/.test(v.messageId)
    || typeof v.senderNumber !== "string" || !/^[1-9]\d{7,14}$/.test(v.senderNumber)
    || !(v.groupId === null || (typeof v.groupId === "string" && /^\d+(?:-\d+)?@g\.us$/.test(v.groupId)))
    || typeof v.text !== "string" || !v.text.trim() || v.text.length > 2000
    || !Number.isSafeInteger(v.receivedAt) || Number(v.receivedAt) <= 0) return null;
  if (v.choice !== undefined) {
    // Choice IDs are authenticated transport data, not free text for an LLM.
    // Only the secretary can resolve them against its current actor-bound question.
    if (!v.choice || typeof v.choice !== "object" || Array.isArray(v.choice)
      || v.groupId !== null || v.inputKind === "voice" || v.replyToMessageId != null) return null;
    const choice = v.choice as Record<string, unknown>;
    if (Object.keys(choice).length !== 2 || Object.keys(choice).some(key => !["questionId", "optionId"].includes(key))
      || [choice.questionId, choice.optionId].some(id => typeof id !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(id))) return null;
  }
  return v as TeamChatEnvelope;
}

// Low-cost abuse/quota guard, in addition to authenticated transport and sender authorization.
// This is per process; deployments with multiple app workers need an upstream shared rate limiter.
const quota = new Map<string, { minute: number; count: number }>();
function allowedQuota(actorId: string, now: number): boolean {
  const minute = Math.floor(now / 60_000);
  for (const [key, value] of quota) if (value.minute !== minute) quota.delete(key);
  if ((quota.get("*all")?.count ?? 0) >= 20 || (quota.get(actorId)?.count ?? 0) >= 8) return false;
  for (const key of ["*all", actorId]) quota.set(key, { minute, count: (quota.get(key)?.count ?? 0) + 1 });
  return true;
}

export async function handleTeamChatRequest(request: Request, dependencies: {
  config: TeamChatConfig;
  getDatabase: () => DatabaseSync;
  infer?: (input: IntentInput) => Promise<ParsedIntent>;
  now?: () => number;
  secretary?: (database: DatabaseSync, event: TeamChatEnvelope, config: TeamChatConfig) => Promise<{ status: string; reply: string; taskId?: string }>;
}): Promise<Response> {
  const { config } = dependencies;
  if (!config.enabled) return response({ error: "Team chat is not enabled." }, 503);
  if (request.method !== "POST") return response({ error: "Method not allowed." }, 405);
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") return response({ error: "JSON required." }, 415);
  let rawBody: string;
  try { rawBody = await boundedBody(request); } catch { return response({ error: "Invalid request body." }, 400); }
  const now = (dependencies.now ?? Date.now)();
  if (!verifyTeamChatSignature(rawBody, request.headers, config.sharedKey, now)) return response({ error: "Unauthorized." }, 401);
  let event: TeamChatEnvelope | null;
  try { event = envelope(JSON.parse(rawBody)); } catch { event = null; }
  if (!event) return response({ error: "Invalid message." }, 400);
  if (event.choice && !dependencies.secretary) return response({ error: "Interactive choices are unavailable." }, 400);
  const origin = { senderNumber: event.senderNumber, groupId: event.groupId };
  try {
    const sqlite = dependencies.getDatabase();
    if (dependencies.secretary) {
      const actor = resolveChatUser(origin, config.contacts, sqlite.prepare("SELECT id,name,role,active FROM users").all() as ChatUser[], config.allowedGroupIds);
      if (!actor) return response({ status: "denied", reply: "" }, 403);
      if (event.receivedAt > now + 60_000 || now - event.receivedAt > MAX_MESSAGE_AGE) return response({ error: "Message is too old or has invalid time." }, 400);
      if (!allowedQuota(actor.id, now)) return response({ error: "Please retry shortly." }, 429);
      const result = await dependencies.secretary(sqlite, event, config);
      return response(result, result.status === "denied" && !result.reply ? 403 : 200);
    }
    migrateTeamChatStore(sqlite);
    const eventKey = { messageId: event.messageId, origin, text: event.text };
    const previous = lookupTeamChatEvent(sqlite, eventKey, config);
    if (previous) return response(previous, previous.status === "denied" ? 403 : 200);
    if (event.receivedAt > now + 60_000 || now - event.receivedAt > MAX_MESSAGE_AGE) return response({ error: "Message is too old or has invalid time." }, 400);
    const catalog = getTeamChatCatalog(sqlite, origin, config);
    if (!catalog.ok) return response({ status: "denied", reply: "" }, 403);
    if (!allowedQuota(catalog.actor.id, now)) return response({ error: "Please retry shortly." }, 429);
    // Only server-scoped task identifiers and titles reach the model. No phone numbers,
    // employee contacts, login secrets, arbitrary query or browser state are included.
    const intent = await (dependencies.infer ?? inferWhatsAppIntent)({
      text: event.text,
      tasks: catalog.tasks.map(t => ({ id: t.id, title: t.title, projectName: t.projectName, status: t.status, dueDate: t.dueDate })),
      history: [],
    });
    const result = applyTeamChatIntent(sqlite, { ...eventKey, intent, catalog }, config);
    return response(result, result.status === "denied" ? 403 : 200);
  } catch (error) {
    if (error instanceof SecretaryProviderError) {
      console.warn("secretary_provider_failure", error.code);
      if (error.retryAfterSeconds) return new Response(JSON.stringify({ error: error.code }), { status: 503,
        headers: { ...RESPONSE_HEADERS, "content-type": "application/json", "retry-after": String(error.retryAfterSeconds) } });
      return response({ status: "unavailable", reply: "ما قدرت أفهم الطلب بشكل موثوق، وما نفّذت تغييرًا. وضّح المطلوب بجملة ثانية." });
    }
    // Never leak DB paths, provider credentials, employee text, or provider responses.
    return response({ error: "Message could not be processed. No success is being claimed." }, 503);
  }
}


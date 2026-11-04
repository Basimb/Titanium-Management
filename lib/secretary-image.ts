/**
 * باسم 04/11/2026: «الصوره بتنقرأ وبتربطها بالموضوع اللي قاعد الموظف بيحكي وبتعطي رد على اساسه».
 * صورة بعتها موظف لأمين على الخاص ← Claude بيقرأها (وصف قصير بالعربي) ← الوصف بيدخل لأمين كأنه جزء من
 * رسالة الموظف، فبيربطه بالمحادثة وبيرد عليه. الوصف بينحفظ جنب الصورة (<الصورة>.desc.txt) عشان إعادة
 * المحاولة تعطي نفس النص بالزبط. قراءة بس: ما بيبعت الصورة لأي مكان غير Claude.
 */
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";

const MEDIA = /^\/home\/titani24\/\.titanium-team-chat\/media\/\d{8,15}\/[A-Za-z0-9_-]{1,80}\.(jpg|jpeg|png|webp)$/;
export function isStaffImagePath(value: unknown): value is string { return typeof value === "string" && MEDIA.test(value); }

const PROMPT = "هاي صورة بعتها موظف بصيدليات تيتانيوم لأمين على الواتساب. اكتب بالعربي وباختصار (4 أسطر بالكثير) شو فيها بالزبط: "
  + "اسم الصنف أو المنتج والتركيز والحجم، الباركود أو أي أرقام ظاهرة، تاريخ الانتهاء، وإذا هي شاشة سيستم أو فاتورة أو رف اكتب المهم فيها "
  + "(الكميات، الأسعار، رسالة الخطأ). اكتب الأرقام بالإنجليزي. لا تخمّن إشي مش ظاهر بالصورة.";

export async function describeStaffImage(path: string, caption: string, fetcher: typeof fetch = fetch): Promise<string> {
  if (!isStaffImagePath(path) || !existsSync(path)) return "";
  const cache = `${path}.desc.txt`;
  try { if (existsSync(cache)) return readFileSync(cache, "utf8").trim(); } catch { /* اقرأ من جديد */ }
  if (statSync(path).size > 4_500_000) return "";
  let key = "", model = "claude-sonnet-5-5";
  try {
    key = String(JSON.parse(readFileSync("/home/titani24/.config/amin-council/credentials.json", "utf8"))?.claude || "");
    const p = JSON.parse(readFileSync("/home/titani24/qa_data/amin/secretary_provider.json", "utf8"));
    if (typeof p?.model === "string" && p.model.startsWith("claude")) model = p.model;
  } catch { /* بدون مفتاح ما في قراءة */ }
  if (!key) return "";
  const ext = path.split(".").pop()!.toLowerCase();
  const mediaType = ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : "image/jpeg";
  const response = await fetcher("https://api.anthropic.com/v1/messages", {
    method: "POST", signal: AbortSignal.timeout(40_000),
    headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model, max_tokens: 600, messages: [{ role: "user", content: [
      { type: "image", source: { type: "base64", media_type: mediaType, data: readFileSync(path).toString("base64") } },
      { type: "text", text: PROMPT + (caption ? `\nالكلام اللي كتبه الموظف مع الصورة: «${caption.slice(0, 500)}»` : "") },
    ] }] }),
  });
  if (!response.ok) return "";
  const data = await response.json() as { content?: Array<{ type: string; text?: string }> };
  const text = (data.content || []).filter(b => b.type === "text").map(b => b.text || "").join("\n").trim().slice(0, 1200);
  if (text) { try { writeFileSync(cache, text, { mode: 0o600 }); } catch { /* الوصف بيرجع بكل الأحوال */ } }
  return text;
}

/** نص الرسالة اللي بيوصل أمين: كلام الموظف (إن وجد) + شو بالصورة. */
export function imageMessageText(caption: string, description: string): string {
  const said = caption && caption !== "صورة" ? `${caption}\n\n` : "";
  return (said + (description ? `[بعتلي صورة. اللي فيها: ${description}]` : "[بعتلي صورة بس ما قدرت أقرأها]")).slice(0, 2000);
}

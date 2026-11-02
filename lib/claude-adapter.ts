/**
 * باسم 02/11/2026 («4 نعم»): أمين بينتقل لـ Claude لأنه رصيد OpenAI خلص.
 *
 * كل أجزاء أمين (العقل، فهم أسئلة الأرقام، البحث الحر بأودو، البحث بالإنترنت)
 * مكتوبة على صيغة OpenAI وبتقبل `fetcher` بدل fetch. هاد الملف هو الـ fetcher:
 * بياخد نفس الطلب اللي كان رايح لـ OpenAI، بيترجمه لـ Anthropic Messages API،
 * وبيرجّع الرد بنفس شكل رد OpenAI بالزبط — فما في ولا سطر بباقي الكود بيتغيّر.
 *
 *   /v1/chat/completions  ← رسائل + أدوات (tool calling) + json_object
 *   /v1/responses         ← البحث بالإنترنت (web_search) ← أداة web_search تبعت Claude
 *
 * الأخطاء: 429 بيضل 429 (مع retry-after)، و529 (Claude مضغوط) بيصير 503،
 * فمنطق إعادة المحاولة الموجود بيشتغل زي ما هو.
 */
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const VERSION = "2023-06-01";

type Json = any;

function json(status: number, body: unknown, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...extra } });
}

/** رسائل OpenAI ← رسائل Anthropic (system لحاله، والأدوار المتتالية بتندمج). */
export function toAnthropicMessages(messages: Json[]): { system: string; messages: Json[] } {
  const sys: string[] = [];
  const out: Json[] = [];
  const push = (role: "user" | "assistant", blocks: Json[]) => {
    const last = out[out.length - 1];
    if (last && last.role === role) last.content.push(...blocks);
    else out.push({ role, content: blocks });
  };
  for (const m of Array.isArray(messages) ? messages : []) {
    if (!m || typeof m !== "object") continue;
    if (m.role === "system" || m.role === "developer") {
      if (typeof m.content === "string") sys.push(m.content);
      else if (Array.isArray(m.content)) for (const p of m.content) if (p && typeof p.text === "string") sys.push(p.text);
      continue;
    }
    if (m.role === "tool") {
      push("user", [{ type: "tool_result", tool_use_id: String(m.tool_call_id || ""),
        content: typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "") }]);
      continue;
    }
    const blocks: Json[] = [];
    if (typeof m.content === "string" && m.content) blocks.push({ type: "text", text: m.content });
    else if (Array.isArray(m.content)) for (const p of m.content) if (p && typeof p.text === "string" && p.text) blocks.push({ type: "text", text: p.text });
    if (m.role === "assistant" && Array.isArray(m.tool_calls)) {
      for (const c of m.tool_calls) {
        let input: Json = {};
        try { input = JSON.parse(c?.function?.arguments || "{}"); } catch { input = {}; }
        blocks.push({ type: "tool_use", id: String(c?.id || ""), name: String(c?.function?.name || ""), input });
      }
    }
    if (blocks.length) push(m.role === "assistant" ? "assistant" : "user", blocks);
  }
  if (!out.length || out[0].role !== "user") out.unshift({ role: "user", content: [{ type: "text", text: "." }] });
  return { system: sys.join("\n\n"), messages: out };
}

/** أدوات OpenAI (function) ← أدوات Anthropic (input_schema). علامة strict ما إلها مقابل وبتنشال. */
export function toAnthropicTools(tools: Json[]): Json[] {
  return (Array.isArray(tools) ? tools : [])
    .filter(t => t && t.type === "function" && t.function && typeof t.function.name === "string")
    .map(t => ({ name: t.function.name, description: String(t.function.description || ""),
      input_schema: t.function.parameters && typeof t.function.parameters === "object" ? t.function.parameters : { type: "object", properties: {} } }));
}

/* موديلات Claude الجديدة ما بتقبل tool_choice من نوع any/tool، ولا temperature.
   فالإجبار على أداة بيصير بتعليمات بالـ system، ولو رجع نص بدل أداة بنعيد مرة وحدة بتذكير. */
function toolChoice(tc: Json, parallel: Json): Json {
  const one = parallel === false ? { disable_parallel_tool_use: true } : {};
  if (tc === "none") return { type: "none" };
  return { type: "auto", ...one };
}
function forcedTool(tc: Json): { forced: boolean; name: string | null } {
  if (tc === "required") return { forced: true, name: null };
  if (tc && typeof tc === "object" && tc.function && typeof tc.function.name === "string") return { forced: true, name: tc.function.name };
  return { forced: false, name: null };
}

function stripFences(s: string): string {
  return s.replace(/^\s*```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();
}

async function anthropic(key: string, req: Json, signal?: AbortSignal | null): Promise<{ ok: boolean; status: number; data: Json; retryAfter: string | null }> {
  const r = await fetch(ANTHROPIC_URL, {
    method: "POST", redirect: "error", ...(signal ? { signal } : {}),
    headers: { "x-api-key": key, "anthropic-version": VERSION, "content-type": "application/json" },
    body: JSON.stringify(req),
  });
  const data = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, data, retryAfter: r.headers.get("retry-after") };
}

function errorResponse(status: number, data: Json, retryAfter: string | null): Response {
  const extra: Record<string, string> = {};
  if (retryAfter) extra["retry-after"] = retryAfter;
  return json(status === 529 ? 503 : status, { error: { code: String(data?.error?.type || "anthropic_error"), message: String(data?.error?.message || "").slice(0, 300) } }, extra);
}

/** /v1/chat/completions بصيغة OpenAI. */
export async function claudeChat(key: string, model: string, body: Json, signal?: AbortSignal | null): Promise<Response> {
  const { system, messages } = toAnthropicMessages(body?.messages);
  const tools = toAnthropicTools(body?.tools);
  const jsonMode = !!body?.response_format && (body.response_format.type === "json_object" || body.response_format.type === "json_schema");
  const req: Json = {
    model, messages,
    max_tokens: Math.max(16, Math.min(8000, Number(body?.max_completion_tokens || body?.max_tokens || 1024))),
  };
  const force = tools.length ? forcedTool(body?.tool_choice) : { forced: false, name: null };
  const forceLine = force.forced
    ? (force.name ? `\n\nYou MUST respond by calling the tool "${force.name}" exactly once. Never answer with plain text.`
                  : "\n\nYou MUST respond by calling exactly ONE of the provided tools. Never answer with plain text; put any reply text inside the tool's arguments.")
    : "";
  const sys = system + (jsonMode ? "\n\nReply with ONE JSON object only. No prose, no code fences." : "") + forceLine;
  if (sys.trim()) req.system = sys;
  if (tools.length) { req.tools = tools; req.tool_choice = toolChoice(body?.tool_choice, body?.parallel_tool_calls); }
  let r = await anthropic(key, req, signal);
  if (!r.ok) return errorResponse(r.status, r.data, r.retryAfter);
  let blocks: Json[] = Array.isArray(r.data?.content) ? r.data.content : [];
  if (force.forced && !blocks.some(b => b && b.type === "tool_use")) {
    /* رجع نص بدل أداة — مرة وحدة بس بنذكّره */
    const said = blocks.filter(b => b && b.type === "text").map(b => String(b.text || "")).join("").trim();
    const retry = { ...req, messages: [...req.messages,
      ...(said ? [{ role: "assistant", content: [{ type: "text", text: said }] }] : []),
      { role: "user", content: [{ type: "text", text: force.name ? `Call the tool "${force.name}" now.` : "Respond now by calling exactly one of the tools." }] }] };
    r = await anthropic(key, retry, signal);
    if (!r.ok) return errorResponse(r.status, r.data, r.retryAfter);
    blocks = Array.isArray(r.data?.content) ? r.data.content : [];
  }
  const text = blocks.filter(b => b && b.type === "text").map(b => String(b.text || "")).join("");
  const calls = blocks.filter(b => b && b.type === "tool_use")
    .map(b => ({ id: String(b.id), type: "function", function: { name: String(b.name), arguments: JSON.stringify(b.input ?? {}) } }));
  const message: Json = { role: "assistant", content: calls.length ? (text || null) : (jsonMode ? stripFences(text) : text) };
  if (calls.length) message.tool_calls = calls;
  const finish = calls.length ? "tool_calls" : r.data?.stop_reason === "max_tokens" ? "length" : "stop";
  return json(200, { id: r.data?.id, object: "chat.completion", model, choices: [{ index: 0, message, finish_reason: finish }], usage: r.data?.usage });
}

/** /v1/responses مع web_search بصيغة OpenAI ← أداة web_search تبعت Claude، والمصادر بترجع url_citation. */
export async function claudeWebSearch(key: string, model: string, body: Json, signal?: AbortSignal | null): Promise<Response> {
  const input: Json[] = Array.isArray(body?.input) ? body.input : [];
  const system = input.filter(m => m && m.role === "system").map(m => String(m.content || "")).join("\n");
  const user = input.filter(m => m && m.role === "user").map(m => String(m.content || "")).join("\n") || String(body?.input || "");
  const req: Json = {
    model, max_tokens: Math.max(64, Math.min(4000, Number(body?.max_output_tokens || 900))),
    messages: [{ role: "user", content: user }],
    tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 3 }],
  };
  if (system.trim()) req.system = system;
  const r = await anthropic(key, req, signal);
  if (!r.ok) return errorResponse(r.status, r.data, r.retryAfter);
  const blocks: Json[] = Array.isArray(r.data?.content) ? r.data.content : [];
  let text = ""; const annotations: Json[] = [];
  for (const b of blocks) {
    if (!b || b.type !== "text") continue;
    text += String(b.text || "");
    for (const c of Array.isArray(b.citations) ? b.citations : [])
      if (c && c.type === "web_search_result_location" && typeof c.url === "string")
        annotations.push({ type: "url_citation", url: c.url, title: typeof c.title === "string" ? c.title : c.url });
  }
  return json(200, { id: r.data?.id, object: "response", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text, annotations }] }] });
}

/**
 * بديل fetch لكل نداءات OpenAI: نفس العنوان والطلب، والرد بنفس الشكل — بس من Claude.
 * المفتاح والموديل من هون، مش من الطلب (اللي ممكن يكون مكتوب فيه gpt-4o).
 */
export function claudeFetcher(key: string, model: string): typeof fetch {
  const f = async (url: unknown, init?: Json): Promise<Response> => {
    let body: Json = {};
    try { body = JSON.parse(typeof init?.body === "string" ? init.body : "{}"); } catch { return json(400, { error: { code: "bad_request", message: "invalid JSON body" } }); }
    const signal = init?.signal ?? null;
    try {
      if (String(url).endsWith("/v1/responses")) return await claudeWebSearch(key, model, body, signal);
      return await claudeChat(key, model, body, signal);
    } catch (error) {
      if ((error as Json)?.name === "AbortError" || (error as Json)?.name === "TimeoutError") throw error;
      return json(503, { error: { code: "anthropic_transport", message: "Claude unreachable" } }, { "retry-after": "30" });
    }
  };
  return f as unknown as typeof fetch;
}

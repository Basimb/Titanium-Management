/** Pure read-request parsing. The caller must supply scoped catalogs and recheck visibility. */
export type PriorityTaskQuery = { kind: "query"; priority: "red" | "yellow" | "green"; ownerId?: string;
  status?: "open" | "progress" | "approval" | "completed" | "overdue"; offset?: number } | { kind: "clarify"; reply: string };
type Catalog = { users: Array<{ id: string; name: string; active?: number | boolean }>;
  actor: { id: string; role: string; name?: string } };
const normalize = (text: string) => text.normalize("NFKC").replace(/[\u064b-\u065f\u0670\u0640\ufe0f]/g, "")
  .replace(/[أإآ]/g, "ا").replace(/ى/g, "ي").replace(/ة/g, "ه").replace(/[٠-٩]/g, digit => String("٠١٢٣٤٥٦٧٨٩".indexOf(digit)))
  .replace(/[۰-۹]/g, digit => String("۰۱۲۳۴۵۶۷۸۹".indexOf(digit))).replace(/\s+/g, " ").trim().toLowerCase();
const colorPatterns = [
  ["red", /^(?:(?:ال)?(?:احمر|حمراء|حمرا|حمره|حمر|قصوي|عاليه)|red|🔴|🟥)(?=$|\s)/u],
  ["yellow", /^(?:(?:ال)?(?:اصفر|صفراء|صفرا|صفره|متوسطه)|yellow|🟡|🟨)(?=$|\s)/u],
  ["green", /^(?:(?:ال)?(?:اخضر|خضراء|خضرا|خضره|عاديه|منخفضه)|green|🟢|🟩)(?=$|\s)/u],
] as const;
const statusPatterns = [
  ["open", /^(?:المفتوحه|مفتوحه|بانتظار الاستلام)(?=$|\s)/u],
  ["progress", /^(?:قيد التنفيذ|الجاريه|جاريه)(?=$|\s)/u],
  ["approval", /^(?:بانتظار (?:اعتماد|موافقه|مراجعه)(?: باسم)?|للمراجعه)(?=$|\s)/u],
  ["completed", /^(?:المعتمده|معتمده|المكتمله|مكتمله|المنجزه|منجزه)(?=$|\s)/u],
  ["overdue", /^(?:المتاخره|متاخره)(?=$|\s)/u],
] as const;
const clarify = (reply = "أي قائمة تقصد بالضبط؟ حدد لونًا واحدًا، واسم المسؤول أو حالة المهمة إن أردت تصفيتها."): PriorityTaskQuery => ({ kind: "clarify", reply });
function consumeName(text: string, items: Array<{ id: string; name: string }>, markers: RegExp[]) {
  const matches: Array<{ id: string; length: number }> = [];
  let marked = false;
  for (const marker of markers) {
    const prefix = marker.exec(text); if (!prefix) continue;
    marked = true; const tail = text.slice(prefix[0].length);
    for (const item of items) for (const name of new Set([normalize(item.name), normalize(item.id)])) {
      if (name && (tail === name || tail.startsWith(name + " "))) matches.push({ id: item.id, length: prefix[0].length + name.length });
    }
  }
  if (!marked) return null;
  const longest = Math.max(0, ...matches.map(match => match.length));
  const exact = matches.filter(match => match.length === longest);
  const ids = [...new Set(exact.map(match => match.id))];
  return ids.length === 1 ? { id: ids[0], rest: text.slice(longest).trim() } : { id: null, rest: text };
}
export function priorityTaskQuery(text: string, catalog: Catalog): PriorityTaskQuery | null {
  if (typeof text !== "string" || text.length > 600 || /["'«»“”‘’`\x00-\x1f\u202a-\u202e\u2066-\u2069]/u.test(text)) return null;
  let value = normalize(text).replace(/[.!؟?]+$/u, "").trim();
  // Do not consume a negated, hypothetical, quoted or combined read-and-write request.
  if (/(?:^|\s)(?:و)?(?:لا|ما|مش|مو|لم|لن|اذا|لو(?! سمحت)|(?:احذف|امسح|عدل|غير|خلي|اجعل|اضف|ضيف|انشئ|اعتمد|ارشف|انقل|سجل|اكتب|ارسل|ابعث|نفذ|الغي)(?:ها|هم|ه)?)(?=$|\s)/u.test(value)) return null;
  value = value.replace(/^(?:لو سمحت|من فضلك)\s+/u, "");
  const request = /^(?:(?:اعطيني|اعطني|عطيني|هات|وريني|فرجيني|اعرض(?:لي| لي)?|بدي|اريد|قائمه)\s+)?(?:كل\s+)?(المهام|مهام|مهامي)\s+(.+)$/u.exec(value);
  let rest: string; let mine = false;
  if (request) { rest = request[2]; mine = request[1] === "مهامي"; }
  else if (/^و(?:ال|🔴|🟡|🟢|🟥|🟨|🟩)/u.test(value)) rest = value.slice(1);
  else return null;
  rest = rest.replace(/^(?:(?:ذات|ذوات)\s+)?(?:ال)?اولويه\s+/u, "");
  const first = colorPatterns.find(([, pattern]) => pattern.test(rest)); if (!first) return null;
  const result: Extract<PriorityTaskQuery, { kind: "query" }> = { kind: "query", priority: first[0], ...(mine ? { ownerId: catalog.actor.id } : {}) };
  rest = rest.replace(first[1], "").trim();
  const page = /(?:^|\s)(?:من|ابتداء من)\s+(?:رقم\s+)?(\d+)$/u.exec(rest);
  if (page) {
    const start = Number(page[1]); if (!Number.isSafeInteger(start) || start < 1 || start > 10000) return clarify("ابدأ برقم مهمة من 1 إلى 10000، مثل: المهام الحمراء من 11.");
    result.offset = start - 1; rest = rest.slice(0, page.index).trim();
  }
  while (rest) {
    rest = rest.replace(/^(?:و\s*|اللي\s+)/u, "").trim();
    if (!rest) return clarify();
    const color = colorPatterns.find(([, pattern]) => pattern.test(rest));
    if (color) {
      if (color[0] !== result.priority) return clarify("أي لون بدك أعرض: الأحمر، الأصفر، أم الأخضر؟ اختار لونًا واحدًا.");
      rest = rest.replace(color[1], "").trim(); continue;
    }
    const status = statusPatterns.find(([, pattern]) => pattern.test(rest));
    if (status) {
      if (result.status && result.status !== status[0]) return clarify("حدد حالة واحدة للمهام المطلوبة.");
      result.status = status[0]; rest = rest.replace(status[1], "").trim(); continue;
    }
    if (/^(?:لي|الي|عندي|الخاصه بي)(?=$|\s)/u.test(rest)) {
      if (result.ownerId && result.ownerId !== catalog.actor.id) return clarify("حدد مسؤولًا واحدًا للمهام المطلوبة.");
      result.ownerId = catalog.actor.id; rest = rest.replace(/^(?:لي|الي|عندي|الخاصه بي)/u, "").trim(); continue;
    }
    const owner = consumeName(rest, catalog.users.filter(user => user.active === undefined || user.active === 1 || user.active === true),
      [/^(?:للموظف|للمسؤول|المسؤول|عند|تبعت)\s+/u, /^المسنده (?:الي|ل)\s*/u, /^لـ?\s*/u]);
    if (owner) {
      if (!owner.id || (result.ownerId && result.ownerId !== owner.id)) return clarify("مين المسؤول المقصود؟ اكتب الاسم المحدد أو معرّفه إذا تكرر الاسم.");
      if (owner.id !== catalog.actor.id && !(catalog.actor.id === "basem" && catalog.actor.role === "admin")) return clarify("أقدر أعرض مهامك المتاحة إلك فقط، بدون مهام شخص آخر.");
      result.ownerId = owner.id; rest = owner.rest; continue;
    }
    return clarify(); // Never silently drop a date, exception or an unknown qualifier.
  }
  return result;
}

/** Read-only review routing. The caller must supply only authorized conversation
 * history/quotes, enforce read-only planning, and privacy-check any web query. */
export type SecretaryReviewHistory = readonly { role: "user" | "assistant"; content: string }[];
export type SecretaryReviewPair = { question: string; previousAnswer: string };
export type SecretaryReviewRequest = ({ kind: "review" } & SecretaryReviewPair) | { kind: "clarify"; reply: string };

export const SECRETARY_IDENTITY = "أنا سكرتير باسم، مساعده الافتراضي لمتابعة المهام والمشاريع والتواصل مع فريق العمل ضمن الصلاحيات المتاحة.";
const MISSING_CONTEXT = "أي جواب تقصد؟ اكتب سؤالك أو ردّ على الجواب نفسه حتى أراجعه بدقة.";
const MIXED_REQUEST = "براجع الجواب معك، لكن النقد وحده ما بينفّذ تعديلًا أو إرسالًا. حدّد المعلومة التي تريد مراجعتها؛ وأي تغيير نراجعه بطلب منفصل.";

function normalized(text: string): string {
  return text.normalize("NFKC").replace(/[\u064b-\u065f\u0670\u0640]/g, "")
    .replace(/[أإآ]/g, "ا").replace(/ى/g, "ي").replace(/ة/g, "ه").toLowerCase().trim();
}
function unquoted(text: string): string {
  return text.replace(/```[\s\S]*?```|`[^`\n]*`|«[^»]*»|“[^”]*”|"[^"\n]*"|'[^'\n]*'/gu, quoted => " ".repeat(quoted.length));
}
function visible(text: string): string {
  return normalized(unquoted(text)).replace(/^(?:(?:لا|يا اخي|ياخي|يا زلمه|اسمع|لو سمحت)[\s،,:؛-]+){0,3}/u, "");
}
function objection(text: string): boolean {
  const value = visible(text);
  if (/^(?:غلط|هيك غلط|هذا غلط|مش صحيح|غير صحيح|مش هيك)(?:[.!؟?\s]*$|[،,:؛.!؟?]\s*)/u.test(value)) return true;
  if (/^(?:راجع|صحح|دقق|تاكد من)\s+(?:جوابك|ردك|اجابتك|المعلومه|الجواب السابق|الرد السابق)(?=$|[\s.!؟?،,:؛])/u.test(value)) return true;
  return /^(?:(?:جوابك|ردك|اجابتك|كلامك|معلوماتك|المعلومه|الجواب(?: السابق)?|الرد(?: السابق)?|الاجابه(?: السابقه)?)\s+(?:غلط(?:انه)?|خاطئه?|خطا|غير\s+(?:صحيح|دقيق)ه?|مش\s+(?:صحيح|دقيق|مزبوط|مظبوط)ه?)|(?:انت\s+)?(?:فهمتني|فاهمني)\s+غلط|(?:انت\s+)?(?:ما|مش)\s+(?:فهمتني|فهمت علي|فاهمني|فاهم علي))(?=$|[\s.!؟?،,:؛])/u.test(value);
}
function executionRequest(text: string): boolean {
  const value = visible(text).replace(/(?:صحح|عدل|غير)\s+(?:جوابك|ردك|اجابتك|الجواب|الرد|الاجابه|المعلومه)(?=$|[\s.!؟?،,:؛])/gu, " ");
  // Do not let a mixed complaint fall through into the ordinary mutation path.
  return /(?:^|[\s،,:؛.!؟?])(?:و|ف)?(?:احذف|امسح|عدل|غير(?!\s+(?:صحيح|دقيق))|اعتمد|ارسل|ابعث|اضف|ضيف|انشئ|سجل|انقل|ارجع|الغ|ارشف|ذكرني|نفذ|استلم|اقفل|افتح)(?:ها|ه|هم|لي|لهم)?(?=$|[\s،,:؛.!؟?])/u.test(value);
}
function acknowledgement(text: string): boolean {
  return /^(?:تمام(?: شكرا)?|شكرا(?: الك)?|شكرا جزيلا|اوكي|اوك|حسنا|يسلمو|يعطيك العافيه)[.!؟?\s]*$/u.test(normalized(text));
}
function readQuestion(text: string): boolean {
  if (!text.trim() || text.length > 2000 || objection(text)) return false;
  const value = visible(text);
  // A question about how to do something is discussion; a separate imperative
  // after punctuation is not a safe question to re-plan from history.
  const separateInstruction = /[؟?؛;\n]\s*(?:و|ف)?(?:احذف|امسح|عدل|غير|اعتمد|ارسل|ابعث|اضف|ضيف|انشئ|سجل|انقل|ارجع|الغ|ارشف|ذكرني|نفذ|استلم|افتح|(?:and\s+)?(?:delete|remove|update|change|approve|send|create|move|assign|archive|reopen))(?:ها|ه|هم|لي|لهم)?(?=$|\s)/u.test(value);
  if (separateInstruction) return false;
  if (/^(?:شو|ايش|ماذا|كيف|ليش|لماذا|كم|هل|وين|اين|متي|مين|عندك|عندنا|معك|معنا|ما عندك|ما عندنا|من هو|من هي|ما\s+(?:هو|هي|معني|سبب|عدد|الفرق|فائده|اهميه|الافضل|السبب|المعني|العدد|انواع|مميزات|عيوب|مزايا|شروط|متطلبات|حقيقه|تفاصيل)|what|why|how|where|when|who|is|are)(?=$|[\s؟?])/u.test(value)) return true;
  if (executionRequest(text)) return false;
  return /^(?:بدي (?:اعرف|افهم|اشوف)|اريد (?:معرفه|ان اعرف|ان افهم)|خبرني|اشرح(?:لي| لي)?|وضح(?:لي| لي)?|فسر(?:لي| لي)?)(?=$|\s)/u.test(value)
    || /^(?:اعطيني|هات|وريني|اعرض|اسرد)\s+(?:معلومات|قائمه|تفاصيل|اسماء|حاله|تقرير|عدد|ملخص|اسعار|سعر|المهام|مهامي|المشاريع|مشاريعي|ارقام|الارقام)(?=$|\s)/u.test(value)
    || /^(?:المهام|مهامي|المشاريع|مشاريعي)(?=$|\s)/u.test(value);
}
function usablePair(pair: SecretaryReviewPair): boolean {
  return !!pair && typeof pair.question === "string" && typeof pair.previousAnswer === "string"
    && readQuestion(pair.question) && pair.previousAnswer.trim().length > 0 && pair.previousAnswer.length <= 4000;
}

export function secretaryReviewRequest(text: string, history: SecretaryReviewHistory, quotedPair?: SecretaryReviewPair | null): SecretaryReviewRequest | null {
  if (typeof text !== "string" || text.length > 2000 || !objection(text)) return null;
  if (executionRequest(text)) return { kind: "clarify", reply: MIXED_REQUEST };
  // Explicit scoped quotation wins. An unusable quotation never selects some
  // other historical question instead, nor turns a send into a new send.
  if (quotedPair != null) return usablePair(quotedPair)
    ? { kind: "review", question: quotedPair.question, previousAnswer: quotedPair.previousAnswer } : { kind: "clarify", reply: MISSING_CONTEXT };
  if (!Array.isArray(history)) return { kind: "clarify", reply: MISSING_CONTEXT };
  const recent = history.slice(-16);
  let latestReviewAnswer: string | null = null;
  for (let i = recent.length - 2; i >= 0; i--) {
    const user = recent[i], assistant = recent[i + 1];
    if (user?.role !== "user" || assistant?.role !== "assistant") continue;
    if (typeof user.content !== "string" || typeof assistant.content !== "string" || user.content.length > 2000 || assistant.content.length > 4000) break;
    if (objection(user.content)) {
      if (executionRequest(user.content)) break;
      latestReviewAnswer ??= assistant.content.trim() || null;
      i--; continue;
    }
    if (acknowledgement(user.content)) { i--; continue; }
    const pair = { question: user.content, previousAnswer: latestReviewAnswer || assistant.content };
    return usablePair(pair) ? { kind: "review", ...pair } : { kind: "clarify", reply: MISSING_CONTEXT };
  }
  return { kind: "clarify", reply: MISSING_CONTEXT };
}

export const getSecretaryReview = secretaryReviewRequest;

export function isSecretaryIdentityQuery(text: string): boolean {
  if (typeof text !== "string" || text.length > 200) return false;
  const value = normalized(unquoted(text)).replace(/^(?:مرحبا|هلا|اهلا|السلام عليكم)[\s،,:]+/u, "").replace(/[.!؟?]+$/u, "").trim();
  return /^(?:مين انت|انت مين|من انت|شو اسمك|ايش اسمك|ما اسمك|اسمك شو|عرفني عليك|عرف عن نفسك|مين السكرتير|شو اسم السكرتير|هل انت (?:شات جي بي تي|chatgpt)|انت (?:شات جي بي تي|chatgpt))$/u.test(value);
}


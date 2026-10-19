/**
 * Small language safeguards for NON-MUTATING conversational replies only.
 * These are not a semantic guarantee, authorization check, or command parser.
 * Actual execution acknowledgements must come from the committed action engine.
 */
export const CONVERSATION_NO_CHANGE_REPLY = "للتوضيح: ما نفّذت أي تغيير على المهام أو المشاريع في هذا الرد. احكيلي التغيير المطلوب حتى أراجعه معك.";

/** Exact cancellation of a pending conversation only; never a task deletion command. */
export function isConversationCancellation(text: string): boolean {
  const value = text.normalize('NFKC').replace(/[\u064b-\u065f\u0670\u0640]/g, '').replace(/[أإآ]/g, 'ا').replace(/ة/g, 'ه').replace(/[.!،؟?]+$/u, '').replace(/\s+/g, ' ').trim().toLowerCase();
  return /^(?:لا|لا شكرا|الغ|الغي|اللغي|الغيها|الغيه|اللغيها|الغاء|تراجع|وقف|وقفه|وقفها|اوقف|اوقفه|اوقفها|بلاش|cancel|no)(?: (?:الطلب|هالطلب|المسوده|مسوده المهمه|طلب المهمه))?$/.test(value);
}

function normalized(value: string): string {
  return value.normalize("NFKC").replace(/[\u064b-\u065f\u0670\u0640]/g, "")
    .replace(/[أإآ]/g, "ا").replace(/ى/g, "ي").toLowerCase();
}

function withoutQuotes(value: string): string {
  // Mask only balanced quotations/drafts, not the surrounding assertions.
  return value.replace(/```[\s\S]*?```|`[^`\n]*`|«[^»]*»|“[^”]*”|"[^"\n]*"|'[^'\n]*'/gu,
    quoted => quoted.replace(/[^\n]/g, " "));
}

const WORK_OBJECT = /مهم(?:ة|ه|ات)|مشروع|مشاريع|تعليق|تحديث|موعد|تذكير|مسؤول|مسئول|صلاحيات?|حساب|حال(?:ة|ه)|بيانات|انجاز|ارشيف/u;
const PAST_WRITE = /(?:^|[^\p{L}\p{N}_])((?:و|ف)?(?:اضفت|انشات|حذفت|مسحت|عدلت|غيرت|سجلت|اعتمدت|ارشفت|نقلت|جدولت|حدثت|عينت|الغيت|استرجعت|ارسلت|خلصتلك)(?:ها|ه|هم|لك|لكم)?)(?=$|[^\p{L}\p{N}_])/gu;
const PASSIVE_WRITE = /(?:^|\s)(?:تم|تمت)\s+(?:اضافة|انشاء|حذف|مسح|تعديل|تغيير|تسجيل|اعتماد|ارشفة|نقل|جدولة|تحديث|تعيين|الغاء|استرجاع|ارسال)(?=\s|$)/gu;

function deniedOrDiscussed(clause: string, verbIndex: number): boolean {
  // A contrast starts a new assertion: "لم أحذفها لكن أضفت التعليق".
  const before = clause.slice(0, verbIndex).split(/\bbut\b|\bhowever\b|(?:^|\s)(?:لكن|ولكن|بس)(?:\s|$)/u).at(-1) || "";
  if (/(?:^|\s)(?:ما|لم|لن|مش|مو|ليس|بدون)(?:\s|$)/u.test(before)) return true;
  if (/^\s*(?:هل|كيف|ليش|لماذا|متي|وين|اين|شو|ماذا|ايش)(?:\s|$)/u.test(clause)) return true;
  // A standalone question is not an execution acknowledgement.
  if (/[?؟]\s*$/.test(clause)) return true;
  if (/(?:انت قلت|قلتلي|قلت لي|مثال|صياغة|مسودة)\s*[:：]?\s*$/u.test(before)) return true;
  return false;
}

export function safeConversationalReply(text: string): string {
  const visible = normalized(withoutQuotes(text));
  // Commas separate an acknowledgement from a follow-up question/negation.
  const clauses = visible.match(/[^.!\n؛;،,?؟]+[?؟]?/gu) || [];
  for (const clause of clauses) {
    for (const match of clause.matchAll(PAST_WRITE)) {
      const verbIndex = (match.index ?? 0) + match[0].indexOf(match[1]);
      if (deniedOrDiscussed(clause, verbIndex)) continue;
      const verb = match[1].replace(/^[وف]/u, "");
      // Avoid rewriting ordinary discussion such as "غيّرت رأيي" or
      // "أضفت مثالين للصياغة". Pronouns can still clearly refer to a write.
      if (WORK_OBJECT.test(clause) || /(?:ها|ه|هم)$/.test(verb) || verb === "خلصتلك") return CONVERSATION_NO_CHANGE_REPLY;
    }
    for (const match of clause.matchAll(PASSIVE_WRITE)) {
      if (WORK_OBJECT.test(clause) && !deniedOrDiscussed(clause, match.index ?? 0)) return CONVERSATION_NO_CHANGE_REPLY;
    }
  }
  return text;
}

/** High-confidence discussion framing, not a general intent classifier. */
export function isDiscussionOnlyRequest(text: string): boolean {
  const visible = normalized(withoutQuotes(text)).trim();
  if (!visible) return text.trim().length > 0;
  if (/^لو سمحت(?:\s|$)/u.test(visible)) return false; // Courtesy, not a hypothetical.
  // A separate explicit instruction after a question must still be planned.
  if (/[?؟;؛\n]\s*(?:و)?(?:سجل|اضف|انشئ|احذف|عدل|غير|اعتمد|انقل|ارجع|الغ|ارشف|ذكرني|استلم|ارسل|نفذ)(?:\s|$)/u.test(visible)) return false;
  // A work problem ending in a request for advice is not permission to log or change it.
  if (/(?:شو اعمل|كيف اتصرف|من وين ابدا)\s*[?؟.!]*$/u.test(visible)
    && !/(?:^|\s)(?:سجل|اضف|انشئ|احذف|عدل|اعتمد|انقل|ارسل|نفذ)(?:\s|$)/u.test(visible)) return true;
  if (/^(?:كيف|شو رايك|ما رايك|لو|ماذا لو|هل يمكن|هل ممكن|هل يجوز|هل اقدر|هل استطيع|ممكن تشرح|اشرح لي|اشرحلي|وضح لي|فهمني|بدي افهم|اريد ان افهم)(?:\s|[?؟،,:]|$)/u.test(visible)) return true;
  return /^(?:اكتب(?: لي|لي)?|صيغ(?: لي|لي)?|جهز(?: لي|لي)?)\s+(?:صياغة|مسودة|نص|مثال|رسالة|رد)(?:\s|[:：]|$)/u.test(visible)
    || /^(?:مثال|صياغة مقترحة|مسودة)\s*[:：]/u.test(visible);
}


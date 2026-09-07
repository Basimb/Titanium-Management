import assert from "node:assert/strict";
import test from "node:test";
import { secretaryReviewRequest, getSecretaryReview, isSecretaryIdentityQuery, SECRETARY_IDENTITY } from "../lib/secretary-review.ts";

const pair = (question, previousAnswer) => [{ role: "user", content: question }, { role: "assistant", content: previousAnswer }];
const original = pair("عندك أرقام فريق العمل؟", "الجواب السابق بحاجة تحقق");

test("explicit Arabic objections select the previous actual question, not the criticism", () => {
  assert.deepEqual(secretaryReviewRequest("هيك غلط", original), {kind:"review",question:original[0].content,previousAnswer:original[1].content});
  for (const text of ["جوابك غلط", "ردك مش صحيح", "إجابتك خاطئة", "معلوماتك غير دقيقة", "لا، كلامك غلط", "يا أخي جوابك خطأ", "انت فاهمني غلط", "ما فهمت علي", "غلط", "راجع جوابك", "جوابك غير صحيح، تأكد من المعلومة"]) {
    assert.deepEqual(secretaryReviewRequest(text, original), { kind: "review", question: original[0].content, previousAnswer: original[1].content }, text);
  }
  assert.equal(getSecretaryReview, secretaryReviewRequest);
});

test("own answer, negation, quotations, discussion and unrelated task commands are not objections", () => {
  for (const text of ["جوابي غلط؟", "إجابتي خاطئة", "جوابك مش غلط", "جوابك صحيح", "مين قال جوابك غلط؟", "لو جوابك غلط شو بتعمل؟", "اكتب رسالة تقول جوابك غلط", "«جوابك غلط»", '"ردك غلط"', "احذف المهمة الغلط", "عدل جوابي الغلط", "كيف أصحح جوابي؟"]) {
    assert.equal(secretaryReviewRequest(text, original), null, text);
  }
});

test("mixed criticism and execution stays in read-only clarification instead of falling through", () => {
  for (const text of ["جوابك غلط احذف المهمة", "ردك غلط، وابعث الرسالة لخالد", "جوابك غلط غير موعد المهمة", "غلط؛ نفذ الطلب", "جوابك غلط، اعتمدها"]) {
    assert.equal(secretaryReviewRequest(text, original)?.kind, "clarify", text);
  }
  assert.equal(secretaryReviewRequest("جوابك غلط، عدل جوابك", original)?.kind, "review");
});

test("an objection without a usable current conversation asks a question without inventing context", () => {
  assert.equal(secretaryReviewRequest("جوابك غلط", [])?.kind, "clarify");
  assert.equal(secretaryReviewRequest("جوابك غلط", [{ role: "assistant", content: "جواب يتيم" }])?.kind, "clarify");
  assert.equal(secretaryReviewRequest("جوابك غلط", null)?.kind, "clarify");
});

test("repeated objections recover the original question and the latest review answer", () => {
  const history = [...original, ...pair("جوابك غلط", "توضيح أول"), ...pair("غلط", "مراجعة ثانية تحتاج تدقيقًا")];
  assert.deepEqual(secretaryReviewRequest("ردك مش صحيح", history), { kind: "review", question: original[0].content, previousAnswer: "مراجعة ثانية تحتاج تدقيقًا" });
});

test("polite acknowledgments do not replace the factual answer or create a new question", () => {
  assert.deepEqual(secretaryReviewRequest("جوابك غلط", [...original, ...pair("تمام شكرا", "أنا معك")]), {
    kind: "review", question: original[0].content, previousAnswer: original[1].content,
  });
});

test("a new task, cancellation or unrelated statement is a context boundary", () => {
  for (const current of ["أرسل لخالد الرسالة", "إلغاء", "خلينا نغيّر الموضوع", "اضف مهمة تجربة", "موافق"]) {
    assert.equal(secretaryReviewRequest("جوابك غلط", [...original, ...pair(current, "رد على موضوع آخر")])?.kind, "clarify", current);
  }
  const newer = pair("كيف أرتب شغلي؟", "نصيحة تنظيمية");
  assert.deepEqual(secretaryReviewRequest("جوابك غلط", [...original, ...newer]), { kind: "review", question: newer[0].content, previousAnswer: newer[1].content });
});

test("an explicitly authorized quoted question wins over newer unrelated conversation", () => {
  const quote = { question: "كم عدد المهام الحمراء؟", previousAnswer: "العدد المذكور سابقًا" };
  assert.deepEqual(secretaryReviewRequest("جوابك غلط", original, quote), { kind: "review", ...quote });
  assert.deepEqual(secretaryReviewRequest("جوابك غلط", original, { ...quote, kind: "command", action: "delete_task", recipientIds: ["extra"] }), { kind: "review", ...quote });
  assert.equal(secretaryReviewRequest("جوابك غلط", original, { question: "أرسل الرسالة", previousAnswer: "تم" })?.kind, "clarify");
  assert.equal(secretaryReviewRequest("جوابك غلط", original, { question: "", previousAnswer: "جواب بلا سؤال" })?.kind, "clarify");
});

test("question recovery allows public and internal reads, not a request to resend or mutate", () => {
  for (const question of ["ما هو سعر الذهب اليوم؟", "أعطيني المهام الحمراء", "مشاريعي", "اشرحلي سبب تأخر المهمة", "كيف أحذف مهمة؟", "بدي أعرف مين المسؤول عن المهمة؟"]) {
    assert.equal(secretaryReviewRequest("جوابك غلط", pair(question, "الجواب"))?.kind, "review", question);
  }
  for (const question of ["احذف المهمة؟", "أعطيني صلاحيات المدير", "شو الوضع؟ احذف المهمة", "وين الملف؟ وابعثه لخالد"]) {
    assert.equal(secretaryReviewRequest("جوابك غلط", pair(question, "الجواب"))?.kind, "clarify", question);
  }
});

test("history is bounded, not modified, and never shared across separate calls", () => {
  const history = Object.freeze(original.map(Object.freeze));
  const before = JSON.stringify(history); secretaryReviewRequest("جوابك غلط", history);
  assert.equal(JSON.stringify(history), before);
  assert.equal(secretaryReviewRequest("جوابك غلط", [])?.kind, "clarify");
  const old = [...original, ...Array.from({ length: 8 }, () => pair("غلط", "رد مراجعة")).flat()];
  assert.equal(secretaryReviewRequest("جوابك غلط", old)?.kind, "clarify");
  assert.equal(secretaryReviewRequest("جوابك غلط", pair("شو " + "س".repeat(2000), "جواب"))?.kind, "clarify");
});

test("natural Arabic comparison/benefit questions and bounded English question forms are reviewable", () => {
  for (const question of ["ما الفرق بين LED و OLED؟", "ما فائدة ترتيب المهام؟", "ما أهمية التحقق؟", "ما أنواع الشاشات؟", "ما الأفضل للمكتب؟", "What is OLED?", "Why is this late?", "How do I delete a task?", "Where is the report?", "When is the deadline?", "Who owns this task?", "Is that accurate?", "Are these different?"]) {
    assert.deepEqual(secretaryReviewRequest("جوابك غلط", pair(question, "الجواب السابق")), { kind: "review", question, previousAnswer: "الجواب السابق" }, question);
  }
  for (const question of ["What changed? Delete the task", "Where is the report? And send it now", "How to review? احذف المهمة", "ما الفرق؟ احذف المهمة", "delete the wrong answer", "اكتب نصًا يقول ما الفرق بين الشاشات"]) {
    assert.equal(secretaryReviewRequest("جوابك غلط", pair(question, "الجواب السابق"))?.kind, "clarify", question);
  }
});

test("identity is Basim's virtual secretary and only direct identity questions use its fixed reply", () => {
  assert.match(SECRETARY_IDENTITY, /^أنا سكرتير باسم، مساعده الافتراضي/);
  for (const text of ["مين أنت؟", "انت مين", "شو اسمك", "هلا، مين انت؟", "عرّفني عليك", "هل انت ChatGPT؟", "انت شات جي بي تي"]) assert.equal(isSecretaryIdentityQuery(text), true, text);
  for (const text of ["مرحبا", "جوابك غلط", "مين صاحب المهمة؟", "اكتب رسالة مين انت", "«مين انت؟»", "مين انت؟ احذف المهمة", "شو اسمك القديم؟"]) assert.equal(isSecretaryIdentityQuery(text), false, text);
});


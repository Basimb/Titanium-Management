import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import {
  createSecretaryLink, resolveSecretaryDeepLink, secretaryActivityTarget, secretaryAuditView,
} from "../components/secretary-ui-helpers.ts";

const member = { id: "test-member", role: "member", active: 1 };
const admin = { id: "basem", role: "admin", active: 1 };
const projects = [{ id: "project-a", name: "المشروع المصرح", status: "active" }];
const tasks = [{ id: "task-a", projectId: "project-a", title: "المهمة المصرح بها", archivedAt: null }];
const read = relative => readFile(new URL(relative, import.meta.url), "utf8");

test("deep links defer until authenticated active state, never trusting identity in URL", () => {
  for (const viewer of [null, { ...member, active: 0 }]) {
    assert.deepEqual(resolveSecretaryDeepLink("?project=project-a&task=task-a&userId=basem&role=admin", viewer, projects, tasks), { status: "deferred" });
  }
  assert.equal(resolveSecretaryDeepLink("?unrelated=1", member, projects, tasks).status, "none");
  const result = resolveSecretaryDeepLink("?project=project-a&task=task-a", member, projects, tasks);
  assert.equal(result.status, "resolved");
  assert.deepEqual(result.target, { projectId: "project-a", taskId: "task-a" });
  assert.equal(result.archived, false);
});

test("unauthorized/missing project or task IDs and cross-project pairs are never opened", () => {
  const permitted = [...projects, { id: "project-b", name: "ثانٍ مصرح" }];
  for (const query of [
    "?project=foreign-project", "?project=project-a&task=foreign-task", "?project=project-b&task=task-a",
    "?project=project-a&project=project-b", "?task=task-a&task=foreign-task", "?project=", "?task=",
    "?project=..%2Fsecret", "?task=%3Cimg%20src%3Dx%3E", `?project=${"a".repeat(5000)}`,
  ]) assert.equal(resolveSecretaryDeepLink(query, member, permitted, tasks).status, "unavailable", query);
  assert.equal(resolveSecretaryDeepLink("?task=task-a", member, [], tasks).status, "unavailable");
  assert.equal(resolveSecretaryDeepLink("?project=project-a&task=task-a", member, projects, []).status, "unavailable");
});

test("task-only links derive the authorized parent and archived tasks open the archive", () => {
  const result = resolveSecretaryDeepLink("?task=task-a", member, projects, [{ ...tasks[0], archivedAt: 100 }]);
  assert.equal(result.status, "resolved");
  assert.deepEqual(result.target, { projectId: "project-a", taskId: "task-a" });
  assert.equal(result.archived, true);
  assert.match(result.announcement, /الأرشيف/);
  assert.deepEqual(resolveSecretaryDeepLink("?project=project-a", member, projects, tasks).target, { projectId: "project-a" });
});

test("query titles, names and redirect instructions cannot replace trusted state content", () => {
  const params = new URLSearchParams({
    project: "project-a", task: "task-a", title: "<img src=x onerror=alert(1)>",
    name: "مشروع مزيف", action: "delete_task", redirect: "https://attacker.invalid/",
  });
  const result = resolveSecretaryDeepLink(params.toString(), member, projects, tasks);
  assert.equal(result.status, "resolved");
  assert.match(result.announcement, /المهمة المصرح بها/);
  assert.doesNotMatch(result.announcement, /img|مزيف|attacker|delete_task/);
  const storedMarkupTitle = resolveSecretaryDeepLink("?task=task-a", member, projects, [{ ...tasks[0], title: "<img src=x onerror=alert(1)>" }]);
  const html = renderToStaticMarkup(React.createElement("p", { role: "status" }, storedMarkupTitle.announcement));
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;img/);
});

test("copied links contain only validated IDs on the same HTTPS origin, never title or credentials", () => {
  const origin = "https://management.example.test";
  assert.equal(createSecretaryLink(origin, { projectId: "project-a", taskId: "task-a" }), `${origin}/?project=project-a&task=task-a`);
  assert.equal(createSecretaryLink(origin, { projectId: "project-a" }), `${origin}/?project=project-a`);
  for (const unsafe of ["javascript:alert(1)", "https://user:password@management.example.test", `${origin}/path`, `${origin}?token=secret`, "http://management.example.test"]) {
    assert.equal(createSecretaryLink(unsafe, { projectId: "project-a" }), null);
  }
  assert.equal(createSecretaryLink(origin, { projectId: "project-a&role=admin" }), null);
  assert.equal(createSecretaryLink(origin, { projectId: "project-a", taskId: "../task" }), null);
});

test("activity links use authorized entity IDs, not a model-proposed target", () => {
  assert.deepEqual(secretaryActivityTarget({ entityType: "task", entityId: "task-a" }, member, projects, tasks), { projectId: "project-a", taskId: "task-a" });
  assert.deepEqual(secretaryActivityTarget({ entityType: "project", entityId: "project-a" }, member, projects, tasks), { projectId: "project-a" });
  for (const activity of [
    { entityType: "user", entityId: "basem" }, { entityType: "task", entityId: "foreign-task" },
    { entityType: "project", entityId: "foreign-project" },
  ]) assert.equal(secretaryActivityTarget(activity, member, projects, tasks), null);
  assert.equal(secretaryActivityTarget({ entityType: "task", entityId: "task-a" }, null, projects, tasks), null);
});

const senderNumber = "12025550101";
const detailedActivity = {
  id: 1, actorName: "موظف تجريبي", action: "edit_task", createdAt: 1_800_000_000_000,
  details: JSON.stringify({
    source: "whatsapp_secretary", summary: "تم تعديل المهمة بعد تأكيد صاحب الصلاحية",
    previous: { title: "قبل", status: "progress", token: "private-token", senderNumber },
    next: { title: "بعد", status: "approval" },
    auditContext: {
      sourceMessageId: "synthetic-message", origin: "whatsapp", senderNumber,
      originalText: "غيّر عنوان المهمة", proposedCommand: { action: "edit_task", taskId: "task-a", title: "بعد", phone: senderNumber, apiKey: "private-key" },
      confirmationRequired: true, confirmedBy: { id: "basem", name: "باسم", phone: senderNumber },
      confirmationMessageId: "synthetic-confirmation",
    },
  }),
};

test("secretary audit displays agreed context/proposal/confirmation and real before-after fields", () => {
  const view = secretaryAuditView(detailedActivity, admin);
  const fields = Object.fromEntries(view.fields.map(item => [item.label, item.value]));
  assert.equal(view.isSecretary, true);
  assert.equal(view.senderNumber, senderNumber);
  assert.equal(fields["النص الأصلي"], "غيّر عنوان المهمة");
  assert.match(fields["الإجراء المقترح"], /تعديل مهمة/);
  assert.equal(fields["التأكيد"], "يتطلب تأكيدًا صريحًا");
  assert.match(fields["أكّد بواسطة"], /باسم/);
  assert.match(fields["قبل التغيير"], /قيد التنفيذ/);
  assert.match(fields["بعد التغيير"], /بانتظار اعتماد باسم/);
  assert.doesNotMatch(JSON.stringify(view.fields), /private-token|private-key|12025550101/);
});

test("original sender phone is restricted to active basem/admin even if full metadata arrives", () => {
  for (const viewer of [member, { ...admin, id: "other-admin" }, { ...admin, role: "member" }, { ...admin, active: 0 }, null]) {
    const view = secretaryAuditView(detailedActivity, viewer);
    assert.equal(view.senderNumber, null);
    assert.doesNotMatch(JSON.stringify(view), /12025550101|private-token|private-key/);
  }
  const short = { ...detailedActivity, details: JSON.stringify({ source: "whatsapp_secretary", summary: "تحديث متاح للموظف" }) };
  assert.equal(secretaryAuditView(short, member).summary, "تحديث متاح للموظف");
});

test("nested metadata, malformed JSON and non-string summaries cannot crash audit rendering", () => {
  const nested = { ...detailedActivity, details: JSON.stringify({ summary: "ملخص", metadata: { source: "whatsapp_secretary", auditContext: { originalText: "نص", confirmationRequired: false } } }) };
  assert.equal(secretaryAuditView(nested, admin).isSecretary, true);
  assert.ok(secretaryAuditView(nested, admin).fields.some(item => item.value === "نص"));
  for (const details of ["broken-json", "null", "[]", "true", JSON.stringify({ summary: { malicious: true } }), "x".repeat(70_000)]) {
    const view = secretaryAuditView({ action: "edit_task", details }, admin);
    assert.equal(view.summary, "edit_task");
    assert.equal(view.isSecretary, false);
  }
});

test("prototype-like strings remain text and freeform titles are not translated as statuses", () => {
  const view = secretaryAuditView({ action: "constructor", details: JSON.stringify({
    source: "whatsapp_secretary", previous: { title: "red", status: "__proto__" },
    auditContext: { proposedCommand: { action: "toString", title: "open" } },
  }) }, admin);
  const fields = Object.fromEntries(view.fields.map(item => [item.label, item.value]));
  assert.equal(fields["الإجراء"], "constructor");
  assert.match(fields["قبل التغيير"], /العنوان: red/);
  assert.match(fields["قبل التغيير"], /الحالة: __proto__/);
  assert.match(fields["الإجراء المقترح"], /العنوان: open/);
  assert.match(fields["الإجراء المقترح"], /الإجراء: toString/);
});

async function compileComponent(filename) {
  const require = createRequire(import.meta.url);
  const moduleUrl = name => pathToFileURL(require.resolve(name)).href;
  const source = await read(`../components/${filename}.tsx`);
  let compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  for (const [specifier, destination] of [
    ["react/jsx-runtime", moduleUrl("react/jsx-runtime")], ["react", moduleUrl("react")],
    ["./secretary-ui-helpers", new URL("../components/secretary-ui-helpers.ts", import.meta.url).href],
  ]) compiled = compiled.replaceAll(`from ${JSON.stringify(specifier)}`, `from ${JSON.stringify(destination)}`);
  return import(`data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`);
}

test("real activity component escapes actor, original text, proposal titles and summaries", async () => {
  const { SecretaryActivity } = await compileComponent("secretary-activity");
  const attack = "<img src=x onerror=alert(1)>";
  const activity = { ...detailedActivity, actorName: attack, details: JSON.stringify({
    source: "whatsapp_secretary", summary: attack, previous: { title: attack }, next: { title: attack },
    auditContext: { originalText: attack, proposedCommand: { action: "edit_task", title: attack }, senderNumber },
  }) };
  const render = viewer => renderToStaticMarkup(React.createElement(SecretaryActivity, { activity, viewer, target: { projectId: "project-a", taskId: "task-a" }, onOpen() {} }));
  const memberHtml = render(member);
  assert.doesNotMatch(memberHtml, /<img|12025550101/);
  assert.match(memberHtml, /&lt;img/);
  assert.match(memberHtml, /<details/);
  assert.match(memberHtml, /<summary/);
  assert.match(memberHtml, /فتح المهمة/);
  assert.match(render(admin), /12025550101/);
});

test("copy controls render accessible buttons and polite status without automatic navigation", async () => {
  const { SecretaryLinkButton } = await compileComponent("secretary-link-button");
  const html = renderToStaticMarkup(React.createElement(SecretaryLinkButton, { target: { projectId: "project-a", taskId: "task-a" } }));
  assert.match(html, /type="button"/);
  assert.match(html, /نسخ رابط المهمة/);
  assert.match(html, /role="status"/);
  assert.match(html, /aria-live="polite"/);
  assert.doesNotMatch(html, /<a |href=|token|phone=/);
});

test("dashboard waits for authorized state and provides accessible focus, archive and comment reveal", async () => {
  const source = await read("../app/dashboard.tsx");
  assert.match(source, /loadedStateOwnerRef\.current = next\.currentUser\?\.id \?\? null/);
  assert.match(source, /loadedStateOwnerRef\.current !== currentUser\.id/);
  assert.match(source, /resolveSecretaryDeepLink\(locationSearch, currentUser, data\.projects, data\.tasks\)/);
  assert.match(source, /setStatusFilter\(result\.archived \? "archived" : "all"\)/);
  assert.match(source, /setExpandedComments/);
  assert.match(source, /element\.focus\(\{ preventScroll: true \}\)/);
  assert.match(source, /prefers-reduced-motion: reduce/);
  assert.match(source, /aria-current=\{linkedTarget\?\.taskId===task\.id\?"location":undefined\}/);
  assert.match(source, /aria-live="polite"/);
  assert.match(source, /لم تُعتمد نهائيًا بعد/);
  assert.doesNotMatch(source, /dangerouslySetInnerHTML|innerHTML|eval\(|querySelector\(/);
});

test("secretary UI changes retain PIN-only login, in-memory token and fresh authenticated state", async () => {
  const source = await read("../app/dashboard.tsx");
  assert.match(source, /auth\.authMethod !== "pin"/);
  assert.doesNotMatch(source, /WhatsAppLogin|whatsappLogin|whatsappUsers|completeWhatsAppLogin/);
  assert.match(source, /if \(next\.sessionToken\) sessionTokenRef\.current = next\.sessionToken/);
  assert.match(source, /<Dialog open=\{changePinOpen\}/);
  assert.match(source, /cache:"no-store", credentials:"include", headers:sessionHeaders\(\)/);
  assert.doesNotMatch(source, /localStorage|sessionStorage/);
  const helpers = await read("../components/secretary-ui-helpers.ts");
  assert.doesNotMatch(helpers, /fetch\(|document\.|eval\(|innerHTML|sessionToken|login-code|request-code/);
});

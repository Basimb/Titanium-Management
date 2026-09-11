/** URL values select only records already returned by the authenticated state
 * endpoint. They never supply titles, permissions, identities or API commands. */
export type SecretaryViewer = { id: string; role: string; active: number } | null;
export type SecretaryTask = { id: string; title: string; archivedAt?: number | null };
/** Tasks are flat, standalone records, so a deep link addresses exactly one task. */
export type SecretaryTarget = { taskId: string };
export type SecretaryDeepLink =
  | { status: "none" | "deferred" | "unavailable" }
  | { status: "resolved"; target: SecretaryTarget; archived: boolean; announcement: string };

const validId = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(value);
const text = (value: unknown, max = 2000): string | null =>
  typeof value === "string" && value.trim() ? value.slice(0, max) : null;
const record = (value: unknown): Record<string, unknown> | null =>
  !!value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;

export function resolveSecretaryDeepLink(
  search: string,
  viewer: SecretaryViewer,
  tasks: readonly SecretaryTask[],
): SecretaryDeepLink {
  if (!viewer || viewer.active !== 1) return { status: "deferred" };
  if (typeof search !== "string" || search.length > 4096) return { status: "unavailable" };
  const params = new URLSearchParams(search);
  if (!params.has("task")) return { status: "none" };
  if (params.getAll("task").length > 1) return { status: "unavailable" };
  const taskId = params.get("task");
  if (taskId === null || !validId(taskId)) return { status: "unavailable" };
  const task = tasks.find(item => item.id === taskId);
  if (!task || !validId(task.id)) return { status: "unavailable" };
  return {
    status: "resolved",
    target: { taskId: task.id },
    archived: !!task.archivedAt,
    announcement: `تم فتح المهمة «${task.title.slice(0, 160)}»${task.archivedAt ? " ضمن الأرشيف" : ""}.`,
  };
}

export function createSecretaryLink(origin: string, target: SecretaryTarget): string | null {
  if (!validId(target.taskId)) return null;
  try {
    const base = new URL(origin);
    if (base.origin !== origin || base.username || base.password || base.protocol !== "https:") return null;
    const result = new URL("/", origin);
    result.searchParams.set("task", target.taskId);
    return result.href;
  } catch { return null; }
}

export function secretaryActivityTarget(
  activity: { entityType: string; entityId: string },
  viewer: SecretaryViewer, tasks: readonly SecretaryTask[],
): SecretaryTarget | null {
  const params = new URLSearchParams();
  if (activity.entityType === "task") params.set("task", activity.entityId);
  else return null;
  const result = resolveSecretaryDeepLink(params.toString(), viewer, tasks);
  return result.status === "resolved" ? result.target : null;
}

const labels: Record<string, string> = {
  action: "الإجراء", taskId: "المهمة", title: "العنوان", name: "الاسم",
  details: "التفاصيل", comment: "التعليق", reason: "السبب", priority: "الأولوية", dueDate: "الموعد",
  status: "الحالة", owner: "المسؤول", ownerId: "معرّف المسؤول", suggestedOwner: "المسؤول المقترح",
  userId: "معرّف المستخدم", id: "المعرّف", active: "التفعيل", role: "الدور",
  archivedAt: "تاريخ الأرشفة", archivedBy: "أرشفة بواسطة", startedAt: "بداية التنفيذ",
  completedAt: "تاريخ الاعتماد", rejectionReason: "سبب الرفض", previousStatus: "الحالة السابقة",
  nextStatus: "الحالة التالية", targetUserId: "المستخدم المستهدف", createdBy: "أضيف بواسطة",
  createdAt: "تاريخ الإضافة", updatedAt: "آخر تحديث",
};
const values: Record<string, string> = {
  open: "مفتوحة", progress: "قيد التنفيذ", approval: "بانتظار اعتماد باسم", completed: "مكتملة نهائيًا",
  pending: "بانتظار المراجعة", rejected: "مرفوضة", red: "قصوى", yellow: "متوسطة", green: "عادية",
  add_task: "إضافة مهمة", claim: "استلام مهمة", comment: "إضافة تعليق",
  update: "تحديث التنفيذ", submit: "إرسال للاعتماد", approve: "اعتماد", reject: "رفض",
  edit_task: "تعديل مهمة", reassign: "إعادة تعيين", cancel_claim: "إرجاع مهمة",
  archive_task: "أرشفة مهمة", restore_task: "استرجاع مهمة", delete_task: "حذف مهمة",
  reopen: "إعادة فتح مهمة", active: "نشط", archived: "مؤرشف",
  admin: "مدير", member: "عضو",
};
const translated = (value: string) => Object.hasOwn(values, value) ? values[value] : value;

function displayValue(value: unknown, key?: string): string | null {
  if (value === null) return "غير محدد";
  if (typeof value === "boolean") return value ? "نعم" : "لا";
  if (typeof value === "number" && Number.isFinite(value)) {
    if (key?.endsWith("At")) {
      const at = new Date(value);
      if (Number.isFinite(at.getTime())) return at.toLocaleString("ar-JO");
    }
    return String(value);
  }
  const result = text(value);
  // Titles/comments remain verbatim text, even if they equal an enum such as red.
  return result && key && ["action", "status", "priority", "previousStatus", "nextStatus", "role"].includes(key)
    ? translated(result) : result;
}

// Explicit field selection avoids rendering phone/token/PIN metadata nested in
// proposals or snapshots. React must render these returned strings as text only.
function describe(value: unknown): string | null {
  const object = record(value);
  if (!object) return displayValue(value);
  const result = Object.entries(labels).flatMap(([key, label]) => {
    if (!Object.hasOwn(object, key)) return [];
    const formatted = displayValue(object[key], key);
    return formatted === null ? [] : [`${label}: ${formatted}`];
  });
  return result.length ? result.join("\n") : null;
}

export type SecretaryAuditView = {
  summary: string; isSecretary: boolean; fields: Array<{ label: string; value: string }>;
  senderNumber: string | null;
};

export function secretaryAuditView(
  activity: { action: string; details: string }, viewer: SecretaryViewer,
): SecretaryAuditView {
  let root: Record<string, unknown> | null = null;
  try { if (typeof activity.details === "string" && activity.details.length <= 65_536) root = record(JSON.parse(activity.details)); } catch { /* Keep ordinary audit row visible. */ }
  const metadata = record(root?.metadata);
  const context = record(root?.auditContext) ?? record(metadata?.auditContext) ?? metadata ?? root;
  const get = (key: string) => context?.[key] ?? root?.[key];
  const source = root?.source ?? metadata?.source ?? context?.source;
  const summary = text(root?.summary) ?? text(activity.action, 160) ?? "تحديث مسجل";
  const isSecretary = source === "whatsapp_secretary";
  const result: SecretaryAuditView = { summary, isSecretary, fields: [], senderNumber: null };
  if (!isSecretary || !viewer || viewer.active !== 1) return result;
  const admin = viewer.id === "basem" && viewer.role === "admin";
  const add = (label: string, value: string | null) => { if (value) result.fields.push({ label, value }); };
  add("الإجراء", text(translated(activity.action), 160));
  add("النص الأصلي", text(get("originalText"), 8000));
  add("الإجراء المقترح", describe(get("proposedCommand")));
  if (typeof get("confirmationRequired") === "boolean") add("التأكيد", get("confirmationRequired") ? "يتطلب تأكيدًا صريحًا" : "لا يتطلب تأكيدًا إضافيًا");
  const confirmed = get("confirmedBy");
  // A phone string is not a display name and must not leak in the confirmer field.
  const confirmedText = !admin && typeof confirmed === "string" && /^\+?[\d\s()-]{8,}$/.test(confirmed) ? "تم التأكيد" : describe(confirmed);
  if (confirmed !== undefined && confirmed !== null) add("أكّد بواسطة", confirmedText);
  add("قبل التغيير", describe(root?.previous ?? get("previous")));
  add("بعد التغيير", describe(root?.next ?? get("next")));
  add("مرجع الرسالة", text(get("sourceMessageId"), 160));
  add("مرجع التأكيد", text(get("confirmationMessageId"), 160));
  const sender = get("senderNumber");
  if (admin && typeof sender === "string" && /^\+?[1-9]\d{7,14}$/.test(sender)) result.senderNumber = sender;
  return result;
}

import {
  audit,
  bucket,
  chatDatabase,
  db,
  ensureSeedUsers,
  hashPin,
  requireAdmin,
  requireSession,
  validPin,
  verifyPin,
  type TitaniumUser,
} from "@/lib/titanium-server";
import { notifyManagementGroup, taskNotification } from "@/lib/whatsapp";
import { readTeamChatSettings } from "@/lib/team-chat-settings";
import { whatsappLoginSettings } from "@/lib/whatsapp-login-settings";
import { executeManagementAction, getManagementSnapshot, isManagementAction, ManagementActionError, parseManagementCommand } from "@/lib/management-actions";
import { listApprovals, decideApproval } from "@/lib/approvals";
import { activeRules } from "@/lib/rules";

/** DASHBOARD_READONLY=1 turns the site into a monitoring screen: only the owner may write, and only approvals decisions. */
function dashboardReadonly() { return (readTeamChatSettings().DASHBOARD_READONLY ?? process.env.DASHBOARD_READONLY) === "1"; }
function monitoring(user: TitaniumUser) {
  const sqlite = chatDatabase();
  const safe = <T,>(work: () => T, fallback: T): T => { try { return work(); } catch { return fallback; } };
  const approvals = safe(() => listApprovals(sqlite, user, { status: "pending", limit: 50 }), []);
  const rules = user.id === "basem" ? safe(() => activeRules(sqlite).map(rule => ({ id: rule.id, statement: rule.statement, kind: rule.kind })), []) : [];
  const followups = user.id === "basem" ? safe(() => sqlite.prepare("SELECT id,kind,target_user AS targetUser,entity_id AS entityId,sent_at AS sentAt,response FROM agent_followups ORDER BY sent_at DESC LIMIT 30").all(), []) : [];
  const agentActions = safe(() => sqlite.prepare("SELECT id,actor_name AS actorName,action,entity_type AS entityType,entity_id AS entityId,details,created_at AS createdAt FROM audit_logs WHERE details LIKE '%\"source\":\"whatsapp_secretary\"%' OR details LIKE '%\"source\":\"approval\"%' ORDER BY created_at DESC LIMIT 30").all(), []);
  return { readonly: dashboardReadonly(), approvals, rules, followups, agentActions };
}

export const dynamic = "force-dynamic";
export const revalidate = 0;

const PRIVATE_RESPONSE_HEADERS = {
  "cache-control": "private, no-store, no-cache, max-age=0, must-revalidate",
  "cdn-cache-control": "no-store",
  pragma: "no-cache",
  expires: "0",
  vary: "Cookie, X-Titanium-Session",
} as const;

function privateJson(body: unknown, init: ResponseInit = {}) {
  const headers = new Headers(init.headers);
  for (const [name, value] of Object.entries(PRIVATE_RESPONSE_HEADERS)) headers.set(name, value);
  return Response.json(body, { ...init, headers });
}


const seedProjects = [
  ["dabouq-setup", "تجهيز صيدلية دابوق"],
  ["dabouq-license", "ترخيص ونقل ملكية دابوق"],
  ["clinics-setup", "تجهيز وتشغيل العيادات"],
  ["clinics-license", "ترخيص العيادات"],
] as const;

const seedTasks = [
  ["ds-1","dabouq-setup","الديكور واللوحة وتعديل كونتر الاستقبال","أولوية قصوى","red"],
  ["ds-2","dabouq-setup","أدابتر كهرباء لتليفون أفايا — تحويلة 110","أولوية قصوى","red"],
  ["ds-3","dabouq-setup","رفع ملف الجرد وتأكيد الستوك وترحيل البضاعة","حوالي 800 صنف","red"],
  ["ds-4","dabouq-setup","تأكيد موعد قدوم محمد من فرع الجمرك","بانتظار التأكيد","yellow"],
  ["ds-5","dabouq-setup","تحديد جدول دوام الصيدلي والموظفين","لم يبدأ","yellow"],
  ["dl-1","dabouq-license","براءة ذمة صندوق الأخطاء الطبية وكتاب الضمان","من 31/3/2025 حتى اليوم","red"],
  ["dl-2","dabouq-license","حضور المزاول والمدير العام وتجهيز الهويات","أولوية قصوى","red"],
  ["dl-3","dabouq-license","مزاولات جميع الصيادلة مجددة وسارية","قيد التجهيز","red"],
  ["dl-4","dabouq-license","عقد إيجار باسم الشركة وختم فرع دابوق","أولوية قصوى","red"],
  ["dl-5","dabouq-license","جدول الفروع والصيادلة المسؤولين","لم يبدأ","red"],
  ["dl-6","dabouq-license","توثيق تنازلات الصيادلة المزاولين","المحامي أحمد","red"],
  ["dl-7","dabouq-license","كتاب وزارة الصحة بالموافقة على إنشاء الشركة","مطلوب","red"],
  ["cs-1","clinics-setup","حسم دوام دكتورة النسائية","أولوية قصوى","red"],
  ["cs-2","clinics-setup","استكمال برنامج العيادات ودفع رسومه","أولوية قصوى","red"],
  ["cs-3","clinics-setup","نقل السرير وتجهيز غرفة المنامة","قيد المتابعة","yellow"],
  ["cs-4","clinics-setup","معالجة فتحات غرف المنامة والتخصصية","لم يبدأ","yellow"],
  ["cs-5","clinics-setup","تركيب واقي شمس للغرف التي دون تكييف","التخصصية، الطب العام، الإدارة","yellow"],
  ["cl-1","clinics-license","تحديد الطبيب المالك ونسبة ملكية الأطباء وعقودهم","نسبة الأطباء 51% على الأقل","red"],
  ["cl-2","clinics-license","الاسم التجاري والسجل التجاري للمركز","أولوية قصوى","red"],
  ["cl-3","clinics-license","مزاولات الأطباء وبراءات الذمة","صلاحية البراءة شهر واحد","red"],
  ["cl-4","clinics-license","عقد إيجار موثق باسم المركز","مطلوب","red"],
  ["cl-5","clinics-license","متطلبات الموقع والعقار وعقد النفايات الطبية","قيد التجهيز","red"],
  ["cl-6","clinics-license","تعهد الأطباء بالتفرغ التام","يتطلب حضورهم شخصياً","red"],
  ["cl-7","clinics-license","رسوم الترخيص بعد موافقة اللجنة","1,000 دينار","red"],
] as const;

async function bootstrap() {
  await ensureSeedUsers();
  const count = await db().prepare("SELECT COUNT(*) AS count FROM projects").first<{ count: number }>();
  if ((count?.count ?? 0) > 0) return;
  // An intentionally emptied workspace is not a fresh installation.
  const history = await db().prepare("SELECT id FROM audit_logs WHERE entity_type = 'project' LIMIT 1").first();
  if (history) return;
  const now = Date.now();
  const statements = seedProjects.map(([id, name]) => db().prepare("INSERT INTO projects (id, name, status, created_by, created_at) VALUES (?, ?, 'active', 'باسم', ?)").bind(id, name, now));
  statements.push(...seedTasks.map(([id, projectId, title, details, priority]) => db().prepare("INSERT INTO tasks (id, project_id, title, details, priority, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'open', ?, ?)").bind(id, projectId, title, details, priority, now, now)));
  await db().batch(statements);
}

function loadState(user: TitaniumUser) {
  return privateJson({ ...getManagementSnapshot(chatDatabase(), user), monitoring: monitoring(user) });
}

export async function GET(request: Request) {
  try {
    const auth = await requireSession(request);
    if (auth.response) return auth.response;
    await bootstrap();
    return loadState(auth.user!);
  } catch (error) {
    if (error instanceof ManagementActionError) return privateJson({ error: error.message }, { status: error.status });
    return privateJson({ error: "تعذر تحميل البيانات" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const auth = await requireSession(request);
    if (auth.response) return auth.response;
    await bootstrap();
    const user = auth.user!;
    const input: unknown = await request.json();
    if (!input || typeof input !== "object" || Array.isArray(input)) return bad("صيغة الطلب غير صالحة");
    const body = input as Record<string, unknown>;
    const action = text(body.action);
    const now = Date.now();
    let waNotification:string|null = null;

    if (action === "decide_approval") {
      const denied = requireAdmin(user); if (denied) return denied;
      const decision = body.decision === "approved" ? "approved" : body.decision === "rejected" ? "rejected" : null;
      if (!decision) return bad("حدد القرار: اعتماد أو رفض");
      decideApproval(chatDatabase(), user, { approvalId: text(body.approvalId), decision, note: text(body.note) || undefined }, { now });
      return loadState(user);
    }
    if (dashboardReadonly() && user.id !== "basem") return forbidden("اللوحة للعرض فقط. التحديثات تتم عبر سكرتير باسم على واتساب.");
    if (isManagementAction(action)) {
      const result = executeManagementAction(chatDatabase(), user, parseManagementCommand(body), { source: "site", now });
      // The database transaction has committed; object storage operations must stay outside it.
      await Promise.allSettled(result.deletedObjectKeys.map(objectKey => bucket().delete(objectKey)));
      if (result.notification) {
        const notice = result.notification;
        waNotification = taskNotification(notice.action, notice.title, notice.actor, notice.extra);
      }
    } else if (action === "add_user") {
      const denied = requireAdmin(user); if (denied) return denied;
      const name = text(body.name).trim(); if (!name) return bad("اسم المستخدم مطلوب");
      const id = crypto.randomUUID(); const role = "member";
      await db().prepare("INSERT INTO users (id, name, role, active, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)").bind(id, name, role, now, now).run();
      await audit(user, "create", "user", id, `أضاف المستخدم ${name}`);
    } else if (action === "update_user") {
      const denied = requireAdmin(user); if (denied) return denied;
      const userId = text(body.userId); const target = await db().prepare("SELECT id, name, role, active FROM users WHERE id = ?").bind(userId).first<{id:string;name:string;role:string;active:number}>();
      if (!target) return missing("المستخدم");
      const active = body.active === true || body.active === "true" ? 1 : 0; const role = target.id === "basem" ? "admin" : "member";
      if (target.id === user.id && (!active || role !== "admin")) return bad("لا يمكنك إيقاف أو إزالة صلاحية مدير حسابك الحالي");
      await db().prepare("UPDATE users SET active = ?, role = ?, updated_at = ? WHERE id = ?").bind(active, role, now, userId).run();
      if (!active) await db().prepare("DELETE FROM sessions WHERE user_id = ?").bind(userId).run();
      await audit(user, "edit", "user", userId, `حدّث صلاحيات المستخدم ${target.name}`);
    } else if (action === "set_user_pin") {
      if (whatsappLoginSettings(readTeamChatSettings()).replacePin) return privateJson({ error: "الدخول الآن برمز واتساب؛ أكواد PIN معطّلة" }, { status: 410 });
      const denied = requireAdmin(user); if (denied) return denied;
      const userId = text(body.userId); const pin = body.pin;
      if (!validPin(pin)) return bad("الكود يجب أن يكون من 4 إلى 8 أرقام");
      const target = await db().prepare("SELECT id, name FROM users WHERE id = ?").bind(userId).first<{id:string;name:string}>(); if (!target) return missing("المستخدم");
      const result = await hashPin(pin);
      await db().prepare("UPDATE users SET pin_salt = ?, pin_hash = ?, updated_at = ? WHERE id = ?").bind(result.salt, result.hash, now, userId).run();
      if (userId !== user.id) await db().prepare("DELETE FROM sessions WHERE user_id = ?").bind(userId).run();
      await audit(user, "pin_reset", "user", userId, `غيّر كود المستخدم ${target.name}`);
    } else if (action === "change_own_pin") {
      if (whatsappLoginSettings(readTeamChatSettings()).replacePin) return privateJson({ error: "الدخول الآن برمز واتساب؛ أكواد PIN معطّلة" }, { status: 410 });
      const oldPin = text(body.oldPin); const newPin = body.newPin;
      if (!validPin(newPin)) return bad("الكود الجديد يجب أن يكون من 4 إلى 8 أرقام");
      const record = await db().prepare("SELECT pin_salt AS pinSalt, pin_hash AS pinHash FROM users WHERE id = ?").bind(user.id).first<{pinSalt:string|null;pinHash:string|null}>();
      if (!record || !(await verifyPin(oldPin, record.pinSalt, record.pinHash))) return forbidden("الكود الحالي غير صحيح");
      const result = await hashPin(newPin);
      await db().prepare("UPDATE users SET pin_salt = ?, pin_hash = ?, updated_at = ? WHERE id = ?").bind(result.salt, result.hash, now, user.id).run();
      await audit(user, "pin_change", "user", user.id, "غيّر كود دخوله");
    } else {
      return bad("الطلب غير معروف");
    }

    if (waNotification) await notifyManagementGroup(waNotification).catch(() => console.error("WhatsApp notification failed"));
    return loadState(user);
  } catch (error) {
    if (error instanceof ManagementActionError) return privateJson({ error: error.message }, { status: error.status });
    if (error instanceof SyntaxError) return bad("صيغة الطلب غير صالحة");
    const message = error instanceof Error ? error.message : "";
    const status = message.includes("UNIQUE") ? 409 : 500;
    return privateJson({ error: status === 409 ? "الاسم مستخدم مسبقاً" : "تعذر حفظ التحديث" }, { status });
  }
}

function text(value: unknown) { return typeof value === "string" ? value : ""; }
function bad(message: string) { return privateJson({ error: message }, { status: 400 }); }
function forbidden(message: string) { return privateJson({ error: message }, { status: 403 }); }
function missing(entity: string) { return privateJson({ error: `${entity} غير موجود` }, { status: 404 }); }

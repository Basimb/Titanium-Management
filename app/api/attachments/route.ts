import { audit, bucket, db, chatDatabase, requireSession, type TitaniumUser } from "@/lib/titanium-server";
import { getManagementSnapshot, isManagementAdmin, resolveManagementActor } from "@/lib/management-actions";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
function permittedTask(actor: TitaniumUser, taskId: string, write = false) {
  const state = getManagementSnapshot(chatDatabase(), actor);
  const task = state.tasks.find(task => task.id === taskId);
  if (!task) return null;
  if (write && (task.archivedAt !== null
    || (!isManagementAdmin(actor) && (task.owner !== actor.name || task.status !== "progress")))) return null;
  return task;
}

const MAX_FILE_SIZE = 10 * 1024 * 1024;
const allowedTypes = new Set([
  "image/jpeg", "image/png", "image/webp", "application/pdf",
  "application/msword", "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "text/plain",
]);

export async function POST(request: Request) {
  try {
    const auth = await requireSession(request); if (auth.response) return auth.response;
    const form = await request.formData();
    const taskId = typeof form.get("taskId") === "string" ? String(form.get("taskId")) : "";
    const file = form.get("file");
    if (!taskId || !(file instanceof File)) return Response.json({ error: "اختر الملف والمهمة" }, { status: 400 });
    if (!file.size || file.size > MAX_FILE_SIZE) return Response.json({ error: "حجم الملف يجب ألا يتجاوز 10 ميجابايت" }, { status: 400 });
    if (!allowedTypes.has(file.type)) return Response.json({ error: "نوع الملف غير مدعوم" }, { status: 400 });
    const task = await db().prepare("SELECT id, title, owner, status FROM tasks WHERE id = ? AND archived_at IS NULL").bind(taskId).first<{id:string;title:string;owner:string|null;status:string}>();
    if (!task) return Response.json({ error: "المهمة غير موجودة أو مؤرشفة" }, { status: 404 });
    if (!permittedTask(auth.user!, taskId, true)) return Response.json({ error: "يمكنك إرفاق ملف فقط بمهمة مسموحة لك وهي قيد التنفيذ" }, { status: 403 });
    const id = crypto.randomUUID();
    const safeName = file.name.replace(/[\r\n/\\]/g, "_").slice(0, 180) || "ملف";
    const objectKey = `tasks/${taskId}/${id}`;
    await bucket().put(objectKey, await file.arrayBuffer(), { httpMetadata: { contentType:file.type } });
    const sqlite = chatDatabase();
    sqlite.exec("BEGIN IMMEDIATE");
    try {
      if (!permittedTask(auth.user!, taskId, true)) throw new Error("permission_changed");
      sqlite.prepare("INSERT INTO attachments (id, task_id, file_name, content_type, size, object_key, uploaded_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .run(id, taskId, safeName, file.type, file.size, objectKey, auth.user!.name, Date.now());
      sqlite.prepare("INSERT INTO audit_logs(actor_user_id,actor_name,action,entity_type,entity_id,details,created_at) VALUES(?,?,'upload','task',?,?,?)")
        .run(auth.user!.id,auth.user!.name,taskId,JSON.stringify({summary:`أرفق الملف ${safeName} بالمهمة ${task.title}`}),Date.now());
      sqlite.exec("COMMIT");
    } catch (error) {
      sqlite.exec("ROLLBACK");
      await bucket().delete(objectKey).catch(() => {});
      throw error;
    }
    return Response.json({ ok:true });
  } catch {
    return Response.json({ error: "تعذر رفع الملف أو تغيّرت صلاحيات المهمة؛ حدّث الصفحة وأعد المحاولة" }, { status: 500 });
  }
}

export async function GET(request: Request) {
  try {
    const auth = await requireSession(request); if (auth.response) return auth.response;
    const id = new URL(request.url).searchParams.get("id") || "";
    const attachment = await db().prepare("SELECT id, task_id AS taskId, file_name AS fileName, content_type AS contentType, object_key AS objectKey FROM attachments WHERE id = ?")
      .bind(id).first<{id:string;taskId:string;fileName:string;contentType:string;objectKey:string}>();
    if (!attachment) return Response.json({ error: "الملف غير موجود" }, { status: 404 });
    if (!permittedTask(auth.user!, attachment.taskId)) return Response.json({ error: "الملف غير متاح لهذا الحساب" }, { status: 403 });
    const object = await bucket().get(attachment.objectKey);
    if (!object) return Response.json({ error: "محتوى الملف غير موجود" }, { status: 404 });
    if (!permittedTask(auth.user!, attachment.taskId)) { await object.body.cancel().catch(() => {}); return Response.json({ error: "تغيّرت صلاحيات المهمة" }, { status: 403 }); }
    const encodedName = encodeURIComponent(attachment.fileName);
    return new Response(object.body, { headers: {
      "content-type": attachment.contentType,
      "content-disposition": `attachment; filename*=UTF-8''${encodedName}`,
      "cache-control": "private, no-store",
    } });
  } catch {
    return Response.json({ error: "تعذر تنزيل الملف" }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  try {
    const auth = await requireSession(request); if (auth.response) return auth.response;
    const body = await request.json() as { id?: string };
    const attachment = await db().prepare("SELECT id, task_id AS taskId, file_name AS fileName, object_key AS objectKey, uploaded_by AS uploadedBy FROM attachments WHERE id = ?")
      .bind(body.id || "").first<{id:string;taskId:string;fileName:string;objectKey:string;uploadedBy:string}>();
    if (!attachment) return Response.json({ error: "الملف غير موجود" }, { status: 404 });
    if (!isManagementAdmin(resolveManagementActor(chatDatabase(), auth.user!))) return Response.json({ error: "حذف الملفات متاح لباسم فقط" }, { status: 403 });
    await db().prepare("DELETE FROM attachments WHERE id = ?").bind(attachment.id).run();
    await bucket().delete(attachment.objectKey);
    await audit(auth.user!, "delete_attachment", "task", attachment.taskId, `حذف الملف ${attachment.fileName}`);
    return Response.json({ ok:true });
  } catch {
    return Response.json({ error: "تعذر حذف الملف" }, { status: 500 });
  }
}

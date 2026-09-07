"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Archive, Clock3, Edit3, FileText, FolderPlus, History, KeyRound, LogOut, Paperclip, Plus, RotateCcw, Search, Trash2, Upload, UserCog, XCircle } from "lucide-react";
import { toast, Toaster } from "sonner";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { WhatsAppLogin } from "@/components/whatsapp-login";
import { publicWhatsAppLoginUsers, type WhatsAppLoginSuccess, type WhatsAppLoginUser } from "@/components/whatsapp-login-helpers";
import { SecretaryActivity } from "@/components/secretary-activity";
import { SecretaryLinkButton } from "@/components/secretary-link-button";
import { createSecretaryLink, resolveSecretaryDeepLink, secretaryActivityTarget, type SecretaryTarget } from "@/components/secretary-ui-helpers";
import { TVDashboard } from "@/components/tv-dashboard";

type Project = { id:string; name:string; status:string; createdBy:string; createdAt:number; rejectionReason:string|null; rejectedBy:string|null; rejectedAt:number|null };
type Task = { id:string; projectId:string; title:string; details:string; priority:string; status:string; owner:string|null; suggestedOwner:string|null; startedAt:number|null; dueDate:string|null; completedAt:number|null; rejectionReason:string|null; createdAt:number; updatedAt:number|null; archivedAt:number|null; archivedBy:string|null; watcher?:string|null; expectedAt?:string|null; blocker?:string|null; lastUpdateAt?:number|null };
type Approval = { id:string; type:string; status:string; requestedByName:string; summary:string; createdAt:number; payload:Record<string,unknown> };
type Monitoring = { readonly:boolean; approvals:Approval[]; rules:Array<{id:string;statement:string;kind:string}>; followups:Array<{id:string;kind:string;targetUser:string;entityId:string|null;sentAt:number;response:string|null}>; agentActions:Array<{id:number;actorName:string;action:string;entityType:string;entityId:string;details:string;createdAt:number}> };
type Comment = { id:number; taskId:string; author:string; body:string; createdAt:number };
type User = { id:string; name:string; role:"admin"|"member"; active:number; pinSet:number; createdAt:number; updatedAt:number };
type Attachment = { id:string; taskId:string; fileName:string; contentType:string; size:number; uploadedBy:string; createdAt:number };
type Activity = { id:number; actorUserId:string|null; actorName:string; action:string; entityType:string; entityId:string; details:string; createdAt:number };
type CurrentUser = { id:string; name:string; role:"admin"|"member"; active:number };
type State = { currentUser:CurrentUser|null; projects:Project[]; tasks:Task[]; comments:Comment[]; users:User[]; attachments:Attachment[]; activity:Activity[]; monitoring?:Monitoring };
const APPROVAL_LABEL:Record<string,string> = { deadline_extension:"تمديد موعد", task_close:"إغلاق مهمة", project_create:"فتح مشروع", rule:"قاعدة", policy:"سياسة" };
const FOLLOWUP_LABEL:Record<string,string> = { overdue_task:"تنبيه تأخير", silent_task:"استفسار عن مهمة صامتة", stale_approval:"تذكير بموافقة معلّقة", daily_digest:"ملخص الجروب", queued:"إشعار" };

const emptyState:State = { currentUser:null, projects:[], tasks:[], comments:[], users:[], attachments:[], activity:[] };
const statusLabel:Record<string,string> = { open:"مفتوحة", progress:"قيد التنفيذ", approval:"بانتظار باسم", completed:"تم اعتمادها" };
const priorityOrder:Record<string,number> = { red:0, yellow:1, green:2 };

export default function Dashboard() {
  const [tvMode, setTvMode] = useState(false);
  const [lastUpdated, setLastUpdated] = useState(0);
  const [data, setData] = useState<State>(emptyState);
  const [loading, setLoading] = useState(true);
  const [loginUsers, setLoginUsers] = useState<Array<{id:string;name:string;pinSet:number}>>([]);
  const [whatsappUsers, setWhatsappUsers] = useState<WhatsAppLoginUser[]>([]);
  const [setupRequired, setSetupRequired] = useState(false);
  const [authMethod, setAuthMethod] = useState<"pin" | "whatsapp" | null>(null);
  const [platformAuthenticated, setPlatformAuthenticated] = useState(false);
  const [loginUserId, setLoginUserId] = useState("basem");
  const [loginPin, setLoginPin] = useState("");
  const [setupPin, setSetupPin] = useState("");
  const [activeProject, setActiveProject] = useState("");
  const [search, setSearch] = useState("");
  const [ownerFilter, setOwnerFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [priorityFilter, setPriorityFilter] = useState("all");
  const [projectOpen, setProjectOpen] = useState(false);
  const [taskOpen, setTaskOpen] = useState(false);
  const [usersOpen, setUsersOpen] = useState(false);
  const [activityOpen, setActivityOpen] = useState(false);
  const [changePinOpen, setChangePinOpen] = useState(false);
  const [editTask, setEditTask] = useState<Task|null>(null);
  const [reassignTask, setReassignTask] = useState<Task|null>(null);
  const [deleteTask, setDeleteTask] = useState<Task|null>(null);
  const [rejectProject, setRejectProject] = useState<Project|null>(null);
  const [projectName, setProjectName] = useState("");
  const [taskTitle, setTaskTitle] = useState("");
  const [taskDetails, setTaskDetails] = useState("");
  const [taskPriority, setTaskPriority] = useState("yellow");
  const [taskDue, setTaskDue] = useState("");
  const [taskSuggested, setTaskSuggested] = useState("");
  const [comments, setComments] = useState<Record<string,string>>({});
  const [expandedComments, setExpandedComments] = useState<Record<string,boolean>>({});
  const [rejectReasons, setRejectReasons] = useState<Record<string,string>>({});
  const [projectRejectReason, setProjectRejectReason] = useState("");
  const [reassignUserId, setReassignUserId] = useState("");
  const [userName, setUserName] = useState("");
  const [userPins, setUserPins] = useState<Record<string,string>>({});
  const [oldPin, setOldPin] = useState("");
  const [newPin, setNewPin] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const sessionTokenRef = useRef("");
  const [locationSearch, setLocationSearch] = useState<string|null>(null);
  const [navigationRevision, setNavigationRevision] = useState(0);
  const [linkedTarget, setLinkedTarget] = useState<SecretaryTarget|null>(null);
  const [deepLinkNotice, setDeepLinkNotice] = useState("");
  const loadedStateOwnerRef = useRef<string|null>(null);
  const handledDeepLinkRef = useRef("");
  const pendingDeepLinkFocus = useRef(false);
  const taskElementsRef = useRef(new Map<string, HTMLElement>());
  const projectHeadingRef = useRef<HTMLHeadingElement>(null);

  const currentUser = data.currentUser;
  const isAdmin = currentUser?.id === "basem" && currentUser.role === "admin";
  const readonly = Boolean(data.monitoring?.readonly);
  const editing = !readonly;
  const monitoring = data.monitoring;
  const selectedLoginUser = loginUsers.find(user => user.id === loginUserId);
  const whatsappLogin = authMethod === "whatsapp";

  function sessionHeaders(json = false):Record<string,string> {
    const headers:Record<string,string> = {};
    if (json) headers["content-type"] = "application/json";
    const token = sessionTokenRef.current;
    if (token) headers["x-titanium-session"] = token;
    return headers;
  }

  async function refreshAuth() {
    try {
      const response = await fetch(`/api/auth?v=${crypto.randomUUID()}`, { cache:"no-store", credentials:"include", headers:sessionHeaders() });
      const auth = await response.json();
      if (!response.ok) throw new Error(auth.error || "تعذر فحص الدخول");
      if (auth.authMethod !== "whatsapp" && auth.authMethod !== "pin") throw new Error("تعذر تحميل طريقة الدخول");
      const whatsapp = auth.authMethod === "whatsapp";
      setAuthMethod(whatsapp ? "whatsapp" : "pin");
      setWhatsappUsers(whatsapp ? publicWhatsAppLoginUsers(auth.loginUsers) : []);
      setLoginUsers(whatsapp ? [] : auth.users || []); setSetupRequired(!whatsapp && Boolean(auth.setupRequired)); setPlatformAuthenticated(Boolean(auth.platformAuthenticated));
      if (whatsapp) { setLoginPin(""); setSetupPin(""); setUserPins({}); setOldPin(""); setNewPin(""); setChangePinOpen(false); }
      if (auth.authenticated && auth.user) {
        // Reflect the authenticated user immediately. This also avoids keeping the
        // login dialog open while mobile WebKit applies the session cookie.
        setData(current => ({ ...current, currentUser: auth.user }));
        await loadState();
      }
    } catch (error) {
      setWhatsappUsers([]);
      setAuthMethod(current => current === "whatsapp" ? "whatsapp" : null);
      toast.error(error instanceof Error ? error.message : "تعذر فحص الدخول");
    }
    finally { setLoading(false); }
  }

  async function loadState() {
    const response = await fetch(`/api/state?v=${crypto.randomUUID()}`, { cache:"no-store", credentials:"include", headers:sessionHeaders() });
    const next = await response.json();
    if (!response.ok) {
      if (response.status === 401) { setData(emptyState); return; }
      throw new Error(next.error || "تعذر تحميل البيانات");
    }
    loadedStateOwnerRef.current = next.currentUser?.id ?? null;
    setData(next);
    setLastUpdated(Date.now());
    setActiveProject(current => current && next.projects.some((project:Project) => project.id === current) ? current : next.projects.find((project:Project) => project.status === "active")?.id || "");
  }

  async function authAction(payload:Record<string,unknown>, success:string) {
    const response = await fetch("/api/auth", { method:"POST", credentials:"include", headers:{ "content-type":"application/json" }, body:JSON.stringify(payload) });
    const next = await response.json();
    if (!response.ok) { toast.error(next.error || "تعذر تسجيل الدخول"); return false; }
    if (next.sessionToken) sessionTokenRef.current = next.sessionToken;
    toast.success(success); setLoginPin(""); setSetupPin(""); setSetupRequired(false);
    if (next.user) setData(current => ({ ...current, currentUser: next.user }));
    await loadState();
    return true;
  }

  async function completeWhatsAppLogin(next: WhatsAppLoginSuccess) {
    if (next.sessionToken) sessionTokenRef.current = next.sessionToken;
    setData(current => ({ ...current, currentUser: next.user }));
    setSetupRequired(false);
    toast.success("تم تسجيل الدخول");
    try { await loadState(); }
    catch { toast.error("تم تأكيد الدخول، لكن تعذر تحميل المهام. حدّث الصفحة للمحاولة مجددًا."); }
  }

  async function logout() {
    await fetch("/api/auth", { method:"POST", headers:sessionHeaders(true), body:JSON.stringify({ action:"logout" }) });
    sessionTokenRef.current = "";
    setData(emptyState); toast.success("تم تسجيل الخروج"); await refreshAuth();
  }

  async function mutate(payload:Record<string,unknown>, success:string) {
    const response = await fetch("/api/state", { method:"POST", headers:sessionHeaders(true), body:JSON.stringify(payload) });
    const next = await response.json();
    if (!response.ok) {
      if (response.status === 401) { setData(emptyState); await refreshAuth(); }
      toast.error(next.error || "تعذر حفظ التحديث"); return false;
    }
    setData(next); toast.success(success); return true;
  }

  async function uploadAttachment(taskId:string, file:File|null) {
    if (!file) { toast.error("اختر الملف أولاً"); return; }
    const form = new FormData(); form.append("taskId", taskId); form.append("file", file);
    const response = await fetch("/api/attachments", { method:"POST", headers:sessionHeaders(), body:form }); const next = await response.json();
    if (!response.ok) { toast.error(next.error || "تعذر رفع الملف"); return; }
    await loadState(); toast.success("تم إرفاق الملف");
  }

  async function removeAttachment(id:string) {
    const response = await fetch("/api/attachments", { method:"DELETE", headers:sessionHeaders(true), body:JSON.stringify({ id }) }); const next = await response.json();
    if (!response.ok) { toast.error(next.error || "تعذر حذف الملف"); return; }
    await loadState(); toast.success("تم حذف الملف");
  }

  useEffect(() => {
    let cancelled = false;
    const start = async () => { if (!cancelled) await refreshAuth(); };
    void start();
    return () => { cancelled = true; };
    // Runs once to restore the server session when the app mounts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 60000); return () => window.clearInterval(timer); }, []);
  useEffect(() => {
    const update = () => {
      const params = new URLSearchParams(window.location.search);
      setTvMode(params.get("display") === "tv" || (params.get("display") !== "list" && !params.has("project") && !params.has("task")));
    };
    update(); window.addEventListener("popstate", update);
    return () => window.removeEventListener("popstate", update);
  }, []);
  useEffect(() => {
    if (!tvMode || !currentUser) return;
    let stopped = false;
    let busy = false;
    const refresh = async () => {
      if (busy || stopped || document.hidden) return;
      busy = true;
      try { await loadState(); } catch { /* Retain the snapshot and show its age. */ }
      finally { busy = false; }
    };
    const timer = window.setInterval(() => void refresh(), 20000);
    const visible = () => { if (!document.hidden) void refresh(); };
    window.addEventListener("online", visible); document.addEventListener("visibilitychange", visible);
    return () => { stopped = true; window.clearInterval(timer); window.removeEventListener("online", visible); document.removeEventListener("visibilitychange", visible); };
    // The existing session and authorized /api/state response are shared with TV mode.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tvMode, currentUser?.id]);
  function toggleTV(enabled:boolean) {
    const url = new URL(window.location.href);
    if (enabled) {
      url.searchParams.delete("display"); url.searchParams.delete("project"); url.searchParams.delete("task");
    } else url.searchParams.set("display", "list");
    window.history.pushState(null, "", `${url.pathname}${url.search}`);
    setTvMode(enabled);
  }
  useEffect(() => {
    const changed = () => { setLocationSearch(window.location.search); setNavigationRevision(value => value + 1); };
    changed();
    window.addEventListener("popstate", changed);
    return () => window.removeEventListener("popstate", changed);
  }, []);
  useEffect(() => {
    if (!currentUser) {
      loadedStateOwnerRef.current = null;
      handledDeepLinkRef.current = "";
      pendingDeepLinkFocus.current = false;
      setLinkedTarget(null); setDeepLinkNotice("");
      return;
    }
    // Restoring an authenticated user is not enough: wait for that user's actual
    // authorized state response before resolving IDs from the address bar.
    if (loading || locationSearch === null || loadedStateOwnerRef.current !== currentUser.id) return;
    const key = JSON.stringify([currentUser.id, locationSearch, navigationRevision]);
    if (handledDeepLinkRef.current === key) return;
    handledDeepLinkRef.current = key;
    const result = resolveSecretaryDeepLink(locationSearch, currentUser, data.projects, data.tasks);
    if (result.status === "resolved") {
      setActiveProject(result.target.projectId);
      setSearch(""); setOwnerFilter("all"); setPriorityFilter("all");
      setStatusFilter(result.archived ? "archived" : "all");
      if (result.target.taskId) setExpandedComments(current => ({ ...current, [result.target.taskId!]: true }));
      pendingDeepLinkFocus.current = true;
      setLinkedTarget(result.target); setDeepLinkNotice(result.announcement);
    } else {
      setLinkedTarget(null);
      setDeepLinkNotice(result.status === "unavailable" ? "هذا الرابط غير متاح لهذا الحساب أو لم يعد موجودًا. لم نفتح مشروعًا أو مهمة من خارج صلاحياتك." : "");
    }
  }, [currentUser, data.projects, data.tasks, loading, locationSearch, navigationRevision]);
  useEffect(() => {
    if (!currentUser || loading || !linkedTarget || activeProject !== linkedTarget.projectId || !pendingDeepLinkFocus.current) return;
    const frame = window.requestAnimationFrame(() => {
      const element = linkedTarget.taskId ? taskElementsRef.current.get(linkedTarget.taskId) : projectHeadingRef.current;
      if (!element) return;
      element.focus({ preventScroll: true });
      element.scrollIntoView({ block: "center", behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
      pendingDeepLinkFocus.current = false;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [currentUser, loading, linkedTarget, activeProject, statusFilter, priorityFilter, ownerFilter, search, data.tasks]);

  function openSecretaryTarget(target: SecretaryTarget) {
    const link = createSecretaryLink(window.location.origin, target);
    if (!link) return;
    const next = new URL(link);
    // Revalidate against current state even when the caller is an activity row.
    const result = resolveSecretaryDeepLink(next.search, currentUser, data.projects, data.tasks);
    if (result.status !== "resolved") { toast.error("الرابط غير متاح لهذا الحساب."); return; }
    window.history.pushState(null, "", `${next.pathname}${next.search}`);
    setLocationSearch(next.search); setNavigationRevision(value => value + 1);
    setActivityOpen(false);
  }

  const activeProjects = data.projects.filter(project => project.status === "active");
  const pendingProjects = data.projects.filter(project => project.status === "pending");
  const rejectedProjects = data.projects.filter(project => project.status === "rejected");
  const activeUsers = data.users.filter(user => user.active);
  const projectTasks = data.tasks.filter(task => task.projectId === activeProject);
  const visibleTasks = projectTasks.filter(task => {
    const archivedMatch = statusFilter === "archived" ? Boolean(task.archivedAt) : !task.archivedAt;
    const statusMatch = statusFilter === "all" || statusFilter === "archived" || task.status === statusFilter;
    const ownerMatch = ownerFilter === "all" || (ownerFilter === "unassigned" ? !task.owner : task.owner === ownerFilter);
    const priorityMatch = priorityFilter === "all" || task.priority === priorityFilter;
    const query = search.trim().toLowerCase();
    const commentText = data.comments.filter(comment => comment.taskId === task.id).map(comment => comment.body).join(" ");
    const searchMatch = !query || `${task.title} ${task.details} ${task.owner || ""} ${commentText}`.toLowerCase().includes(query);
    return archivedMatch && statusMatch && ownerMatch && priorityMatch && searchMatch;
  }).sort((a,b) => (priorityOrder[a.priority] ?? 1) - (priorityOrder[b.priority] ?? 1) || a.createdAt - b.createdAt);
  const activeProjectInfo = data.projects.find(project => project.id === activeProject);
  const totals = useMemo(() => {
    const tasks = data.tasks.filter(task => !task.archivedAt);
    return { all:tasks.length, open:tasks.filter(task => task.status === "open").length, progress:tasks.filter(task => task.status === "progress").length, approval:tasks.filter(task => task.status === "approval").length, completed:tasks.filter(task => task.status === "completed").length };
  }, [data.tasks]);

  const daysSince = (startedAt:number|null) => {
    if (!startedAt) return "لم تبدأ بعد";
    const days = Math.max(0, Math.floor((now - startedAt) / 86400000));
    return `بدأت ${new Date(startedAt).toLocaleDateString("ar-JO")} · مضى ${days === 0 ? "اليوم" : `${days} يوم`}`;
  };

  if (loading) return <main className="titanium-loading-screen"><div>جاري تجهيز فريق إدارة تيتانيوم…</div></main>;
  if (currentUser && tvMode && lastUpdated) return <TVDashboard data={data} lastUpdated={lastUpdated} onExit={() => toggleTV(false)} />;

  return <main className="titanium-shell">
    <Toaster position="top-center" richColors />
    <Dialog open={!currentUser} onOpenChange={() => undefined}>
      <DialogContent dir="rtl" showCloseButton={false} className="titanium-login-dialog">
        <DialogHeader className="text-right"><DialogTitle>{setupRequired ? "إعداد حساب باسم لأول مرة" : "دخول فريق الإدارة"}</DialogTitle><DialogDescription>{authMethod === null ? "يلزم الاتصال بالموقع للتحقق من طريقة الدخول المتاحة." : whatsappLogin ? "اختر اسمك واضغط إرسال الرمز، ثم أدخل رمز التحقق الذي يصلك على واتساب المسجّل لك." : setupRequired ? "مالك الموقع يحدد كود باسم أولاً، وبعد الدخول يحدد أكواد باقي الفريق." : "اختر اسمك واكتب الكود الخاص بك."}</DialogDescription></DialogHeader>
        {authMethod === null ? <div className="titanium-dialog-grid"><p className="titanium-warning" role="alert">تعذر تحميل إعدادات الدخول. تأكد من الإنترنت ثم أعد المحاولة.</p><Button onClick={() => void refreshAuth()}>إعادة المحاولة</Button></div> : whatsappLogin ? <WhatsAppLogin users={whatsappUsers} onAuthenticated={completeWhatsAppLogin} /> : setupRequired ? <div className="titanium-dialog-grid">
          {!platformAuthenticated && <p className="titanium-warning">الإعداد الأول متاح لمالك الموقع من الصفحة الخاصة فقط.</p>}
          <div className="titanium-field"><label>كود باسم الجديد</label><Input type="password" inputMode="numeric" value={setupPin} onChange={event => setSetupPin(event.target.value)} placeholder="من 4 إلى 8 أرقام" /></div>
          <Button disabled={!platformAuthenticated} onClick={() => authAction({ action:"setup", pin:setupPin }, "تم إعداد حساب باسم")}>بدء الاستخدام</Button>
        </div> : <div className="titanium-dialog-grid">
          <div className="titanium-field"><label>المستخدم</label><Select value={loginUserId} onValueChange={setLoginUserId}><SelectTrigger className="w-full"><SelectValue /></SelectTrigger><SelectContent>{loginUsers.map(user => <SelectItem key={user.id} value={user.id}>{user.name}{user.pinSet ? "" : " — بانتظار تفعيل الكود"}</SelectItem>)}</SelectContent></Select></div>
          <div className="titanium-field"><label>الكود السري</label><Input type="password" inputMode="numeric" value={loginPin} onChange={event => setLoginPin(event.target.value)} placeholder="اكتب الكود الخاص بك" onKeyDown={event => { if (event.key === "Enter") void authAction({ action:"login", userId:loginUserId, pin:loginPin }, "تم تسجيل الدخول"); }} /></div>
          {!selectedLoginUser?.pinSet&&<p className="titanium-warning">هذا المستخدم ظاهر، لكن باسم لم يحدد له كود دخول بعد.</p>}
          <Button disabled={!selectedLoginUser?.pinSet} onClick={() => authAction({ action:"login", userId:loginUserId, pin:loginPin }, "تم تسجيل الدخول")}>دخول</Button>
          {loginUsers.length === 0 && <p className="titanium-warning">لا يوجد مستخدم بكود فعال. ادخل كمالك الموقع لإكمال الإعداد.</p>}
        </div>}
      </DialogContent>
    </Dialog>

    <header className="titanium-header"><div className="titanium-header-inner">
      <div className="titanium-brand-row"><div className="titanium-brand"><h1>فريق إدارة تيتانيوم</h1><p>{readonly?"شاشة متابعة — التحديثات عبر سكرتير باسم على واتساب":"كل المشاريع والمهام والمسؤوليات في مكان واحد"}</p></div>
        {currentUser && <div className="titanium-header-actions">
          <Button variant="secondary" onClick={() => toggleTV(true)}>شاشة المتابعة المتحركة</Button>
          {editing&&isAdmin&&<Dialog open={projectOpen} onOpenChange={setProjectOpen}><DialogTrigger asChild><Button variant="secondary"><FolderPlus /> مشروع</Button></DialogTrigger><DialogContent dir="rtl"><DialogHeader className="text-right"><DialogTitle>إضافة مشروع</DialogTitle><DialogDescription>سيظهر المشروع مباشرة للفريق.</DialogDescription></DialogHeader><div className="titanium-dialog-grid"><div className="titanium-field"><label>اسم المشروع</label><Input value={projectName} onChange={event => setProjectName(event.target.value)} placeholder="مثال: افتتاح فرع جديد" /></div><Button onClick={async () => { if (await mutate({ action:"add_project", name:projectName }, "تمت إضافة المشروع")) { setProjectName(""); setProjectOpen(false); } }}>إضافة المشروع</Button></div></DialogContent></Dialog>}
          <Button variant="secondary" onClick={() => setActivityOpen(true)}><History /> النشاط</Button>
          {isAdmin && <Button variant="secondary" onClick={() => setUsersOpen(true)}><UserCog /> المستخدمون</Button>}
          {!whatsappLogin && <Button variant="secondary" onClick={() => setChangePinOpen(true)}><KeyRound /> الكود</Button>}
          <Button variant="secondary" onClick={logout}><LogOut /> {currentUser.name}</Button>
        </div>}
      </div>
      <div className="titanium-summary"><div className="titanium-stat"><strong>{totals.all}</strong><span>كل المهام</span></div><div className="titanium-stat"><strong>{totals.open}</strong><span>مفتوحة</span></div><div className="titanium-stat"><strong>{totals.progress}</strong><span>قيد التنفيذ</span></div><div className="titanium-stat"><strong>{totals.approval}</strong><span>بانتظار باسم</span></div><div className="titanium-stat"><strong>{totals.completed}</strong><span>تم اعتمادها</span></div></div>
    </div></header>

    {currentUser && <section className="titanium-main">
      <p className={`titanium-deep-link-notice${deepLinkNotice ? " visible" : ""}`} role="status" aria-live="polite">{deepLinkNotice}</p>
      <div className="titanium-projects">{activeProjects.map(project => { const tasks=data.tasks.filter(task=>task.projectId===project.id&&!task.archivedAt); const remaining=tasks.filter(task=>task.status!=="completed").length; return <button key={project.id} className={`titanium-project ${activeProject===project.id?"active":""}`} aria-pressed={activeProject===project.id} onClick={() => openSecretaryTarget({ projectId: project.id })}><strong>{project.name}</strong><span>{tasks.length} مهام · {remaining} متبقي</span></button>; })}</div>
      {editing && isAdmin && (pendingProjects.length > 0 || rejectedProjects.length > 0) && <div className="titanium-project-review">
        {pendingProjects.map(project => <div key={project.id} className="titanium-review-card"><div><strong>{project.name}</strong><span>أضافه {project.createdBy} · بانتظار القرار</span></div><div><Button size="sm" onClick={() => mutate({ action:"approve_project", projectId:project.id }, "تم اعتماد المشروع")}>اعتماد</Button><Button size="sm" variant="destructive" onClick={() => { setRejectProject(project); setProjectRejectReason(""); }}>رفض</Button></div></div>)}
        {rejectedProjects.map(project => <div key={project.id} className="titanium-review-card rejected"><div><strong>{project.name}</strong><span>مرفوض: {project.rejectionReason}</span></div><Button size="sm" variant="outline" onClick={() => mutate({ action:"restore_project", projectId:project.id }, "عاد المشروع للمراجعة")}><RotateCcw /> استرجاع</Button></div>)}
      </div>}

      <div className="titanium-toolbar"><div><h2 ref={projectHeadingRef} tabIndex={-1} className={linkedTarget?.projectId === activeProject && !linkedTarget.taskId ? "titanium-linked-project" : undefined}>{activeProjectInfo?.name || "المشاريع"}</h2><p>{projectTasks.filter(task=>!task.archivedAt).length} مهام · {projectTasks.filter(task=>!task.archivedAt&&task.status!=="completed").length} متبقي</p>{activeProjectInfo && <SecretaryLinkButton key={activeProjectInfo.id} target={{ projectId: activeProjectInfo.id }} />}</div>{editing&&isAdmin&&<Dialog open={taskOpen} onOpenChange={setTaskOpen}><DialogTrigger asChild><Button disabled={!activeProject}><Plus /> مهمة</Button></DialogTrigger><DialogContent dir="rtl"><DialogHeader className="text-right"><DialogTitle>إضافة مهمة</DialogTitle><DialogDescription>اكتب المطلوب وحدد الأولوية والموعد والمسؤول.</DialogDescription></DialogHeader><TaskForm title={taskTitle} setTitle={setTaskTitle} details={taskDetails} setDetails={setTaskDetails} priority={taskPriority} setPriority={setTaskPriority} due={taskDue} setDue={setTaskDue} suggested={taskSuggested} setSuggested={setTaskSuggested} users={activeUsers} /><Button onClick={async () => { if (await mutate({ action:"add_task", projectId:activeProject, title:taskTitle, details:taskDetails, priority:taskPriority, dueDate:taskDue, suggestedOwner:taskSuggested }, "تمت إضافة المهمة")) { setTaskTitle(""); setTaskDetails(""); setTaskDue(""); setTaskSuggested(""); setTaskOpen(false); } }}>حفظ المهمة</Button></DialogContent></Dialog>}</div>

      <div className="titanium-filters"><div className="titanium-search"><Search /><Input value={search} onChange={event=>setSearch(event.target.value)} placeholder="ابحث في المهام والتعليقات" /></div><Select value={ownerFilter} onValueChange={setOwnerFilter}><SelectTrigger><SelectValue placeholder="المسؤول" /></SelectTrigger><SelectContent><SelectItem value="all">كل المسؤولين</SelectItem><SelectItem value="unassigned">غير مستلمة</SelectItem>{activeUsers.map(user=><SelectItem key={user.id} value={user.name}>{user.name}</SelectItem>)}</SelectContent></Select><Select value={statusFilter} onValueChange={setStatusFilter}><SelectTrigger><SelectValue placeholder="الحالة" /></SelectTrigger><SelectContent><SelectItem value="all">كل الحالات</SelectItem><SelectItem value="open">مفتوحة</SelectItem><SelectItem value="progress">قيد التنفيذ</SelectItem><SelectItem value="approval">بانتظار باسم</SelectItem><SelectItem value="completed">مكتملة</SelectItem><SelectItem value="archived">الأرشيف</SelectItem></SelectContent></Select><Select value={priorityFilter} onValueChange={setPriorityFilter}><SelectTrigger><SelectValue placeholder="الأولوية" /></SelectTrigger><SelectContent><SelectItem value="all">كل الأولويات</SelectItem><SelectItem value="red">حمراء</SelectItem><SelectItem value="yellow">صفراء</SelectItem><SelectItem value="green">خضراء</SelectItem></SelectContent></Select></div>

      <div className="titanium-task-list">{visibleTasks.length===0&&<div className="titanium-empty">لا توجد مهام مطابقة للفلاتر.</div>}{visibleTasks.map(task => {
        const allComments=data.comments.filter(comment=>comment.taskId===task.id).sort((a,b)=>b.createdAt-a.createdAt||b.id-a.id); const taskComments=expandedComments[task.id]?allComments:allComments.slice(0,5); const files=data.attachments.filter(file=>file.taskId===task.id); const overdue=task.dueDate&&task.status!=="completed"&&new Date(`${task.dueDate}T23:59:59`).getTime()<now; const canClaim=editing&&(isAdmin||task.suggestedOwner===currentUser.name); const canWork=editing&&(isAdmin||(task.owner===currentUser.name&&task.status==="progress")); const hasStartedWork=Boolean(task.startedAt&&(allComments.some(comment=>comment.createdAt>=task.startedAt!)||files.some(file=>file.createdAt>=task.startedAt!)));
        return <article ref={element=>{if(element)taskElementsRef.current.set(task.id,element);else taskElementsRef.current.delete(task.id);}} tabIndex={-1} aria-labelledby={`titanium-task-title-${task.id}`} aria-current={linkedTarget?.taskId===task.id?"location":undefined} className={`titanium-task${task.rejectionReason?" titanium-task-rejected":""}${task.archivedAt?" titanium-task-archived":""}${linkedTarget?.taskId===task.id?" titanium-linked-task":""}`} key={task.id}><span className={`titanium-priority ${task.priority}`} aria-label="الأولوية" /><div><h3 id={`titanium-task-title-${task.id}`} className="titanium-task-title">{task.title}</h3><p className="titanium-task-meta">{task.details||"بدون تفاصيل"}{task.owner?` · المسؤول: ${task.owner}`:""}{task.dueDate?` · الموعد: ${task.dueDate}`:""}{task.expectedAt?` · المتوقع: ${task.expectedAt}`:""}{task.watcher?` · يتابعها: ${task.watcher}`:""}</p>{task.blocker&&<p className="titanium-reject-banner">⛔ معطّل: {task.blocker}</p>}<span className={`titanium-status ${task.status}${overdue?" overdue":""}`}>{task.archivedAt?"مؤرشفة":statusLabel[task.status]}{overdue?" · متأخرة":""}</span>{task.status==="approval"&&<p className="titanium-approval-note">بانتظار اعتماد باسم؛ لم تُعتمد نهائيًا بعد.</p>}{!task.archivedAt&&task.status==="open"&&task.suggestedOwner&&<span className="titanium-suggested-badge">مقترحة لـ: {task.suggestedOwner} · إشعار واتساب تلقائي</span>}{task.rejectionReason&&<p className="titanium-reject-banner">⚠️ رفضها باسم وأعادها إلى {task.owner||"المسؤول"} — السبب: {task.rejectionReason}</p>}<SecretaryLinkButton target={{ projectId: task.projectId, taskId: task.id }} /></div>
          <div className="titanium-task-actions">{editing&&isAdmin&&<Button size="sm" variant="outline" onClick={()=>setEditTask(task)}><Edit3 /> تعديل</Button>}{!task.archivedAt&&task.status==="open"&&canClaim&&<Button size="sm" className="titanium-claim-button" onClick={()=>mutate({action:"claim",taskId:task.id},"استلمت المهمة")}>استلام المهمة</Button>}{!task.archivedAt&&task.status==="progress"&&canWork&&<><Button size="sm" onClick={()=>mutate({action:"submit",taskId:task.id},"أُرسلت لاعتماد باسم")}>تم التنفيذ</Button>{(isAdmin||!hasStartedWork)&&<Button size="sm" variant="outline" onClick={()=>mutate({action:"cancel_claim",taskId:task.id},"تم إرجاع المهمة")}><XCircle /> إرجاع المهمة</Button>}</>}{!task.archivedAt&&task.status==="approval"&&editing&&isAdmin&&<><Button size="sm" onClick={()=>mutate({action:"approve",taskId:task.id},"تم اعتماد المهمة")}>موافقة</Button><Button size="sm" variant="destructive" onClick={()=>mutate({action:"reject",taskId:task.id,reason:rejectReasons[task.id]||""},"عادت المهمة للمسؤول لاستكمالها")}>رفض</Button></>}{editing&&isAdmin&&<><Button size="sm" variant="outline" onClick={()=>{setReassignTask(task);setReassignUserId(activeUsers.find(user=>user.name===(task.suggestedOwner||task.owner))?.id||"");}}><UserCog /> تعيين</Button>{task.archivedAt?<Button size="sm" variant="outline" onClick={()=>mutate({action:"restore_task",taskId:task.id},"تم استرجاع المهمة")}><RotateCcw /> استرجاع</Button>:<Button size="sm" variant="outline" onClick={()=>mutate({action:"archive_task",taskId:task.id},"تمت أرشفة المهمة")}><Archive /> أرشفة</Button>}<Button size="sm" variant="destructive" onClick={()=>setDeleteTask(task)}><Trash2 /> حذف</Button></>}</div>
          <div className="titanium-task-details"><div className="titanium-field"><label>تعليقات وتحديثات الفريق ({allComments.length})</label>{canWork&&<div className="titanium-comment-box"><Input value={comments[task.id]||""} onChange={event=>setComments(current=>({...current,[task.id]:event.target.value}))} placeholder="اكتب تحديثاً على التنفيذ" aria-label={`تحديث على مهمة ${task.title}`} /><Button className="titanium-save-button" onClick={async()=>{if(await mutate({action:"comment",taskId:task.id,comment:comments[task.id]||""},"تم حفظ التعليق"))setComments(current=>({...current,[task.id]:""}));}}>حفظ</Button></div>}{taskComments.length===0&&<p className="titanium-muted">لا توجد تحديثات مسجلة بعد.</p>}{taskComments.length>0&&<div className="titanium-comments-list">{allComments.length>5&&!expandedComments[task.id]&&<p className="titanium-muted">أحدث 5 تعليقات من {allComments.length}.</p>}{taskComments.map(comment=><article className="titanium-comment-card" key={comment.id}><div className="titanium-comment-head"><span className="titanium-comment-number">تعليق #{comment.id}</span><strong>{comment.author}</strong><time>{new Date(comment.createdAt).toLocaleString("ar-JO")}</time></div><p>{comment.body}</p></article>)}{allComments.length>5&&<Button size="sm" variant="ghost" aria-expanded={!!expandedComments[task.id]} onClick={()=>setExpandedComments(current=>({...current,[task.id]:!current[task.id]}))}>{expandedComments[task.id]?"عرض آخر 5":"عرض كل التعليقات"}</Button>}</div>}</div>
            <div className="titanium-files"><div className="titanium-files-head"><label><Paperclip /> الملفات ({files.length})</label>{canWork&&<label className="titanium-upload-button"><Upload /> إرفاق<input type="file" accept="image/jpeg,image/png,image/webp,application/pdf,.doc,.docx,.xls,.xlsx,.txt" onChange={event=>{void uploadAttachment(task.id,event.target.files?.[0]||null);event.currentTarget.value="";}} /></label>}</div>{files.length===0?<span className="titanium-muted">لا توجد مرفقات</span>:files.map(file=><div className="titanium-file-row" key={file.id}><a href={`/api/attachments?id=${encodeURIComponent(file.id)}`}><FileText /> <span>{file.fileName}</span><small>{formatBytes(file.size)} · {file.uploadedBy}</small></a>{isAdmin&&<Button size="sm" variant="ghost" onClick={()=>removeAttachment(file.id)}><Trash2 /></Button>}</div>)}</div>
            {task.status==="approval"&&isAdmin?<div className="titanium-field"><label>سبب الرفض عند الحاجة</label><Input value={rejectReasons[task.id]||""} onChange={event=>setRejectReasons(current=>({...current,[task.id]:event.target.value}))} placeholder="يُكتب عند الرفض" /></div>:<div className="titanium-start"><Clock3 /> {daysSince(task.startedAt)}</div>}
          </div>
        </article>;})}</div>

      {monitoring && <MonitoringPanel monitoring={monitoring} tasks={data.tasks} projects={data.projects} now={now} isAdmin={isAdmin} onDecide={async(approvalId,decision,note)=>{ await mutate({action:"decide_approval",approvalId,decision,note},decision==="approved"?"تم اعتماد الطلب":"تم رفض الطلب"); }} />}
      <div className="titanium-progress-section"><h2 className="titanium-progress-title">نسبة الإنجاز حسب المشروع</h2><div className="titanium-progress-grid">{activeProjects.map(project=>{const tasks=data.tasks.filter(task=>task.projectId===project.id&&!task.archivedAt);const done=tasks.filter(task=>task.status==="completed").length;const total=tasks.length;const pct=total?done/total:0;const radius=30,circumference=2*Math.PI*radius;return <div className="titanium-progress-item" key={project.id}><svg viewBox="0 0 72 72" className="titanium-progress-ring" aria-label={`إنجاز ${project.name} ${Math.round(pct*100)} بالمئة`}><circle cx="36" cy="36" r={radius} className="titanium-progress-track" /><circle cx="36" cy="36" r={radius} className="titanium-progress-value" strokeDasharray={circumference} strokeDashoffset={circumference*(1-pct)} /><text x="36" y="41" textAnchor="middle" className="titanium-progress-percent">{Math.round(pct*100)}%</text></svg><span className="titanium-progress-name">{project.name}</span><span className="titanium-progress-count">{done}/{total} مهام</span></div>;})}</div></div>
    </section>}

    <Dialog open={Boolean(editTask)} onOpenChange={open=>{if(!open)setEditTask(null);}}><DialogContent dir="rtl"><DialogHeader className="text-right"><DialogTitle>تعديل المهمة</DialogTitle><DialogDescription>يمكن تعديل الاسم والتفاصيل والأولوية والموعد والمسؤول المقترح.</DialogDescription></DialogHeader>{editTask&&<><TaskForm title={editTask.title} setTitle={value=>setEditTask({...editTask,title:value})} details={editTask.details} setDetails={value=>setEditTask({...editTask,details:value})} priority={editTask.priority} setPriority={value=>setEditTask({...editTask,priority:value})} due={editTask.dueDate||""} setDue={value=>setEditTask({...editTask,dueDate:value||null})} suggested={editTask.suggestedOwner||""} setSuggested={value=>setEditTask({...editTask,suggestedOwner:value||null})} users={activeUsers} /><Button onClick={async()=>{if(await mutate({action:"edit_task",taskId:editTask.id,title:editTask.title,details:editTask.details,priority:editTask.priority,dueDate:editTask.dueDate||"",suggestedOwner:editTask.suggestedOwner||""},"تم تعديل المهمة"))setEditTask(null);}}>حفظ التعديل</Button></>}</DialogContent></Dialog>
    <Dialog open={Boolean(reassignTask)} onOpenChange={open=>{if(!open)setReassignTask(null);}}><DialogContent dir="rtl"><DialogHeader className="text-right"><DialogTitle>إعادة تعيين المسؤول</DialogTitle><DialogDescription>{reassignTask?.title}</DialogDescription></DialogHeader><div className="titanium-field"><label>المسؤول الجديد</label><Select value={reassignUserId} onValueChange={setReassignUserId}><SelectTrigger><SelectValue placeholder="اختر المسؤول" /></SelectTrigger><SelectContent>{activeUsers.map(user=><SelectItem key={user.id} value={user.id}>{user.name}</SelectItem>)}</SelectContent></Select></div><Button onClick={async()=>{if(reassignTask&&await mutate({action:"reassign",taskId:reassignTask.id,ownerId:reassignUserId},"تم تعيين المسؤول"))setReassignTask(null);}}>حفظ</Button></DialogContent></Dialog>
    <Dialog open={Boolean(rejectProject)} onOpenChange={open=>{if(!open)setRejectProject(null);}}><DialogContent dir="rtl"><DialogHeader className="text-right"><DialogTitle>رفض المشروع</DialogTitle><DialogDescription>{rejectProject?.name}</DialogDescription></DialogHeader><div className="titanium-field"><label>سبب الرفض</label><Textarea value={projectRejectReason} onChange={event=>setProjectRejectReason(event.target.value)} /></div><Button variant="destructive" onClick={async()=>{if(rejectProject&&await mutate({action:"reject_project",projectId:rejectProject.id,reason:projectRejectReason},"تم رفض المشروع"))setRejectProject(null);}}>تأكيد الرفض</Button></DialogContent></Dialog>
    <AlertDialog open={Boolean(deleteTask)} onOpenChange={open=>{if(!open)setDeleteTask(null);}}><AlertDialogContent dir="rtl"><AlertDialogHeader><AlertDialogTitle>حذف المهمة نهائياً؟</AlertDialogTitle><AlertDialogDescription>سيتم حذف المهمة وتعليقاتها وملفاتها. لا يمكن التراجع عن هذه العملية. يمكنك استخدام الأرشفة بدلاً منها.</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>إلغاء</AlertDialogCancel><AlertDialogAction onClick={async()=>{if(deleteTask&&await mutate({action:"delete_task",taskId:deleteTask.id},"تم حذف المهمة نهائياً"))setDeleteTask(null);}}>حذف نهائي</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>

    <Dialog open={usersOpen} onOpenChange={setUsersOpen}><DialogContent dir="rtl" className="titanium-wide-dialog"><DialogHeader className="text-right"><DialogTitle>{whatsappLogin ? "إدارة المستخدمين" : "إدارة المستخدمين والأكواد"}</DialogTitle><DialogDescription>باسم هو المدير الوحيد. أعضاء الفريق يستلمون مهامهم ويحدّثون التنفيذ فقط.</DialogDescription></DialogHeader>{whatsappLogin && <p className="titanium-dialog-note">الدخول برمز مؤقت يُرسل إلى رقم واتساب المسجّل للموظف. إضافة اسم جديد هنا لا تربطه برقم؛ يلزم تسجيل رقمه في إعدادات الدخول الخاصة.</p>}<div className="titanium-user-add"><Input value={userName} onChange={event=>setUserName(event.target.value)} placeholder="اسم المستخدم الجديد" /><Button onClick={async()=>{if(await mutate({action:"add_user",name:userName},"تمت إضافة المستخدم")){setUserName("");}}}><Plus /> إضافة عضو</Button></div><div className="titanium-users-list">{data.users.map(user=><div className={`titanium-user-row${whatsappLogin?" titanium-user-row-whatsapp":""}${user.active?"":" inactive"}`} key={user.id}><div><strong>{user.name}</strong><span>{user.id==="basem"?"المدير الوحيد":whatsappLogin?"عضو · الدخول برمز واتساب":user.pinSet?"عضو · الكود مضبوط":"عضو · بحاجة لكود"}</span></div><Button size="sm" variant={user.active?"outline":"secondary"} disabled={user.id==="basem"} onClick={()=>mutate({action:"update_user",userId:user.id,role:user.role,active:!user.active},user.active?"تم إيقاف المستخدم":"تم تفعيل المستخدم")}>{user.active?"إيقاف":"تفعيل"}</Button>{!whatsappLogin && <><Input type="password" inputMode="numeric" value={userPins[user.id]||""} onChange={event=>setUserPins(current=>({...current,[user.id]:event.target.value}))} placeholder="كود جديد" /><Button size="sm" onClick={async()=>{if(await mutate({action:"set_user_pin",userId:user.id,pin:userPins[user.id]||""},`تم تغيير كود ${user.name}`))setUserPins(current=>({...current,[user.id]:""}));}}><KeyRound /> حفظ الكود</Button></>}</div>)}</div></DialogContent></Dialog>
    {!whatsappLogin && <Dialog open={changePinOpen} onOpenChange={setChangePinOpen}><DialogContent dir="rtl"><DialogHeader className="text-right"><DialogTitle>تغيير كودي</DialogTitle><DialogDescription>اكتب الكود الحالي ثم الكود الجديد من 4 إلى 8 أرقام.</DialogDescription></DialogHeader><div className="titanium-dialog-grid"><Input type="password" inputMode="numeric" value={oldPin} onChange={event=>setOldPin(event.target.value)} placeholder="الكود الحالي" /><Input type="password" inputMode="numeric" value={newPin} onChange={event=>setNewPin(event.target.value)} placeholder="الكود الجديد" /><Button onClick={async()=>{if(await mutate({action:"change_own_pin",oldPin,newPin},"تم تغيير الكود")){setOldPin("");setNewPin("");setChangePinOpen(false);}}}>حفظ الكود الجديد</Button></div></DialogContent></Dialog>}
    <Dialog open={activityOpen} onOpenChange={setActivityOpen}><DialogContent dir="rtl" className="titanium-wide-dialog"><DialogHeader className="text-right"><DialogTitle>سجل النشاط المتاح لك</DialogTitle><DialogDescription>صاحب التغيير وتوقيته، وتفاصيل طلب السكرتير وتأكيده بحسب صلاحياتك.</DialogDescription></DialogHeader><div className="titanium-activity-list">{data.activity.length===0?<div className="titanium-empty">لا يوجد نشاط مسجل بعد.</div>:data.activity.map(item=><SecretaryActivity key={item.id} activity={item} viewer={currentUser} target={secretaryActivityTarget(item,currentUser,data.projects,data.tasks)} onOpen={openSecretaryTarget} />)}</div></DialogContent></Dialog>
  </main>;
}

function TaskForm({ title,setTitle,details,setDetails,priority,setPriority,due,setDue,suggested,setSuggested,users }:{ title:string;setTitle:(value:string)=>void;details:string;setDetails:(value:string)=>void;priority:string;setPriority:(value:string)=>void;due:string;setDue:(value:string)=>void;suggested:string;setSuggested:(value:string)=>void;users:User[] }) {
  return <div className="titanium-dialog-grid"><div className="titanium-field"><label>اسم المهمة</label><Input value={title} onChange={event=>setTitle(event.target.value)} placeholder="اكتب المطلوب بوضوح" /></div><div className="titanium-field"><label>التفاصيل</label><Textarea value={details} onChange={event=>setDetails(event.target.value)} placeholder="ملاحظات ومتطلبات المهمة" /></div><div className="titanium-form-row"><div className="titanium-field"><label>الأولوية</label><Select value={priority} onValueChange={setPriority}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="red">حمراء — قصوى</SelectItem><SelectItem value="yellow">صفراء — متوسطة</SelectItem><SelectItem value="green">خضراء — عادية</SelectItem></SelectContent></Select></div><div className="titanium-field"><label>موعد الإنجاز</label><Input type="date" value={due} onChange={event=>setDue(event.target.value)} /></div></div><div className="titanium-field"><label>تعيين المسؤول</label><Select value={suggested||"none"} onValueChange={value=>setSuggested(value==="none"?"":value)}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="none">غير معيّن حالياً</SelectItem>{users.filter(user=>user.id!=="basem").map(user=><SelectItem key={user.id} value={user.name}>{user.name}</SelectItem>)}</SelectContent></Select></div></div>;
}

function formatBytes(size:number) { if (size < 1024) return `${size} B`; if (size < 1048576) return `${Math.round(size/1024)} KB`; return `${(size/1048576).toFixed(1)} MB`; }

function MonitoringPanel({ monitoring, tasks, projects, now, isAdmin, onDecide }:{ monitoring:Monitoring; tasks:Task[]; projects:Project[]; now:number; isAdmin:boolean; onDecide:(approvalId:string,decision:"approved"|"rejected",note:string)=>Promise<void> }) {
  const [notes,setNotes]=useState<Record<string,string>>({});
  const today=new Date(now).toISOString().slice(0,10);
  const live=tasks.filter(task=>!task.archivedAt&&task.status!=="completed");
  const overdue=live.filter(task=>task.dueDate&&task.dueDate<today);
  const blocked=live.filter(task=>task.blocker);
  const projectName=(id:string)=>projects.find(project=>project.id===id)?.name||"";
  const summaryOf=(details:string)=>{ try { const parsed=JSON.parse(details); return typeof parsed.summary==="string"?parsed.summary:""; } catch { return ""; } };
  return <section className="titanium-monitoring">
    <div className="titanium-monitor-grid">
      <div className="titanium-monitor-card"><h3>بانتظار قرار باسم ({monitoring.approvals.length})</h3>
        {monitoring.approvals.length===0&&<p className="titanium-muted">لا توجد طلبات معلّقة.</p>}
        {monitoring.approvals.map(approval=><div className="titanium-monitor-row" key={approval.id}><div><strong>{APPROVAL_LABEL[approval.type]||approval.type}</strong><span>{approval.summary} · {approval.requestedByName} · {new Date(approval.createdAt).toLocaleDateString("ar-JO")}</span>{typeof approval.payload.reason==="string"&&<span>السبب: {approval.payload.reason}</span>}</div>
          {isAdmin&&<div className="titanium-monitor-actions"><Input value={notes[approval.id]||""} onChange={event=>setNotes(current=>({...current,[approval.id]:event.target.value}))} placeholder="ملاحظة (اختياري)" /><Button size="sm" onClick={()=>onDecide(approval.id,"approved",notes[approval.id]||"")}>اعتماد</Button><Button size="sm" variant="destructive" onClick={()=>onDecide(approval.id,"rejected",notes[approval.id]||"")}>رفض</Button></div>}</div>)}
      </div>
      <div className="titanium-monitor-card"><h3>متأخرة ({overdue.length}) · معطّلة ({blocked.length})</h3>
        {overdue.length===0&&blocked.length===0&&<p className="titanium-muted">لا يوجد تأخير أو معطّلات.</p>}
        {overdue.map(task=><div className="titanium-monitor-row" key={"o"+task.id}><div><strong>⏰ {task.title}</strong><span>{projectName(task.projectId)} · {task.owner||"غير معيّنة"} · الموعد {task.dueDate}</span></div></div>)}
        {blocked.filter(task=>!overdue.includes(task)).map(task=><div className="titanium-monitor-row" key={"b"+task.id}><div><strong>⛔ {task.title}</strong><span>{task.owner||"غير معيّنة"} · {task.blocker}</span></div></div>)}
      </div>
      <div className="titanium-monitor-card"><h3>آخر أفعال السكرتير</h3>
        {monitoring.agentActions.length===0&&<p className="titanium-muted">لا يوجد نشاط بعد.</p>}
        {monitoring.agentActions.slice(0,12).map(item=><div className="titanium-monitor-row" key={item.id}><div><strong>{summaryOf(item.details)||item.action}</strong><span>{item.actorName} · {new Date(item.createdAt).toLocaleString("ar-JO")}</span></div></div>)}
      </div>
      {isAdmin&&<div className="titanium-monitor-card"><h3>متابعات السكرتير · القواعد</h3>
        {monitoring.followups.slice(0,8).map(item=><div className="titanium-monitor-row" key={item.id}><div><strong>{FOLLOWUP_LABEL[item.kind]||item.kind}</strong><span>{item.targetUser} · {new Date(item.sentAt).toLocaleString("ar-JO")} · {item.response||"—"}</span></div></div>)}
        {monitoring.rules.length>0&&<ul className="titanium-rules">{monitoring.rules.map(rule=><li key={rule.id}>{rule.statement}</li>)}</ul>}
        {monitoring.followups.length===0&&monitoring.rules.length===0&&<p className="titanium-muted">لا توجد متابعات أو قواعد بعد.</p>}
      </div>}
    </div>
  </section>;
}


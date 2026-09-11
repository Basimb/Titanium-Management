import { DatabaseSync, type SQLInputValue, type StatementSync } from "node:sqlite";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export type TitaniumUser = {
  id: string;
  name: string;
  role: "admin" | "member";
  active: number;
};

// The __Host- prefix prevents proxy/domain ambiguity and requires the cookie
// to stay host-only, Secure, and scoped to the site root.
const SESSION_COOKIE = "__Host-titanium_session";
const SESSION_DAYS = 30;
const encoder = new TextEncoder();

type RunMeta = { changes:number; last_row_id:number | bigint | undefined };
class LocalStatement {
  private values: SQLInputValue[] = [];
  constructor(private readonly statement: StatementSync) {}
  bind(...values: SQLInputValue[]) { const next = new LocalStatement(this.statement); next.values = values; return next; }
  async first<T>() { return (this.statement.get(...this.values) as T | undefined) ?? null; }
  async all<T>() { return { results:this.statement.all(...this.values) as T[] }; }
  async run() { const result = this.statement.run(...this.values); return { meta:{ changes:Number(result.changes), last_row_id:result.lastInsertRowid } as RunMeta }; }
}

class LocalDatabase {
  private readonly sqlite: DatabaseSync;
  constructor(filename:string) { this.sqlite = new DatabaseSync(filename); this.sqlite.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;"); this.migrate(); }
  prepare(sql:string) { return new LocalStatement(this.sqlite.prepare(sql)); }
  async batch(statements:LocalStatement[]) {
    this.sqlite.exec("BEGIN IMMEDIATE");
    try { const results=[]; for (const statement of statements) results.push(await statement.run()); this.sqlite.exec("COMMIT"); return results; }
    catch (error) { this.sqlite.exec("ROLLBACK"); throw error; }
  }
  private migrate() { this.sqlite.exec(`
    CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY NOT NULL, title TEXT NOT NULL, details TEXT DEFAULT '' NOT NULL, priority TEXT DEFAULT 'yellow' NOT NULL, status TEXT DEFAULT 'open' NOT NULL, owner TEXT, suggested_owner TEXT, started_at INTEGER, due_date TEXT, completed_at INTEGER, rejection_reason TEXT, created_at INTEGER NOT NULL, updated_at INTEGER, archived_at INTEGER, archived_by TEXT);
    CREATE TABLE IF NOT EXISTS comments (id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, task_id TEXT NOT NULL, author TEXT NOT NULL, body TEXT NOT NULL, created_at INTEGER NOT NULL, FOREIGN KEY(task_id) REFERENCES tasks(id));
    CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL UNIQUE, role TEXT DEFAULT 'member' NOT NULL, active INTEGER DEFAULT 1 NOT NULL, pin_salt TEXT, pin_hash TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY NOT NULL, user_id TEXT NOT NULL, expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL, FOREIGN KEY(user_id) REFERENCES users(id));
    CREATE TABLE IF NOT EXISTS login_attempts (attempt_key TEXT PRIMARY KEY NOT NULL, attempts INTEGER DEFAULT 0 NOT NULL, last_attempt_at INTEGER NOT NULL, blocked_until INTEGER);
    CREATE TABLE IF NOT EXISTS attachments (id TEXT PRIMARY KEY NOT NULL, task_id TEXT NOT NULL, file_name TEXT NOT NULL, content_type TEXT NOT NULL, size INTEGER NOT NULL, object_key TEXT NOT NULL, uploaded_by TEXT NOT NULL, created_at INTEGER NOT NULL, FOREIGN KEY(task_id) REFERENCES tasks(id));
    CREATE TABLE IF NOT EXISTS audit_logs (id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, actor_user_id TEXT, actor_name TEXT NOT NULL, action TEXT NOT NULL, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, details TEXT DEFAULT '{}' NOT NULL, created_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
    CREATE INDEX IF NOT EXISTS idx_tasks_owner ON tasks(owner);
    CREATE INDEX IF NOT EXISTS idx_comments_task_id ON comments(task_id);
    CREATE INDEX IF NOT EXISTS idx_attachments_task_id ON attachments(task_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);
    CREATE INDEX IF NOT EXISTS idx_audit_created_at ON audit_logs(created_at);
  `); }
}

const dataDirectory = process.env.TITANIUM_DATA_DIR || path.join(process.cwd(), "data");
const uploadDirectory = path.join(dataDirectory, "uploads");
let localDatabase: LocalDatabase | null = null;
let localChatDatabase: DatabaseSync | null = null;

// Dedicated synchronous connection: a chat transaction must never join an
// existing asynchronous UI batch while it is suspended between statements.
export function chatDatabase() {
  db(); // Initialize the same application's schema and data directory first.
  if (!localChatDatabase) {
    localChatDatabase = new DatabaseSync(path.join(dataDirectory, "titanium.sqlite"));
    localChatDatabase.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
  }
  return localChatDatabase;
}

export function db() {
  if (!localDatabase) {
    requireDirectory();
    localDatabase = new LocalDatabase(path.join(dataDirectory, "titanium.sqlite"));
  }
  return localDatabase;
}

export async function ensureSeedUsers() {
  const now = Date.now();
  await db().batch([
    db().prepare("INSERT OR IGNORE INTO users (id, name, role, active, created_at, updated_at) VALUES ('basem', 'باسم', 'admin', 1, ?, ?)").bind(now, now),
    db().prepare("INSERT OR IGNORE INTO users (id, name, role, active, created_at, updated_at) VALUES ('khaled', 'خالد', 'member', 1, ?, ?)").bind(now, now),
    db().prepare("INSERT OR IGNORE INTO users (id, name, role, active, created_at, updated_at) VALUES ('shadi', 'شادي', 'member', 1, ?, ?)").bind(now, now),
    db().prepare("INSERT OR IGNORE INTO users (id, name, role, active, created_at, updated_at) VALUES ('ayman', 'أيمن', 'member', 1, ?, ?)").bind(now, now),
  ]);
}

export async function isSetupRequired() {
  await ensureSeedUsers();
  const row = await db().prepare("SELECT COUNT(*) AS count FROM users WHERE role = 'admin' AND pin_hash IS NOT NULL").first<{ count: number }>();
  return (row?.count ?? 0) === 0;
}

export function isPlatformAuthenticated(request: Request) {
  void request;
  // Initial setup is closed by default in production. Temporarily set this
  // server-side flag to 1 only while initializing a fresh database.
  return process.env.TITANIUM_ALLOW_INITIAL_SETUP === "1";
}

export async function hashPin(pin: string, salt = randomBase64(16)) {
  const key = await crypto.subtle.importKey("raw", encoder.encode(pin), "PBKDF2", false, ["deriveBits"]);
  const saltBytes = fromBase64(salt);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: saltBytes, iterations: 100_000 }, key, 256);
  return { salt, hash: toBase64(new Uint8Array(bits)) };
}

export async function verifyPin(pin: string, salt: string | null, expected: string | null) {
  if (!salt || !expected) return false;
  const result = await hashPin(pin, salt);
  return timingSafeEqual(result.hash, expected);
}

export function validPin(pin: unknown): pin is string {
  return typeof pin === "string" && /^\d{4,8}$/.test(pin);
}

export async function getSessionUser(request: Request): Promise<TitaniumUser | null> {
  await ensureSeedUsers();
  // Shared hosting proxies commonly strip the Authorization header before it
  // reaches Passenger. Use an application-specific header for the in-memory
  // mobile fallback, while retaining the host-only cookie as the primary path.
  const fallbackToken = request.headers.get("x-titanium-session")?.trim() || null;
  const token = fallbackToken || readCookie(request.headers.get("cookie"), SESSION_COOKIE);
  if (!token) return null;
  const tokenHash = await sha256(token);
  const now = Date.now();
  const user = await db().prepare(`
    SELECT u.id, u.name, u.role, u.active
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ? AND s.expires_at > ? AND u.active = 1
  `).bind(tokenHash, now).first<TitaniumUser>();
  if (!user) {
    await db().prepare("DELETE FROM sessions WHERE token_hash = ? OR expires_at <= ?").bind(tokenHash, now).run();
    return null;
  }
  return user;
}

export async function requireSession(request: Request) {
  const user = await getSessionUser(request);
  if (!user) return { user: null, response: Response.json({ error: "انتهت جلسة الدخول، سجّل دخولك من جديد" }, { status: 401 }) };
  return { user, response: null };
}

export function requireAdmin(user: TitaniumUser) {
  return user.id === "basem" && user.role === "admin" ? null : Response.json({ error: "هذه العملية خاصة بباسم فقط" }, { status: 403 });
}

export async function createSession(user: TitaniumUser, request: Request) {
  const token = randomBase64(32).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
  const tokenHash = await sha256(token);
  const now = Date.now();
  const maxAge = SESSION_DAYS * 86400;
  await db().prepare("INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)")
    .bind(tokenHash, user.id, now + maxAge * 1000, now).run();
  void request;
  return {
    token,
    cookie: `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`,
  };
}

export async function destroySession(request: Request) {
  const fallbackToken = request.headers.get("x-titanium-session")?.trim() || null;
  const token = fallbackToken || readCookie(request.headers.get("cookie"), SESSION_COOKIE);
  if (token) await db().prepare("DELETE FROM sessions WHERE token_hash = ?").bind(await sha256(token)).run();
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

export async function audit(user: TitaniumUser | null, action: string, entityType: string, entityId: string, summary: string) {
  await db().prepare("INSERT INTO audit_logs (actor_user_id, actor_name, action, entity_type, entity_id, details, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .bind(user?.id ?? null, user?.name ?? "النظام", action, entityType, entityId, JSON.stringify({ summary }), Date.now()).run();
}

export async function loginAttemptKey(request: Request, userId: string) {
  const address = request.headers.get("cf-connecting-ip") || request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  return sha256(`${userId}|${address}`);
}

export async function checkLoginBlocked(key: string) {
  const row = await db().prepare("SELECT attempts, blocked_until AS blockedUntil FROM login_attempts WHERE attempt_key = ?").bind(key).first<{ attempts: number; blockedUntil: number | null }>();
  return row?.blockedUntil && row.blockedUntil > Date.now() ? row.blockedUntil : null;
}

export async function recordFailedLogin(key: string) {
  const now = Date.now();
  const windowMs = 15 * 60 * 1000;
  const row = await db().prepare("SELECT attempts, last_attempt_at AS lastAttemptAt FROM login_attempts WHERE attempt_key = ?").bind(key).first<{ attempts: number; lastAttemptAt: number }>();
  const attempts = row && now - row.lastAttemptAt < windowMs ? row.attempts + 1 : 1;
  const blockedUntil = attempts >= 5 ? now + windowMs : null;
  await db().prepare(`
    INSERT INTO login_attempts (attempt_key, attempts, last_attempt_at, blocked_until)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(attempt_key) DO UPDATE SET attempts = excluded.attempts, last_attempt_at = excluded.last_attempt_at, blocked_until = excluded.blocked_until
  `).bind(key, attempts, now, blockedUntil).run();
  return { attempts, blockedUntil };
}

export async function clearLoginAttempts(key: string) {
  await db().prepare("DELETE FROM login_attempts WHERE attempt_key = ?").bind(key).run();
}

export function bucket() {
  return {
    async put(key:string, value:ArrayBuffer, options?:{httpMetadata?:{contentType?:string}}) { void options; const filename = safeUploadPath(key); await mkdir(path.dirname(filename), { recursive:true }); await writeFile(filename, new Uint8Array(value)); },
    async get(key:string) { try { const bytes = await readFile(safeUploadPath(key)); return { body:new Blob([bytes]).stream() }; } catch { return null; } },
    async delete(key:string) { await rm(safeUploadPath(key), { force:true }); },
  };
}

function requireDirectory() { const fs = process.getBuiltinModule("fs") as typeof import("node:fs"); fs.mkdirSync(uploadDirectory, { recursive:true }); }
function safeUploadPath(key:string) { const cleaned=key.replaceAll("\\", "/"); if (cleaned.includes("..") || cleaned.startsWith("/")) throw new Error("مسار ملف غير صالح"); return path.join(uploadDirectory, cleaned); }

function readCookie(header: string | null, name: string) {
  if (!header) return null;
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return null;
}

async function sha256(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

function randomBase64(length: number) {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return toBase64(bytes);
}

function toBase64(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(value: string) {
  const binary = atob(value);
  return Uint8Array.from(binary, char => char.charCodeAt(0));
}

function timingSafeEqual(left: string, right: string) {
  if (left.length !== right.length) return false;
  let mismatch = 0;
  for (let index = 0; index < left.length; index += 1) mismatch |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return mismatch === 0;
}

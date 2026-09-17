/**
 * Whose Odoo account a question runs as.
 *
 * Basim (2026-09-17), asked who should be allowed to ask the open questions:
 * "ممكن كل واحد حسب صلاحيته لانهم الهم يوزرات مثلي" -- everyone, each with
 * their own permissions, because they each have their own Odoo user. That is a
 * better answer than a list of allowed tables kept in this repository: Odoo
 * already knows who may see what, and it is the only thing that knows it
 * correctly. So each person's own credentials are what the query runs under,
 * and Odoo answers on its own authority.
 *
 * Which makes one rule absolute: a person with no key of their own gets
 * NOTHING. Falling back to the owner's key would hand them the owner's
 * permissions -- the exact opposite of what was asked for -- while looking
 * like it worked.
 */
import type { OdooConfig } from "./odoo-client.ts";

export type OdooPerson = { config: OdooConfig; cacheKey: string };

/**
 * The credentials for this user id, or null. Parsed fresh from the settings
 * string so a key added on the server takes effect without a restart.
 */
export function odooPersonFor(userId: string, base: { url: string; db: string }, keysJson?: string): OdooPerson | null {
  if (!userId || !keysJson || keysJson.length > 8000) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(keysJson); } catch { return null; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const entry = (parsed as Record<string, unknown>)[userId];
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
  const { username, apiKey } = entry as { username?: unknown; apiKey?: unknown };
  if (typeof username !== "string" || !username.trim() || /[\r\n]/.test(username)) return null;
  if (typeof apiKey !== "string" || !apiKey.trim() || /[\r\n]/.test(apiKey)) return null;
  return {
    config: { url: base.url, db: base.db, username: username.trim(), apiKey: apiKey.trim() },
    // Catalogs and logins are cached per person, never shared: one person's map
    // of the database is not another's.
    cacheKey: `${base.url}|${base.db}|${username.trim()}`,
  };
}

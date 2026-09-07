import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, type Stats } from "node:fs";
import path from "node:path";

const MAX_SETTINGS_BYTES = 32_768;
const ALLOWED_KEYS = ["TEAM_CHAT_ENABLED", "TEAM_CHAT_SHARED_KEY", "TEAM_CHAT_CONTACTS_JSON", "TEAM_CHAT_GROUP_IDS_JSON", "GROQ_API_KEY", "GROQ_MODEL",
  "WHATSAPP_LOGIN_ENABLED", "WHATSAPP_LOGIN_SECRET", "WHATSAPP_LOGIN_DATABASE", "WHATSAPP_LOGIN_ORIGIN", "SECRETARY_ENABLED", "SECRETARY_WEB_ENABLED", "SECRETARY_VOICE_ENABLED", "SECRETARY_FOLLOWUP_ENABLED", "TITANIUM_PUBLIC_URL", "DASHBOARD_READONLY"];

function privateRegularFile(metadata: Stats): boolean {
  return metadata.isFile() && !metadata.isSymbolicLink() && metadata.size <= MAX_SETTINGS_BYTES
    && (process.platform === "win32" || (metadata.mode & 0o077) === 0);
}

// Server-controlled path only. Keep this file outside the document root/repo.
export function readTeamChatSettings(env: NodeJS.ProcessEnv = process.env): Record<string, string | undefined> {
  const filename = env.TITANIUM_TEAM_CHAT_CONFIG;
  if (!filename) return env;
  let descriptor: number | undefined;
  try {
    if (!path.isAbsolute(filename)) throw new Error("path");
    const metadata = lstatSync(filename);
    if (!privateRegularFile(metadata)) throw new Error("file");
    // Verify the opened descriptor too, not just a path checked before reading.
    // O_NOFOLLOW rejects final-component symlinks where the OS supports it.
    descriptor = openSync(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = fstatSync(descriptor);
    if (!privateRegularFile(opened) || metadata.dev !== opened.dev || metadata.ino !== opened.ino) throw new Error("file");
    // Bound the actual read as well as the stat size; the file may grow after stat.
    const bytes = Buffer.alloc(MAX_SETTINGS_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(descriptor, bytes, length, bytes.length - length, null);
      if (count === 0) break;
      length += count;
    }
    if (length > MAX_SETTINGS_BYTES) throw new Error("size");
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length)));
    if (!value || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).some(key => !ALLOWED_KEYS.includes(key))) throw new Error("settings");
    const settings: Record<string, string | undefined> = {};
    for (const key of ALLOWED_KEYS) {
      const entry = (value as Record<string, unknown>)[key];
      if (entry !== undefined && typeof entry !== "string") throw new Error("setting");
      if (entry !== undefined) settings[key] = entry as string;
    }
    return settings;
  } catch {
    // Native filesystem errors disclose paths; JSON errors may quote key values.
    // Neither the original error nor its cause is exposed to a route or logger.
    throw new Error("Unable to load private team chat settings.");
  } finally {
    if (descriptor !== undefined) {
      try { closeSync(descriptor); } catch { /* Never disclose paths or contents. */ }
    }
  }
}

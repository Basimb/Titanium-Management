import * as nativeFs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn as nativeSpawn } from 'node:child_process';
import { loadConfig } from './config.mjs';

export const SETTINGS_KEYS = new Set(['TEAM_CHAT_ENABLED', 'TEAM_CHAT_SHARED_KEY', 'TEAM_CHAT_CONTACTS_JSON',
  'TEAM_CHAT_GROUP_IDS_JSON', 'GROQ_API_KEY', 'GROQ_MODEL', 'OPENAI_API_KEY', 'OPENAI_MODEL', 'OPENAI_SEARCH_MODEL', 'WHATSAPP_LOGIN_ENABLED',
  'WHATSAPP_LOGIN_SECRET', 'WHATSAPP_LOGIN_DATABASE', 'WHATSAPP_LOGIN_ORIGIN',
  'SECRETARY_ENABLED', 'SECRETARY_WEB_ENABLED', 'SECRETARY_VOICE_ENABLED', 'SECRETARY_FOLLOWUP_ENABLED', 'TITANIUM_PUBLIC_URL', 'DASHBOARD_READONLY',
  'ODOO_REPORT_ENABLED', 'ODOO_URL', 'ODOO_DB', 'ODOO_USERNAME', 'ODOO_API_KEY', 'ODOO_LOW_STOCK_THRESHOLD', 'ODOO_CURRENCY_LABEL',
  'ODOO_REPORT_DAILY_HOUR', 'ODOO_REPORT_WEEKLY_DAY', 'ODOO_REPORT_WEEKLY_HOUR', 'ODOO_REPORT_PURCHASES_WEEKLY_HOUR',
  // Read by the dashboard half (lib/team-chat-settings.ts) rather than by this
  // launcher, but they live in the SAME settings file, and an unknown key here
  // makes readPrivateConfig throw -- which pauses the whole bridge behind the
  // attention marker. Any key the dashboard allows must be accepted here too.
  'ODOO_REPORT_DAILY', 'ODOO_REPORT_WEEKLY', 'ODOO_REPORT_PURCHASES', 'ODOO_QUESTIONS_ENABLED', 'ODOO_EXPIRY_WINDOW_DAYS',
  'OPENAI_ROUTER_MODEL', 'ODOO_USER_KEYS_JSON']);
const MAX_BYTES = 32_768;
const SERVICE_DIRECTORY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function privateFile(stat) {
  return stat.isFile() && !stat.isSymbolicLink() && stat.size <= MAX_BYTES &&
    [0o600, 0o400].includes(stat.mode & 0o7777);
}

export function readPrivateConfig(filename, fs = nativeFs) {
  let descriptor;
  try {
    if (typeof filename !== 'string' || !path.isAbsolute(filename)) throw new Error();
    const absolute = path.resolve(filename);
    if (fs.realpathSync(absolute) !== absolute) throw new Error();
    const before = fs.lstatSync(absolute);
    if (!privateFile(before)) throw new Error();
    descriptor = fs.openSync(absolute, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const opened = fs.fstatSync(descriptor);
    if (!privateFile(opened) || before.dev !== opened.dev || before.ino !== opened.ino) throw new Error();
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = fs.readSync(descriptor, buffer, length, buffer.length - length, null);
      if (!count) break;
      length += count;
    }
    if (length > MAX_BYTES) throw new Error();
    const parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length)));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) ||
        Object.keys(parsed).some(key => !SETTINGS_KEYS.has(key)) ||
        Object.values(parsed).some(value => typeof value !== 'string')) throw new Error();
    return parsed;
  } catch {
    // Never expose native filesystem errors, JSON snippets, paths or secret values.
    throw new Error('Unable to load private bridge settings.');
  } finally {
    if (descriptor !== undefined) { try { fs.closeSync(descriptor); } catch {} }
  }
}

function normalizedContact(value) {
  if (typeof value !== 'string' || !/^[+\d\s().-]+$/.test(value)) return null;
  const result = value.replace(/\D/g, '').replace(/^00/, '');
  return /^[1-9]\d{7,14}$/.test(result) ? result : null;
}

// Re-read on every outbox authorization check. Return only the transport policy,
// never the full settings object, provider keys, names or database paths.
export function readOutboxConfig(filename, fs = nativeFs) {
  const disabled = { enabled: false, contacts: [] };
  try {
    const settings = readPrivateConfig(filename, fs);
    if (settings.TEAM_CHAT_ENABLED !== '1' || settings.SECRETARY_ENABLED !== '1') return disabled;
    const raw = JSON.parse(settings.TEAM_CHAT_CONTACTS_JSON || '[]');
    if (!Array.isArray(raw) || raw.length > 100) return disabled;
    const contacts = [];
    const numbers = new Set();
    const users = new Set();
    for (const contact of raw) {
      if (!contact || typeof contact !== 'object' || Array.isArray(contact) ||
        typeof contact.userId !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(contact.userId) ||
        (contact.active !== undefined && typeof contact.active !== 'boolean') ||
        (contact.verified !== undefined && typeof contact.verified !== 'boolean')) return disabled;
      const number = normalizedContact(contact.number);
      if (!number || numbers.has(number) || users.has(contact.userId)) return disabled;
      numbers.add(number); users.add(contact.userId);
      contacts.push({ userId: contact.userId, number,
        ...(contact.active === false ? { active: false } : {}), ...(contact.verified === false ? { verified: false } : {}) });
    }
    return { enabled: true, contacts };
  } catch { return disabled; }
}

export function bridgeChildEnvironment(settings, env, pair, serviceDirectory = SERVICE_DIRECTORY) {
  const contacts = JSON.parse(settings.TEAM_CHAT_CONTACTS_JSON || '[]');
  const groups = JSON.parse(settings.TEAM_CHAT_GROUP_IDS_JSON || '[]');
  if (!Array.isArray(contacts) || !contacts.length || contacts.length > 100 ||
      contacts.some(contact => !contact || typeof contact !== 'object' || !normalizedContact(contact.number)) ||
      !Array.isArray(groups) || groups.length > 20 ||
      groups.some(group => typeof group !== 'string' || !/^\d+(?:-\d+)?@g\.us$/.test(group))) {
    throw new Error('Invalid bridge allowlists.');
  }
  const allNumbers = contacts.map(contact => normalizedContact(contact.number));
  if (new Set(allNumbers).size !== allNumbers.length || new Set(groups).size !== groups.length) throw new Error('Duplicate bridge allowlist entry.');
  const numbers = contacts.filter(contact => contact.active !== false && contact.verified !== false)
    .map(contact => normalizedContact(contact.number));
  // Minimal environment: do not inherit GROQ keys, raw JSON, config path,
  // NODE_OPTIONS, other application secrets, or a caller's pairing/enable flags.
  const childEnv = {};
  for (const key of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'HOME', 'USERPROFILE',
    'USER', 'LOGNAME', 'TMP', 'TEMP', 'TMPDIR', 'LANG', 'LC_ALL', 'TZ',
    'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR']) {
    if (typeof env[key] === 'string') childEnv[key] = env[key];
  }
  Object.assign(childEnv, {
    TEAM_CHAT_BRIDGE_ENABLED: pair || settings.TEAM_CHAT_ENABLED === '1' ? '1' : '0',
    TEAM_CHAT_TASKS_ENABLED: settings.TEAM_CHAT_ENABLED === '1' ? '1' : '0',
    TEAM_CHAT_PAIR: pair ? '1' : '0',
    TEAM_CHAT_SHARED_KEY: settings.TEAM_CHAT_SHARED_KEY,
    TEAM_CHAT_ALLOWED_NUMBERS: numbers.join(','),
    TEAM_CHAT_ALLOWED_GROUPS: groups.join(','),
    TEAM_CHAT_BOT_NUMBER: env.TEAM_CHAT_BOT_NUMBER,
    TEAM_CHAT_BACKEND_URL: env.TEAM_CHAT_BACKEND_URL,
    TEAM_CHAT_STATE_DIR: env.TEAM_CHAT_STATE_DIR,
    SECRETARY_ENABLED: settings.SECRETARY_ENABLED === '1' ? '1' : '0',
    SECRETARY_VOICE_ENABLED: settings.SECRETARY_ENABLED === '1' && settings.SECRETARY_VOICE_ENABLED === '1' ? '1' : '0',
    SECRETARY_FOLLOWUP_ENABLED: settings.SECRETARY_ENABLED === '1' && settings.SECRETARY_FOLLOWUP_ENABLED === '1' ? '1' : '0',
    ...(typeof settings.TITANIUM_PUBLIC_URL === 'string' && /^https:\/\/[\w.-]+\/?$/.test(settings.TITANIUM_PUBLIC_URL) ? { TITANIUM_PUBLIC_URL: settings.TITANIUM_PUBLIC_URL } : {}),
  });
  // Explicit owner consent: this key is used only for bounded voice transcription on the server.
  if (childEnv.SECRETARY_VOICE_ENABLED === '1') {
    if (typeof settings.OPENAI_API_KEY !== 'string' || !settings.OPENAI_API_KEY.trim() || /[\r\n]/.test(settings.OPENAI_API_KEY)) throw new Error('Voice settings unavailable.');
    childEnv.OPENAI_API_KEY = settings.OPENAI_API_KEY;
  }
  // Read-only pharmacy sales/inventory reports. A misconfigured Odoo setting only
  // disables this one feature -- it must never take down the whole WhatsApp bridge.
  // The settings file is the preferred home, but these same values are also
  // exported by the supervisor script that starts this launcher, and that script
  // is as owner-private as the settings file is. Reading them from either place
  // means an existing install keeps working without its secrets being rewritten
  // by hand -- the launcher's own environment is already trusted for the path of
  // the settings file itself. Every value is validated below either way.
  const odoo = key => {
    const stored = settings[key];
    if (typeof stored === 'string' && stored.trim()) return stored;
    const inherited = env[key];
    return typeof inherited === 'string' && inherited.trim() ? inherited : undefined;
  };
  const odooUrl = odoo('ODOO_URL'), odooDb = odoo('ODOO_DB');
  const odooUser = odoo('ODOO_USERNAME'), odooKey = odoo('ODOO_API_KEY');
  const odooEnabled = childEnv.SECRETARY_ENABLED === '1' && odoo('ODOO_REPORT_ENABLED') === '1'
    && typeof odooUrl === 'string' && /^https:\/\/[\w.-]+(?::\d+)?$/.test(odooUrl)
    && typeof odooDb === 'string' && !/[\r\n]/.test(odooDb)
    && typeof odooUser === 'string' && !/[\r\n]/.test(odooUser)
    && typeof odooKey === 'string' && !/[\r\n]/.test(odooKey);
  childEnv.ODOO_REPORT_ENABLED = odooEnabled ? '1' : '0';
  if (odooEnabled) {
    childEnv.ODOO_URL = odooUrl;
    childEnv.ODOO_DB = odooDb;
    childEnv.ODOO_USERNAME = odooUser;
    childEnv.ODOO_API_KEY = odooKey;
    if (/^\d{1,4}$/.test(odoo('ODOO_LOW_STOCK_THRESHOLD') || '')) childEnv.ODOO_LOW_STOCK_THRESHOLD = odoo('ODOO_LOW_STOCK_THRESHOLD');
    const currency = odoo('ODOO_CURRENCY_LABEL');
    if (typeof currency === 'string' && currency.length <= 20 && !/[\r\n]/.test(currency)) childEnv.ODOO_CURRENCY_LABEL = currency;
    if (/^([0-9]|1[0-9]|2[0-3])$/.test(odoo('ODOO_REPORT_DAILY_HOUR') || '')) childEnv.ODOO_REPORT_DAILY_HOUR = odoo('ODOO_REPORT_DAILY_HOUR');
    if (/^[0-6]$/.test(odoo('ODOO_REPORT_WEEKLY_DAY') || '')) childEnv.ODOO_REPORT_WEEKLY_DAY = odoo('ODOO_REPORT_WEEKLY_DAY');
    if (/^([0-9]|1[0-9]|2[0-3])$/.test(odoo('ODOO_REPORT_WEEKLY_HOUR') || '')) childEnv.ODOO_REPORT_WEEKLY_HOUR = odoo('ODOO_REPORT_WEEKLY_HOUR');
    if (/^([0-9]|1[0-9]|2[0-3])$/.test(odoo('ODOO_REPORT_PURCHASES_WEEKLY_HOUR') || '')) childEnv.ODOO_REPORT_PURCHASES_WEEKLY_HOUR = odoo('ODOO_REPORT_PURCHASES_WEEKLY_HOUR');
    // Per-report routing (off | group | owner | both). This list is the only
    // way a setting reaches the bridge child at all -- the child environment is
    // built from scratch above and inherits nothing, which is exactly why the
    // reports stayed silent on 2026-09-17 while every ODOO_ export sat in
    // run-bridge.sh: the child never saw one of them. A routing value that is
    // not one of the four words is dropped rather than passed through, so a
    // typo leaves the report on its built-in default instead of disabling it.
    for (const key of ['ODOO_REPORT_DAILY', 'ODOO_REPORT_WEEKLY', 'ODOO_REPORT_PURCHASES']) {
      const routing = String(odoo(key) || '').trim().toLowerCase();
      if (/^(off|group|owner|both)$/.test(routing)) childEnv[key] = routing;
    }
  }
  // Phone/user mapping only; no names or AI key. launchPrivate separately grants
  // the validated settings path for fresh outbox authorization, never from an override.
  if (path.isAbsolute(settings.WHATSAPP_LOGIN_DATABASE || '')) {
    childEnv.TEAM_CHAT_AUTH_DATABASE = settings.WHATSAPP_LOGIN_DATABASE;
    childEnv.TEAM_CHAT_AUTH_CONTACTS_JSON = JSON.stringify(contacts.map(contact => ({
      userId: contact.userId, number: normalizedContact(contact.number),
      ...(contact.active === false ? { active: false } : {}), ...(contact.verified === false ? { verified: false } : {}),
    })));
  }
  loadConfig(childEnv, serviceDirectory);
  return childEnv;
}

function privateStateDirectory(directory, fs) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o7777) !== 0o700 ||
      fs.realpathSync(directory) !== path.resolve(directory)) throw new Error('Invalid private state directory.');
}

function markerExists(marker, fs) {
  try {
    const stat = fs.lstatSync(marker);
    if (!privateFile(stat)) throw new Error('Invalid attention marker.');
    return true;
  } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

function writeMarker(marker, fs, now) {
  if (markerExists(marker, fs)) return;
  let descriptor;
  try {
    descriptor = fs.openSync(marker, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL |
      (fs.constants.O_NOFOLLOW || 0), 0o600);
    fs.writeFileSync(descriptor, JSON.stringify({ reason: 'child_exit_78', at: now() }) + '\n', 'utf8');
    fs.fsyncSync(descriptor);
  } finally { if (descriptor !== undefined) fs.closeSync(descriptor); }
}

export async function launchPrivate({ env = process.env, args = process.argv.slice(2), fs = nativeFs,
  spawn = nativeSpawn, signalSource = process, execPath = process.execPath,
  serviceDirectory = SERVICE_DIRECTORY, now = Date.now, report = message => console.error(message) } = {}) {
  try {
    if (args.length > 1 || (args.length === 1 && args[0] !== '--pair')) throw new Error();
    const pair = args[0] === '--pair';
    const settingsPath = env.TITANIUM_TEAM_CHAT_CONFIG;
    const settings = readPrivateConfig(settingsPath, fs);
    if (!pair && settings.TEAM_CHAT_ENABLED !== '1') return 0;
    const childEnv = bridgeChildEnvironment(settings, env, pair, serviceDirectory);
    if (childEnv.SECRETARY_ENABLED === '1' && childEnv.TEAM_CHAT_AUTH_DATABASE) {
      childEnv.TEAM_CHAT_AUTH_CONFIG_PATH = path.resolve(settingsPath);
    }
    const directory = path.resolve(childEnv.TEAM_CHAT_STATE_DIR);
    privateStateDirectory(directory, fs);
    const marker = path.join(directory, 'needs-attention.marker');
    const recovering = markerExists(marker, fs);
    if (recovering && !pair) {
      report('Bridge paused for owner attention. Use explicit --pair only for owner-supervised recovery.');
      return 78;
    }
    let child;
    try {
      child = spawn(execPath, [path.join(serviceDirectory, 'src', 'main.mjs')], {
        cwd: serviceDirectory, env: childEnv, shell: false, windowsHide: true,
        // main.mjs emits only sanitized status and the explicitly requested pairing code.
        stdio: ['ignore', 'inherit', 'inherit'],
      });
    } catch {
      writeMarker(marker, fs, now);
      throw new Error();
    }
    let requestedSignal;
    const handlers = new Map(['SIGTERM', 'SIGINT'].map(signal => [signal, () => {
      requestedSignal = signal;
      try { child.kill(signal); } catch { report('Unable to forward shutdown; waiting for the bridge child to exit.'); }
    }]));
    for (const [signal, handler] of handlers) signalSource.on(signal, handler);
    const result = await new Promise(resolve => {
      let finished = false;
      const finish = code => {
        if (finished) return;
        finished = true;
        for (const [signal, handler] of handlers) signalSource.removeListener(signal, handler);
        resolve(code);
      };
      child.once('error', () => finish(78));
      child.once('close', (code, signal) => {
        if (Number.isInteger(code)) finish(code);
        else finish(requestedSignal && signal === requestedSignal ? 0 : 78);
      });
    });
    if (result === 78) writeMarker(marker, fs, now);
    else if (result === 0 && pair && recovering && markerExists(marker, fs)) {
      // Remove ONLY the validated attention marker after explicit successful recovery.
      // Credentials, session keys, queues and settings are never deleted or rewritten.
      fs.unlinkSync(marker);
    }
    return result;
  } catch {
    report('Private bridge launcher could not proceed. Check protected settings/state and supervisor configuration.');
    return 78;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = await launchPrivate();
}


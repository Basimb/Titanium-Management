import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.mjs';
import { openStore, createAuthState } from './store.mjs';
import { createBridgeRuntime } from './runtime.mjs';
import { createContactAuthorizer } from './group-privacy.mjs';
import { openControl } from './control.mjs';
import { createVoiceTranscriber } from './voice.mjs';
import { readOutboxConfig } from './launch-private.mjs';

// off | group | owner | both -> the routing lib/odoo-reports.ts expects.
// Anything else (including unset) returns an empty object, which leaves that
// report on its built-in default rather than silently disabling it.
function reportRouting(value) {
  const key = String(value || '').trim().toLowerCase();
  if (key === 'off') return { enabled: false };
  if (key === 'group') return { enabled: true, group: true, owner: false };
  if (key === 'owner') return { enabled: true, group: false, owner: true };
  if (key === 'both') return { enabled: true, group: true, owner: true };
  return {};
}
async function main() {
  if (process.env.TEAM_CHAT_BRIDGE_ENABLED !== '1') {
    console.info('Titanium bridge is disabled; no WhatsApp connection was started.');
    return;
  }
  const config = loadConfig(process.env, path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
  const { default: makeWASocket, BufferJSON, initAuthCreds, proto, jidNormalizedUser, makeCacheableSignalKeyStore, DisconnectReason, downloadContentFromMessage,
    generateWAMessageContent, generateWAMessage, decryptPollVote, normalizeMessageContent } = await import('baileys');
  const { default: pino } = await import('pino');
  const logger = pino({ level: 'silent' });
  process.umask(0o077);
  const store = openStore(config.stateDirectory);
  const auth = createAuthState(store, { BufferJSON, initAuthCreds, proto });
  const control = openControl(config.stateDirectory);
  control.recover();
  let isActiveNumber = () => false;
  let secretaryJobs;
  let secretaryOutbox;
  let agentFollowups;
  let odooReportJobs;
  if (process.env.TEAM_CHAT_AUTH_DATABASE) {
    const { DatabaseSync } = await import('node:sqlite');
    const { lstatSync, realpathSync } = await import('node:fs');
    const filename = process.env.TEAM_CHAT_AUTH_DATABASE;
    if (!path.isAbsolute(filename) || realpathSync(filename) !== filename ||
      !lstatSync(filename).isFile() || lstatSync(filename).isSymbolicLink()) throw new Error('Invalid authorization database.');
    const authorizationDb = new DatabaseSync(filename, { readOnly: true });
    authorizationDb.exec('PRAGMA busy_timeout = 5000;');
    const contacts = JSON.parse(process.env.TEAM_CHAT_AUTH_CONTACTS_JSON);
    if (!Array.isArray(contacts)) throw new Error('Invalid authorization contacts.');
    isActiveNumber = createContactAuthorizer({ db: authorizationDb, contacts: () => contacts });
    if (process.env.SECRETARY_ENABLED === '1') {
      const { createSecretaryJobs } = await import('../../../lib/secretary-jobs.ts');
      const { createSecretaryOutboxJobs } = await import('../../../lib/secretary-outbox.ts');
      const jobsDb = new DatabaseSync(filename);
      jobsDb.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;');
      secretaryJobs = createSecretaryJobs({ db: jobsDb, config: { enabled: true,
        contacts, allowedGroupIds: [...config.allowedGroups] } });
      const outboxSettingsPath = process.env.TEAM_CHAT_AUTH_CONFIG_PATH;
      secretaryOutbox = createSecretaryOutboxJobs({ db: jobsDb, config: () => readOutboxConfig(outboxSettingsPath) });
      const { createFollowupJobs } = await import('../../../lib/agent-followups.ts');
      agentFollowups = createFollowupJobs({ db: jobsDb, config: () => ({
        enabled: process.env.SECRETARY_FOLLOWUP_ENABLED === '1', contacts,
        groupId: [...config.allowedGroups][0] ?? null, publicUrl: process.env.TITANIUM_PUBLIC_URL || undefined }) });
      const { createOdooReportJobs } = await import('../../../lib/odoo-reports.ts');
      odooReportJobs = createOdooReportJobs({ db: jobsDb, config: () => ({
        enabled: process.env.ODOO_REPORT_ENABLED === '1' && !!process.env.ODOO_URL && !!process.env.ODOO_DB
          && !!process.env.ODOO_USERNAME && !!process.env.ODOO_API_KEY,
        odoo: { url: process.env.ODOO_URL || '', db: process.env.ODOO_DB || '', username: process.env.ODOO_USERNAME || '', apiKey: process.env.ODOO_API_KEY || '' },
        ownerNumber: contacts.find(contact => contact.userId === 'basem')?.number ?? '',
        groupId: [...config.allowedGroups][0] ?? null,
        lowStockThreshold: process.env.ODOO_LOW_STOCK_THRESHOLD ? Number(process.env.ODOO_LOW_STOCK_THRESHOLD) : undefined,
        currencyLabel: process.env.ODOO_CURRENCY_LABEL || undefined,
        dailyHour: process.env.ODOO_REPORT_DAILY_HOUR ? Number(process.env.ODOO_REPORT_DAILY_HOUR) : undefined,
        weeklyDay: process.env.ODOO_REPORT_WEEKLY_DAY ? Number(process.env.ODOO_REPORT_WEEKLY_DAY) : undefined,
        weeklyHour: process.env.ODOO_REPORT_WEEKLY_HOUR ? Number(process.env.ODOO_REPORT_WEEKLY_HOUR) : undefined,
        purchasesWeeklyHour: process.env.ODOO_REPORT_PURCHASES_WEEKLY_HOUR ? Number(process.env.ODOO_REPORT_PURCHASES_WEEKLY_HOUR) : undefined,
        // Per-report routing, one env var each: off | group | owner | both.
        // Unset keeps the built-in default for that report (see DEFAULT_ROUTING
        // in lib/odoo-reports.ts), so switching one off is a config change.
        routing: {
          odoo_daily: reportRouting(process.env.ODOO_REPORT_DAILY),
          odoo_weekly: reportRouting(process.env.ODOO_REPORT_WEEKLY),
          odoo_purchases_weekly: reportRouting(process.env.ODOO_REPORT_PURCHASES),
        },
      }) });
    }
  }
  const runtime = createBridgeRuntime({
    config, store, auth, makeWASocket, jidNormalizedUser, makeCacheableSignalKeyStore, DisconnectReason, logger,
    control, isActiveNumber, secretaryJobs, secretaryOutbox, agentFollowups, odooReportJobs, proto, generateWAMessageContent, generateWAMessage, decryptPollVote, normalizeMessageContent,
    ...(config.voiceEnabled ? { transcribeVoice: createVoiceTranscriber({ apiKey: process.env.OPENAI_API_KEY, downloadContent: downloadContentFromMessage }) } : {}),
    onStop: code => { process.exitCode = code === 'service_shutdown' ? 0 : 78; },
  });
  process.once('SIGTERM', () => runtime.stop('service_shutdown'));
  process.once('SIGINT', () => runtime.stop('service_shutdown'));
  await runtime.start();
}

main().catch(() => {
  console.error('Titanium bridge could not start. Check configuration, dependency compatibility, and private storage.');
  process.exitCode = 78;
});

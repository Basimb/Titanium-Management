import path from 'node:path';
import { installSessionLogSafety } from './log-safety.mjs';
installSessionLogSafety();
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
    generateWAMessageContent, generateWAMessage, decryptPollVote, normalizeMessageContent, fetchLatestBaileysVersion } = await import('baileys');
  // WhatsApp refuses a client whose protocol version it no longer accepts, and
  // the refusal is a 401 on connect -- BEFORE any pairing code is issued, which
  // is exactly the symptom that stranded the bridge (2026-09-28: fresh number,
  // registered=false, no creds ever written, an hour's wait no help). The
  // version baked into a pinned baileys ages out; fetching the current one at
  // startup keeps the handshake acceptable. A fetch failure must not strand the
  // bridge, so fall back to the library's built-in version.
  let waVersion;
  try { waVersion = (await fetchLatestBaileysVersion()).version; }
  catch { waVersion = undefined; }
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
  let odooReportJobs, clinicReportJobs;
  let backendFetcher;
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
      // The secretary itself (Basim, 2026-10-09: "الغي الموقع تماما"). Every
      // message used to be POSTed to the website, which answered it; the same
      // backend now runs here, reading the same settings file and the same
      // database, and the website is no longer needed to answer anything.
      // The two env names are the ones lib/titanium-server.ts and
      // lib/team-chat-settings.ts have always read, set before they load.
      if (outboxSettingsPath) {
        process.env.TITANIUM_TEAM_CHAT_CONFIG = outboxSettingsPath;
        process.env.TITANIUM_DATA_DIR = path.dirname(filename);
        const { localTeamChatFetcher } = await import('../../../lib/team-chat-backend.ts');
        backendFetcher = localTeamChatFetcher();
      }
      const { createFollowupJobs } = await import('../../../lib/agent-followups.ts');
      agentFollowups = createFollowupJobs({ db: jobsDb, config: () => ({
        enabled: process.env.SECRETARY_FOLLOWUP_ENABLED === '1', contacts,
        groupId: [...config.allowedGroups][0] ?? null, publicUrl: process.env.TITANIUM_PUBLIC_URL || undefined }) });
      // Basim: Amin observes changes by staff and assistants, not only his own actions.
      try {
        const {createAminServerWorker,serverWorkInstalled,planAminServerStep,localAminServerRpc}=await import('../../../lib/amin-server-work.ts');
        const {readTeamChatSettings}=await import('../../../lib/team-chat-settings.ts');
        if(serverWorkInstalled()){
          const hostCatalog=await localAminServerRpc('tools/list',{});
          if(!hostCatalog?.ok||!Array.isArray(hostCatalog.result?.tools)||!hostCatalog.result.tools.some(t=>t.name==='file_hash'))throw Error('HOST_TOOLS_UNAVAILABLE');
          const serverWorker=createAminServerWorker({db:jobsDb,
            enabled:()=>process.env.SECRETARY_FOLLOWUP_ENABLED==='1' && contacts.some(c=>c.userId==='basem'),
            plan:(messages,tools)=>{const settings=readTeamChatSettings();if(!settings.OPENAI_API_KEY)throw Error('MODEL_UNAVAILABLE');return planAminServerStep(messages,tools,{apiKey:settings.OPENAI_API_KEY,model:settings.OPENAI_MODEL});}});
          const serverTimer=setInterval(()=>{void serverWorker.tick();},3000);serverTimer.unref();
          const stopServer=()=>{clearInterval(serverTimer);serverWorker.stop();};process.once('SIGTERM',stopServer);process.once('SIGINT',stopServer);
          console.info('Amin server work: ready; ownerOnly=true; hostToolCount='+hostCatalog.result.tools.length+'; writeApproval=per-action.');
        }
      }catch{console.warn('Amin server work: initialization_failed; existing WhatsApp functions continue.');}
      // This is a scoped observer, never a claim that all direct access is gated.
      try {
        const { createAminChangeMonitor } = await import('../../../lib/amin-change-monitor.ts');
        const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
        const monitor = createAminChangeMonitor({ db: jobsDb,
          enabled: () => process.env.SECRETARY_FOLLOWUP_ENABLED === '1' && contacts.some(c => c.userId === 'basem'),
          roots: [path.join(repository,'lib'),path.join(repository,'services/whatsapp-bridge/src'),path.join(repository,'scripts'),
            path.resolve(repository,'../../public_html/idara'),path.resolve(repository,'../../public_html/amin')] });
        const coverage=monitor.coverage();
        console.info('Amin change monitor: ready; selectedSourceRoots='+coverage.paths.length+'; unavailableRoots='+coverage.unavailable.length+'; scope=management-audit-and-selected-files; universalGate=false.');
        const monitorTimer=setInterval(()=>{try{monitor.tick();}catch{console.warn('Amin change monitor: tick_failed; no unverified report marked as sent.');}},30_000);
        monitorTimer.unref();
        const stopMonitor=()=>{clearInterval(monitorTimer);monitor.stop();};
        process.once('SIGTERM',stopMonitor);process.once('SIGINT',stopMonitor);
      } catch { console.warn('Amin change monitor: initialization_failed; other bridge functions continue.'); }
      // Basim approved read-only product-card change notifications, excluding sales.
      try {
        const {createProductMonitor,createProductReader}=await import('../../../lib/amin-odoo-product-monitor.ts');
        const {enqueueAgentMessage}=await import('../../../lib/agent-followups.ts');
        const productMonitor=createProductMonitor({db:jobsDb,
          enabled:()=>process.env.SECRETARY_FOLLOWUP_ENABLED==='1' && contacts.some(c=>c.userId==='basem') && !!process.env.ODOO_URL && !!process.env.ODOO_API_KEY,
          read:createProductReader(()=>({url:process.env.ODOO_URL||'',db:process.env.ODOO_DB||'',username:process.env.ODOO_USERNAME||'',apiKey:process.env.ODOO_API_KEY||''})),
          enqueue:(text,at)=>enqueueAgentMessage(jobsDb,{toUser:'basem',source:'amin_odoo_products',text},at),
          statusPath:'/home/titani24/qa_data/amin/learning/odoo-product-monitor-status.json'});
        const productTimer=setInterval(()=>{void productMonitor.tick();},10000);productTimer.unref();
        void productMonitor.tick();
        const stopProducts=()=>{clearInterval(productTimer);productMonitor.stop();};
        process.once('SIGTERM',stopProducts);process.once('SIGINT',stopProducts);
      }catch{console.warn('Amin product monitor: initialization_failed; other bridge functions continue.');}
      const { createOdooReportJobs } = await import('../../../lib/odoo-reports.ts');
      odooReportJobs = createOdooReportJobs({ db: jobsDb, config: () => ({
        enabled: process.env.ODOO_REPORT_ENABLED === '1' && !!process.env.ODOO_URL && !!process.env.ODOO_DB
          && !!process.env.ODOO_USERNAME && !!process.env.ODOO_API_KEY,
        odoo: { url: process.env.ODOO_URL || '', db: process.env.ODOO_DB || '', username: process.env.ODOO_USERNAME || '', apiKey: process.env.ODOO_API_KEY || '' },
        ownerNumber: contacts.find(contact => contact.userId === 'basem')?.number ?? '',
        groupId: [...config.allowedGroups][0] ?? null,
        currencyLabel: process.env.ODOO_CURRENCY_LABEL || undefined,
        dailyHour: process.env.ODOO_REPORT_DAILY_HOUR ? Number(process.env.ODOO_REPORT_DAILY_HOUR) : undefined,
        dailyMinute: process.env.ODOO_REPORT_DAILY_MINUTE ? Number(process.env.ODOO_REPORT_DAILY_MINUTE) : undefined,
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
      // The clinics' daily money report: its own client, its own queue, its
      // own credentials. Off unless CLINIC_URL/EMAIL/PASSWORD are all set, so
      // a pharmacy-only install behaves exactly as it did before.
      const { createClinicReportJobs } = await import('../../../lib/clinic-reports.ts');
      clinicReportJobs = createClinicReportJobs({ db: jobsDb, config: () => ({
        enabled: process.env.CLINIC_REPORT_ENABLED === '1' && !!process.env.CLINIC_URL
          && !!process.env.CLINIC_EMAIL && !!process.env.CLINIC_PASSWORD,
        clinic: { url: process.env.CLINIC_URL || '', email: process.env.CLINIC_EMAIL || '', password: process.env.CLINIC_PASSWORD || '' },
        groupId: [...config.allowedGroups][0] ?? null,
        ownerNumber: contacts.find(contact => contact.userId === 'basem')?.number ?? '',
        toOwner: process.env.CLINIC_REPORT_OWNER === '1',
        currencyLabel: process.env.CLINIC_CURRENCY_LABEL || process.env.ODOO_CURRENCY_LABEL || undefined,
        dailyHour: process.env.CLINIC_REPORT_HOUR ? Number(process.env.CLINIC_REPORT_HOUR) : undefined,
        dailyMinute: process.env.CLINIC_REPORT_MINUTE ? Number(process.env.CLINIC_REPORT_MINUTE) : undefined,
      }) });
    }
  }
  const runtime = createBridgeRuntime({
    config, store, auth, makeWASocket, waVersion, jidNormalizedUser, makeCacheableSignalKeyStore, DisconnectReason, logger,
    control, isActiveNumber, secretaryJobs, secretaryOutbox, agentFollowups, odooReportJobs, clinicReportJobs, proto, generateWAMessageContent, generateWAMessage, decryptPollVote, normalizeMessageContent,
    ...(backendFetcher ? { fetcher: backendFetcher } : {}),
    ...(config.voiceEnabled ? { transcribeVoice: createVoiceTranscriber({ apiKey: process.env.OPENAI_API_KEY, downloadContent: downloadContentFromMessage }) } : {}),
    onStop: code => { process.exitCode = code === 'service_shutdown' ? 0 : 78; },
  });
  process.once('SIGTERM', () => runtime.stop('service_shutdown'));
  process.once('SIGINT', () => runtime.stop('service_shutdown'));
  await runtime.start();
}

main().catch((error) => {
  console.error('Titanium bridge could not start. Check configuration, dependency compatibility, and private storage.', String(error && error.stack || error).replace(/\s+/g, ' ').slice(0, 600));
  process.exitCode = 78;
});

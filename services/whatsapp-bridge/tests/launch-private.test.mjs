import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { constants } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { readPrivateConfig, readOutboxConfig, bridgeChildEnvironment, launchPrivate } from '../src/launch-private.mjs';

const serviceDirectory = path.join(os.tmpdir(), 'private-launch-repo', 'services', 'whatsapp-bridge');
const configFile = path.join(os.tmpdir(), 'private-launch-settings.json');
const stateDirectory = path.join(os.tmpdir(), 'private-launch-state');
const marker = path.join(stateDirectory, 'needs-attention.marker');
const secret = 'ab'.repeat(32);
const settings = { TEAM_CHAT_ENABLED: '1', TEAM_CHAT_SHARED_KEY: secret,
  TEAM_CHAT_CONTACTS_JSON: JSON.stringify([{ userId: 'test-user', number: '+1 (555) 123-4567' }]),
  TEAM_CHAT_GROUP_IDS_JSON: JSON.stringify(['120363000000000000@g.us']),
  GROQ_API_KEY: 'synthetic-secret-never-forward', GROQ_MODEL: 'synthetic-model' };
const env = { TITANIUM_TEAM_CHAT_CONFIG: configFile, TEAM_CHAT_BOT_NUMBER: '15551234568',
  TEAM_CHAT_BACKEND_URL: 'https://example.com/api/whatsapp/team-chat', TEAM_CHAT_STATE_DIR: stateDirectory,
  GROQ_API_KEY: 'inherited-secret-never-forward', NODE_OPTIONS: '--untrusted-runtime-option', PATH: '/safe/test/path' };

function fixture(overrides = {}) {
  const entries = new Map();
  const descriptors = new Map();
  let sequence = 10;
  function put(filename, value, extra = {}) {
    entries.set(filename, { content: Buffer.from(value), mode: 0o100600, ino: ++sequence, dev: 1,
      directory: false, symlink: false, ...extra });
  }
  const enoent = () => Object.assign(new Error('native error with a private path'), { code: 'ENOENT' });
  const get = filename => { if (!entries.has(filename)) throw enoent(); return entries.get(filename); };
  function stat(entry) { return { size: entry.reportedSize ?? entry.content.length, mode: entry.mode,
    ino: entry.ino, dev: entry.dev, isFile: () => !entry.directory && !entry.symlink,
    isSymbolicLink: () => entry.symlink, isDirectory: () => entry.directory }; }
  put(configFile, JSON.stringify({ ...settings, ...overrides }));
  const fs = {
    constants,
    realpathSync: filename => { get(filename); return filename; },
    lstatSync: filename => stat(get(filename)),
    mkdirSync: filename => { if (!entries.has(filename)) put(filename, '', { directory: true, mode: 0o40700 }); },
    openSync(filename, flags, mode) {
      if (flags & constants.O_CREAT) {
        if (entries.has(filename)) throw Object.assign(new Error(), { code: 'EEXIST' });
        put(filename, '', { mode: 0o100000 | mode });
      }
      get(filename);
      const descriptor = ++sequence;
      descriptors.set(descriptor, { filename, offset: 0 });
      return descriptor;
    },
    fstatSync: descriptor => stat(get(descriptors.get(descriptor).filename)),
    readSync(descriptor, buffer, offset, length) {
      const handle = descriptors.get(descriptor);
      const entry = get(handle.filename);
      const count = Math.min(length, entry.content.length - handle.offset);
      entry.content.copy(buffer, offset, handle.offset, handle.offset + count);
      handle.offset += count;
      return count;
    },
    writeFileSync(descriptor, content) { get(descriptors.get(descriptor).filename).content = Buffer.from(content); },
    fsyncSync() {}, closeSync: descriptor => descriptors.delete(descriptor),
    unlinkSync: filename => entries.delete(filename),
  };
  const signals = new EventEmitter();
  const reports = [];
  const spawns = [];
  const child = new EventEmitter();
  child.kills = [];
  child.kill = signal => child.kills.push(signal);
  const dependencies = { env, fs, signalSource: signals, serviceDirectory, execPath: '/trusted/node22',
    report: message => reports.push(message), now: () => 1_800_000_000_000,
    spawn: (...args) => { spawns.push(args); return child; } };
  return { entries, put, fs, signals, reports, spawns, child, dependencies };
}

test('private JSON reader accepts only absolute regular nonsymlink 0600/0400 files and sanitizes failures', () => {
  const f = fixture();
  assert.equal(readPrivateConfig(configFile, f.fs).TEAM_CHAT_SHARED_KEY, secret);
  f.entries.get(configFile).mode = 0o100400;
  assert.equal(readPrivateConfig(configFile, f.fs).TEAM_CHAT_ENABLED, '1');
  assert.throws(() => readPrivateConfig('relative.json', f.fs), { message: 'Unable to load private bridge settings.' });
  for (const change of [{ mode: 0o100644 }, { mode: 0o100700 }, { directory: true }, { symlink: true },
    { content: Buffer.from('invalid synthetic-secret-never-forward') },
    { content: Buffer.alloc(32_769, 65), reportedSize: 10 }]) {
    const sample = fixture();
    Object.assign(sample.entries.get(configFile), change);
    assert.throws(() => readPrivateConfig(configFile, sample.fs), { message: 'Unable to load private bridge settings.' });
  }
  const changed = fixture();
  const original = changed.fs.fstatSync;
  changed.fs.fstatSync = descriptor => ({ ...original(descriptor), ino: 999_999 });
  assert.throws(() => readPrivateConfig(configFile, changed.fs), { message: 'Unable to load private bridge settings.' });
});

test('child receives normalized allowlists and no Groq/config/inherited runtime secrets', () => {
  const child = bridgeChildEnvironment(settings, env, false, serviceDirectory);
  assert.equal(child.TEAM_CHAT_ALLOWED_NUMBERS, '15551234567');
  assert.equal(child.TEAM_CHAT_ALLOWED_GROUPS, '120363000000000000@g.us');
  assert.equal(child.TEAM_CHAT_SHARED_KEY, secret);
  assert.equal(child.TEAM_CHAT_PAIR, '0');
  assert.equal(child.TEAM_CHAT_BOT_NUMBER, env.TEAM_CHAT_BOT_NUMBER);
  for (const name of ['GROQ_API_KEY', 'GROQ_MODEL', 'TITANIUM_TEAM_CHAT_CONFIG', 'TEAM_CHAT_CONTACTS_JSON', 'NODE_OPTIONS']) {
    assert.equal(Object.hasOwn(child, name), false);
  }
  assert.equal(JSON.stringify(child).includes('synthetic-secret'), false);
});

test('shared read-only dashboard config does not disable bridge or leak into child environment', () => {
  const f = fixture({ DASHBOARD_READONLY: '1', SECRETARY_ENABLED: '1' });
  const config = readPrivateConfig(configFile, f.fs);
  assert.equal(readOutboxConfig(configFile, f.fs).enabled, true);
  const child = bridgeChildEnvironment(config, env, false, serviceDirectory);
  assert.equal(child.TEAM_CHAT_BRIDGE_ENABLED, '1');
  assert.equal(child.DASHBOARD_READONLY, undefined);
});

test('shared read-only dashboard config does not disable bridge or leak into child environment', () => {
  const f = fixture({ DASHBOARD_READONLY: '1', SECRETARY_ENABLED: '1' });
  const config = readPrivateConfig(configFile, f.fs);
  assert.equal(readOutboxConfig(configFile, f.fs).enabled, true);
  const child = bridgeChildEnvironment(config, env, false, serviceDirectory);
  assert.equal(child.TEAM_CHAT_BRIDGE_ENABLED, '1');
  assert.equal(child.DASHBOARD_READONLY, undefined);
});

test('outbox policy re-reads remapping, contact flags and disable switches without retaining private settings', () => {
  const current = { ...settings, SECRETARY_ENABLED: '1' };
  const f = fixture({ SECRETARY_ENABLED: '1' });
  assert.deepEqual(readOutboxConfig(configFile, f.fs), { enabled: true, contacts: [{ userId: 'test-user', number: '15551234567' }] });
  for (const contact of [
    { userId: 'replacement', number: '15551234567', name: 'SYNTHETIC_PRIVATE_NAME' },
    { userId: 'test-user', number: '15551230000' },
    { userId: 'test-user', number: '15551234567', active: false },
    { userId: 'test-user', number: '15551234567', verified: false },
  ]) {
    f.put(configFile, JSON.stringify({ ...current, TEAM_CHAT_CONTACTS_JSON: JSON.stringify([contact]) }));
    const policy = readOutboxConfig(configFile, f.fs);
    assert.deepEqual(policy, { enabled: true, contacts: [{ userId: contact.userId, number: contact.number,
      ...(contact.active === false ? { active: false } : {}), ...(contact.verified === false ? { verified: false } : {}) }] });
    assert.doesNotMatch(JSON.stringify(policy), /SYNTHETIC_PRIVATE_NAME|synthetic-secret|GROQ|SHARED_KEY/);
  }
  for (const change of [{ TEAM_CHAT_ENABLED: '0' }, { SECRETARY_ENABLED: '0' }]) {
    f.put(configFile, JSON.stringify({ ...current, ...change }));
    assert.deepEqual(readOutboxConfig(configFile, f.fs), { enabled: false, contacts: [] });
  }
});

test('outbox policy fails closed for missing, unsafe or malformed live settings and ambiguous mapping', () => {
  const f = fixture({ SECRETARY_ENABLED: '1' });
  for (const filename of [undefined, '', 'relative.json', path.join(os.tmpdir(), 'missing-private-settings.json')]) {
    assert.deepEqual(readOutboxConfig(filename, f.fs), { enabled: false, contacts: [] });
  }
  for (const contacts of [null, {}, [{ userId: 'u', number: '15551234567', active: 'false' }],
    [{ userId: 'u', number: '15551234567' }, { userId: 'v', number: '15551234567' }],
    [{ userId: 'u', number: '15551234567' }, { userId: 'u', number: '15551230000' }]]) {
    f.put(configFile, JSON.stringify({ ...settings, SECRETARY_ENABLED: '1', TEAM_CHAT_CONTACTS_JSON: JSON.stringify(contacts) }));
    assert.deepEqual(readOutboxConfig(configFile, f.fs), { enabled: false, contacts: [] });
  }
  for (const extra of [{ mode: 0o100644 }, { symlink: true }, { content: Buffer.from('SYNTHETIC_SECRET_INVALID_JSON') }]) {
    f.put(configFile, JSON.stringify({ ...settings, SECRETARY_ENABLED: '1' }), extra);
    assert.deepEqual(readOutboxConfig(configFile, f.fs), { enabled: false, contacts: [] });
  }
});

test('only launcher-validated settings path is explicitly granted to outbox, never an inherited path override', async () => {
  const database = path.join(os.tmpdir(), 'otp-test.sqlite');
  const f = fixture({ SECRETARY_ENABLED: '1', WHATSAPP_LOGIN_DATABASE: database });
  const untrusted = { ...env, TEAM_CHAT_AUTH_CONFIG_PATH: path.join(os.tmpdir(), 'untrusted-other-file') };
  const built = bridgeChildEnvironment({ ...settings, SECRETARY_ENABLED: '1', WHATSAPP_LOGIN_DATABASE: database }, untrusted, false, serviceDirectory);
  assert.equal(built.TEAM_CHAT_AUTH_CONFIG_PATH, undefined);
  const pending = launchPrivate({ ...f.dependencies, env: untrusted, args: [] });
  assert.equal(f.spawns.length, 1);
  const childEnv = f.spawns[0][2].env;
  assert.equal(childEnv.TEAM_CHAT_AUTH_CONFIG_PATH, configFile);
  assert.equal(childEnv.TITANIUM_TEAM_CHAT_CONFIG, undefined);
  assert.equal(childEnv.GROQ_API_KEY, undefined);
  assert.equal(childEnv.NODE_OPTIONS, undefined);
  assert.doesNotMatch(JSON.stringify(childEnv), /synthetic-secret|untrusted-other-file/);
  f.child.emit('close', 0, null);
  assert.equal(await pending, 0);
  const unsafe = fixture({ SECRETARY_ENABLED: '1', WHATSAPP_LOGIN_DATABASE: database });
  unsafe.entries.get(configFile).symlink = true;
  assert.equal(await launchPrivate({ ...unsafe.dependencies, args: [] }), 78);
  assert.equal(unsafe.spawns.length, 0);
});

test('the now-vestigial WHATSAPP_LOGIN_ENABLED/SECRET settings are never forwarded to the bridge child', () => {
  const child = bridgeChildEnvironment({ ...settings, WHATSAPP_LOGIN_ENABLED: 'pilot',
    WHATSAPP_LOGIN_SECRET: 'cd'.repeat(32), WHATSAPP_LOGIN_DATABASE: path.join(os.tmpdir(), 'otp-test.sqlite') }, env, false, serviceDirectory);
  assert.equal(child.WHATSAPP_LOGIN_ENABLED, undefined);
  assert.equal(child.WHATSAPP_LOGIN_SECRET, undefined);
  assert.equal(child.GROQ_API_KEY, undefined);
  assert.equal(child.TITANIUM_TEAM_CHAT_CONFIG, undefined);
});
test('task automation can be disabled independently of TEAM_CHAT_BRIDGE_ENABLED pairing', () => {
  const child = bridgeChildEnvironment({ ...settings, TEAM_CHAT_ENABLED: '0' }, env, true, serviceDirectory);
  assert.equal(child.TEAM_CHAT_BRIDGE_ENABLED, '1');
  assert.equal(child.TEAM_CHAT_TASKS_ENABLED, '0');
});

test('secretary settings pass no Groq key and disabled/unverified contacts never enter sender allowlist', () => {
  const child = bridgeChildEnvironment({ ...settings, SECRETARY_ENABLED: '1', SECRETARY_WEB_ENABLED: '1', SECRETARY_VOICE_ENABLED: '0',
    WHATSAPP_LOGIN_DATABASE: path.join(os.tmpdir(), 'otp-test.sqlite'), TEAM_CHAT_CONTACTS_JSON: JSON.stringify([
      { userId: 'member', number: '15551234567', name: 'PRIVATE_NAME' },
      { userId: 'disabled', number: '15551230000', active: false },
      { userId: 'unverified', number: '15551239999', verified: false },
    ]) }, env, false, serviceDirectory);
  assert.equal(child.SECRETARY_ENABLED, '1');
  assert.equal(child.SECRETARY_WEB_ENABLED, undefined);
  assert.equal(child.GROQ_API_KEY, undefined);
  assert.equal(child.TEAM_CHAT_ALLOWED_NUMBERS, '15551234567');
  assert.equal(child.TEAM_CHAT_AUTH_DATABASE, path.join(os.tmpdir(), 'otp-test.sqlite'));
  assert.doesNotMatch(child.TEAM_CHAT_AUTH_CONTACTS_JSON, /PRIVATE_NAME/);
});

test('disabled website settings exit zero without creating state or a child', async () => {
  const f = fixture({ TEAM_CHAT_ENABLED: '0' });
  assert.equal(await launchPrivate({ ...f.dependencies, args: [] }), 0);
  assert.equal(f.spawns.length, 0);
  assert.equal(f.entries.has(stateDirectory), false);
});

test('--pair works while website is disabled but does not edit its config', async () => {
  const f = fixture({ TEAM_CHAT_ENABLED: '0' });
  const original = Buffer.from(f.entries.get(configFile).content);
  const pending = launchPrivate({ ...f.dependencies, args: ['--pair'] });
  assert.equal(f.spawns.length, 1);
  const [executable, args, options] = f.spawns[0];
  assert.equal(executable, '/trusted/node22');
  assert.deepEqual(args, [path.join(serviceDirectory, 'src', 'main.mjs')]);
  assert.equal(options.shell, false);
  assert.equal(options.windowsHide, true);
  assert.equal(options.env.TEAM_CHAT_PAIR, '1');
  assert.equal(options.env.TEAM_CHAT_BRIDGE_ENABLED, '1');
  f.child.emit('close', 0, null);
  assert.equal(await pending, 0);
  assert.deepEqual(f.entries.get(configFile).content, original);
  assert.equal(f.entries.has(marker), false);
});

test('exit78 writes a private attention marker and subsequent normal launches do not spawn', async () => {
  const f = fixture();
  const pending = launchPrivate({ ...f.dependencies, args: [] });
  f.child.emit('close', 78, null);
  assert.equal(await pending, 78);
  assert.equal(f.entries.get(marker).mode & 0o777, 0o600);
  assert.equal(JSON.parse(f.entries.get(marker).content).reason, 'child_exit_78');
  assert.equal(await launchPrivate({ ...f.dependencies, args: [] }), 78);
  assert.equal(f.spawns.length, 1);
  assert.ok(f.reports.every(message => !message.includes(secret) && !message.includes(settings.GROQ_API_KEY)));
});

test('explicit recovery keeps marker until success, removing only that marker after exit0', async () => {
  const f = fixture();
  f.put(marker, '{"reason":"previous_attention"}\n');
  const session = path.join(stateDirectory, 'bridge.sqlite');
  f.put(session, 'synthetic-existing-session');
  const pending = launchPrivate({ ...f.dependencies, args: ['--pair'] });
  assert.equal(f.entries.has(marker), true);
  f.child.emit('close', 0, null);
  assert.equal(await pending, 0);
  assert.equal(f.entries.has(marker), false);
  assert.equal(f.entries.get(session).content.toString(), 'synthetic-existing-session');
});

test('SIGTERM and SIGINT are forwarded and launcher waits for child shutdown without marker', async () => {
  for (const signal of ['SIGTERM', 'SIGINT']) {
    const f = fixture();
    let settled = false;
    const pending = launchPrivate({ ...f.dependencies, args: [] }).then(code => { settled = true; return code; });
    f.signals.emit(signal);
    await Promise.resolve();
    assert.deepEqual(f.child.kills, [signal]);
    assert.equal(settled, false);
    f.child.emit('close', null, signal);
    assert.equal(await pending, 0);
    assert.equal(f.entries.has(marker), false);
    assert.equal(f.signals.listenerCount(signal), 0);
  }
});

test('unsafe marker and invalid settings fail closed without spawning or printing values', async () => {
  const f = fixture();
  f.put(marker, 'private', { symlink: true });
  assert.equal(await launchPrivate({ ...f.dependencies, args: ['--pair'] }), 78);
  assert.equal(f.spawns.length, 0);
  const g = fixture({ TEAM_CHAT_CONTACTS_JSON: 'secret-invalid-json-content' });
  assert.equal(await launchPrivate({ ...g.dependencies, args: [] }), 78);
  assert.equal(g.spawns.length, 0);
  assert.ok(g.reports.every(message => !message.includes('secret-invalid')));
});


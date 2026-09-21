// Basim, 2026-09-21: "بدي اربط البوت على موقع العياده يصير يرسل تقرير مبيعات
// للجروب... بدون ما نلخبط القصص ببعض" -- and "بدي يجي كمان مين اللي باع اي
// عياده الطب العام ولا انسائيه".
//
// The clinics' system is a Laravel + Inertia app: every page ships the exact
// data its screen renders as a JSON island. These tests hold that contract --
// a login that is really performed, numbers read as JSON and never scraped
// out of rendered text, and a report that stays separate from the pharmacy's.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { openClinicSession, ClinicError } from '../lib/clinic-client.ts';
import { createClinicReportJobs, clinicReportText } from '../lib/clinic-reports.ts';

const clinic = { url: 'https://clinic.example.com', email: 'owner@example.com', password: 'secret' };

const DATA = {
  range: { from: '2026-09-21', until: '2026-09-21' },
  summary: { collected: '767.000', refunded: '8.000', net: '759.000', outstanding: '12.500', invoiced: '771.500', collection_rate: 98 },
  byCashier: [{ cashier: 'طبيب عام', total: '653.000', count: 41 }, { cashier: 'طبيب نسائية', total: '95.000', count: 9 }],
  byService: [{ service: 'كشفيه', total: '85.000' }],
  byMethod: [{ method: 'نقداً', total: '750.000' }],
  currency: 'JOD',
};
const page = (data, marker = '"collected"') =>
  `<!doctype html><html><body><div id="app" data-page="app"></div>` +
  `<script type="application/json">${JSON.stringify({ component: 'Reports/Finance', props: { section: 'finance', data } })}</script>` +
  `</body></html>`.replace('COLLECTED', marker);

/** A stand-in for the clinics' site: a login that must really be completed. */
function site({ data = DATA, financeStatus = 200, loginStatus = 302, token = 'csrf-token' } = {}) {
  const seen = [];
  const fetcher = async (url, options = {}) => {
    const path = url.replace(clinic.url, '');
    seen.push({ path, method: options.method || 'GET', cookie: (options.headers || {}).cookie || '' });
    const headers = new Headers();
    if (path === '/login' && (options.method || 'GET') === 'GET') {
      headers.append('set-cookie', 'XSRF-TOKEN=abc; Path=/');
      headers.append('set-cookie', 'clinic_session=s1; Path=/; HttpOnly');
      return new Response(`<form method="post"><input type="hidden" name="_token" value="${token}"></form>`, { status: 200, headers });
    }
    if (path === '/login') {
      const body = new URLSearchParams(options.body);
      if (body.get('_token') !== token || body.get('email') !== clinic.email || body.get('password') !== clinic.password) {
        return new Response('<form></form>', { status: 200 });
      }
      headers.append('set-cookie', 'clinic_session=authed; Path=/; HttpOnly');
      headers.set('location', '/dashboard');
      return new Response('', { status: loginStatus, headers });
    }
    if (path.startsWith('/reports/finance')) {
      if (financeStatus !== 200) return new Response('', { status: financeStatus });
      return new Response(page(data), { status: 200 });
    }
    return new Response('', { status: 404 });
  };
  return { fetcher, seen };
}

test('the numbers are the system\'s own, read as JSON rather than off the screen', async () => {
  const { fetcher, seen } = site();
  const session = await openClinicSession(clinic, fetcher);
  const report = await session.finance('2026-09-21', '2026-09-21');
  assert.equal(report.net, 759);
  assert.equal(report.outstanding, 12.5);
  assert.equal(report.collectionRate, 98);
  assert.deepEqual(report.byCashier, [{ name: 'طبيب عام', total: 653, count: 41 }, { name: 'طبيب نسائية', total: 95, count: 9 }]);
  // The session is carried: the report request must arrive authenticated.
  const finance = seen.find(call => call.path.startsWith('/reports/finance'));
  assert.match(finance.cookie, /clinic_session=authed/);
  // And it is a READ. Nothing but the login may ever be a POST.
  assert.deepEqual(seen.filter(call => call.method === 'POST').map(call => call.path), ['/login']);
});

test('a wrong password is a failure, never an empty day', async () => {
  const { fetcher } = site();
  // The site answers a bad login by rendering the form again (200, no redirect).
  await assert.rejects(() => openClinicSession({ ...clinic, password: 'wrong' }, fetcher),
    error => error instanceof ClinicError && error.message === 'clinic_login_rejected');
});

test('a page we did not really reach is a failure, never a day with no money in it', async () => {
  const { fetcher } = site();
  const session = await openClinicSession(clinic, fetcher);
  // A login wall or an error page ships no data island of its own.
  const walled = await openClinicSession(clinic, async (url, options) => {
    const path = url.replace(clinic.url, '');
    if (path.startsWith('/reports/finance')) return new Response('<html><body>تسجيل الدخول</body></html>', { status: 200 });
    return fetcher(url, options);
  });
  await assert.rejects(() => walled.finance('2026-09-21', '2026-09-21'),
    error => error instanceof ClinicError && error.message === 'clinic_report_unreadable');
  assert.ok(await session.finance('2026-09-21', '2026-09-21'), 'the working session is unaffected');
});

test('the report names who took the money, and stays quiet about a zero balance', () => {
  const text = clinicReportText({ ...DATA.range, currency: 'JOD', collected: 767, refunded: 8, net: 759,
    outstanding: 0, invoiced: 771.5, collectionRate: 98,
    byCashier: [{ name: 'طبيب عام', total: 653, count: 41 }, { name: 'طبيب نسائية', total: 95, count: 9 }],
    byService: [{ name: 'كشفيه', total: 85 }], byMethod: [] }, '2026-09-21', 'دينار');
  assert.match(text, /تقرير العيادات اليومي/);
  assert.match(text, /طبيب عام\n653\.000 دينار — 41 فاتورة/);
  assert.match(text, /طبيب نسائية\n95\.000 دينار — 9 فاتورة/);
  assert.doesNotMatch(text, /المستحقات/, 'nothing owed is not a line worth printing every day');
  assert.match(text, /مسترجع/, 'but a refund that really happened is');
});

function fixture(t) {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  db.exec('CREATE TABLE tasks (id TEXT PRIMARY KEY);');
  return db;
}
const AT = Date.UTC(2026, 8, 22, 0, 5, 0); // 00:05 local at offset 0 -- the report slot

test('it goes out once a day, to the group, for the day that just ended', async t => {
  const db = fixture(t);
  const { fetcher, seen } = site();
  const jobs = createClinicReportJobs({ db, now: () => AT, config: {
    enabled: true, clinic, groupId: '1@g.us', timezoneOffsetMinutes: 0, currencyLabel: 'دينار', fetcher } });
  const sent = [];
  assert.equal((await jobs.deliverNext(async m => { sent.push(m); return {}; })).status, 'sent');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, '1@g.us');
  assert.match(sent[0].text, /2026-09-21/, 'the day that ended, not the one just starting');
  const finance = seen.find(call => call.path.startsWith('/reports/finance'));
  assert.match(finance.path, /from=2026-09-21&to=2026-09-21/);
  assert.deepEqual(await jobs.deliverNext(async () => assert.fail('never twice in one day')), { status: 'idle' });
});

test('outside its hour it does not touch the clinics\' system at all', async t => {
  const db = fixture(t);
  const jobs = createClinicReportJobs({ db, now: () => AT + 3 * 60 * 60_000, config: {
    enabled: true, clinic, groupId: '1@g.us', timezoneOffsetMinutes: 0,
    fetcher: async () => assert.fail('must not reach the clinics outside the slot') } });
  assert.deepEqual(await jobs.deliverNext(async () => assert.fail('nothing to send')), { status: 'idle' });
});

test('with no credentials configured it is simply off', async t => {
  const db = fixture(t);
  const jobs = createClinicReportJobs({ db, now: () => AT, config: {
    enabled: false, clinic: { url: '', email: '', password: '' }, groupId: '1@g.us', timezoneOffsetMinutes: 0,
    fetcher: async () => assert.fail('must not fetch when disabled') } });
  assert.deepEqual(await jobs.deliverNext(async () => assert.fail('nothing to send')), { status: 'idle' });
});

test('a clinics outage says so in one line and never blocks the slot forever', async t => {
  const db = fixture(t);
  const jobs = createClinicReportJobs({ db, now: () => AT, config: {
    enabled: true, clinic, groupId: '1@g.us', timezoneOffsetMinutes: 0,
    fetcher: async () => { throw new Error('down'); } } });
  let text = '';
  assert.equal((await jobs.deliverNext(async m => { text = m.text; return {}; })).status, 'sent');
  assert.match(text, /تعذر جلب تقرير العيادات/);
});

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
function site({ data = DATA, financeStatus = 200, loginStatus = 302, token = 'csrf-token', blade = false } = {}) {
  const seen = [];
  // Laravel hands out the SAME token in two different wrappings: plain in a
  // Blade form's _token input, encrypted in the XSRF-TOKEN cookie. Modelling
  // them as one string hid a real bug, so here they are deliberately unequal.
  const encrypted = `enc(${token})`;
  const fetcher = async (url, options = {}) => {
    const path = url.replace(clinic.url, '');
    seen.push({ path, method: options.method || 'GET', cookie: (options.headers || {}).cookie || '',
      body: options.body ?? '', headers: { ...(options.headers || {}) } });
    const headers = new Headers();
    if (path === '/login' && (options.method || 'GET') === 'GET') {
      headers.append('set-cookie', `XSRF-TOKEN=${encodeURIComponent(encrypted)}; Path=/`);
      headers.append('set-cookie', 'clinic_session=s1; Path=/; HttpOnly');
      // The real site is a Vue front end: its sign-in page ships no HTML form
      // and no _token input, only the XSRF cookie above. `blade` puts the old
      // Blade-style form back, so both shapes stay covered.
      return new Response(blade ? `<form method="post"><input type="hidden" name="_token" value="${token}"></form>` : '<div id="app"></div>',
        { status: 200, headers });
    }
    if (path === '/login') {
      const body = new URLSearchParams(options.body);
      // Laravel's own order: _token from the body wins outright, and only when
      // it is absent is the header decrypted. A body carrying the cookie's
      // encrypted copy therefore fails -- which is what the live site did.
      const sent = body.has('_token')
        ? body.get('_token')
        : ((options.headers || {})['x-xsrf-token'] || '').replace(/^enc\((.*)\)$/, '$1');
      if (sent !== token) return new Response(JSON.stringify({ message: 'Page expired. Please retry.' }), { status: 419 });
      if (body.get('email') !== clinic.email || body.get('password') !== clinic.password) {
        return new Response(JSON.stringify({ errors: {} }), { status: 422 });
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
  await assert.rejects(() => openClinicSession({ ...clinic, password: 'wrong' }, fetcher),
    error => error instanceof ClinicError && error.message === 'clinic_login_rejected');
});

// 2026-09-21: the first version looked for a hidden _token input and gave up
// when it found none -- the site's sign-in page is a Vue app and ships no HTML
// form at all. The token is in the XSRF cookie; both shapes work now.
test('a sign-in page with no HTML form still signs in, from the XSRF cookie', async () => {
  for (const blade of [false, true]) {
    const { fetcher, seen } = site({ blade });
    const session = await openClinicSession(clinic, fetcher);
    assert.equal((await session.finance('2026-09-21', '2026-09-21')).net, 759, `blade=${blade}`);
    const post = seen.find(call => call.method === 'POST');
    assert.ok(post, 'the login is really performed either way');
  }
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

// Basim, 2026-09-21: "شو بيع العيادات مثلا؟" -- the clinics answer live too,
// but only when the question names them. An unqualified sales question has
// meant the pharmacy since the day the bot existed and must keep meaning it.
test('a question is a clinics question only when it names a clinic', async () => {
  const { matchClinicQuestion } = await import('../lib/clinic-questions.ts');
  assert.equal(matchClinicQuestion('شو بيع العيادات')?.kind, 'finance_today');
  assert.equal(matchClinicQuestion('شو بيع العيادات اليوم')?.kind, 'finance_today');
  assert.equal(matchClinicQuestion('تحصيل العيادة امبارح')?.kind, 'finance_yesterday');
  assert.equal(matchClinicQuestion('مبيعات العيادات هالشهر')?.kind, 'finance_month');
  assert.equal(matchClinicQuestion('كم بعنا بالعيادة هالاسبوع')?.kind, 'finance_week');
  // The pharmacy keeps every wording it had.
  for (const pharmacy of ['شو مبيعات اليوم', 'مبيعات الناعور اليوم', 'شو ناقص من المخزون', 'كم علينا للموردين']) {
    assert.equal(matchClinicQuestion(pharmacy), null, pharmacy);
  }
  // Naming a clinic is not enough on its own -- it has to be about money.
  assert.equal(matchClinicQuestion('في مريض بالعيادة'), null);
});

test('the clinics answer names the doctors, and reads its own system for the day asked for', async () => {
  const { answerClinicQuestion, matchClinicQuestion } = await import('../lib/clinic-questions.ts');
  const { fetcher, seen } = site();
  const at = Date.UTC(2026, 8, 22, 9, 0, 0); // 09:00 local at offset 0
  const reply = await answerClinicQuestion(matchClinicQuestion('شو بيع العيادات امبارح'),
    { clinic, currencyLabel: 'دينار', timezoneOffsetMinutes: 0, fetcher }, at);
  assert.match(reply, /مبيعات العيادات امبارح/);
  assert.match(reply, /طبيب عام\n653\.000 دينار — 41 فاتورة/);
  assert.match(reply, /المستحقات: \*12\.500 دينار\*/);
  const finance = seen.find(call => call.path.startsWith('/reports/finance'));
  assert.match(finance.path, /from=2026-09-21&to=2026-09-21/, 'yesterday, whole');
});

// 2026-09-21, the second round: the login still answered 419 "Page expired".
// The cookie's copy of the token is encrypted and the form's is plain, and
// Laravel reads `_token` from the body before it ever looks at the header --
// so sending the cookie's value as `_token` had it compared raw against the
// session's plain token and rejected. Each copy now goes only where it is
// understood.
test('the cookie\'s token is sent as a header and never as the form field', async () => {
  const { fetcher, seen } = site();
  const session = await openClinicSession(clinic, fetcher);
  assert.equal((await session.finance('2026-09-21', '2026-09-21')).net, 759);
  const post = seen.find(call => call.method === 'POST' && call.path === '/login');
  assert.equal(new URLSearchParams(post.body).has('_token'), false,
    'the encrypted cookie copy must not be put in _token');
  assert.match(post.headers['x-xsrf-token'], /^enc\(/,
    'the cookie copy travels in the header, where it gets decrypted');
});

/**
 * Minimal, read-only client for the clinics' own system (Clinic Tek, at
 * titanim.clinic.barmajtek.com). Used only to READ the daily finance report
 * for the WhatsApp summary -- there is no POST anywhere in this file except
 * the login itself, on purpose: a report must never be able to change
 * anything in the clinics' real system, least of all patient records.
 *
 * The site is a Laravel + Inertia app. Every page ships the exact data its
 * screen renders as a JSON island (<script type="application/json">), so the
 * numbers here are the system's own, parsed as JSON -- never scraped out of
 * rendered HTML, and never re-derived.
 *
 * Deliberately separate from odoo-client.ts and sharing nothing with it:
 * Basim, 2026-09-21, "بدون ما نلخبط القصص ببعض". If the clinics are down or
 * their login changes, the pharmacy's reports carry on untouched.
 */

export type ClinicConfig = { url: string; email: string; password: string };
type Fetcher = typeof fetch;

export class ClinicError extends Error {
  constructor(message: string) { super(message); this.name = "ClinicError"; }
}

export type ClinicShare = { name: string; total: number; count?: number };
/** One day (or range) of money, as the clinics' own finance report states it. */
export type ClinicFinance = {
  from: string; until: string; currency: string;
  collected: number; refunded: number; net: number; outstanding: number; invoiced: number; collectionRate: number;
  /** Who took the money -- the doctor or desk each payment was rung up on. */
  byCashier: ClinicShare[];
  byService: ClinicShare[];
  byMethod: ClinicShare[];
};

function assertConfig(config: ClinicConfig): void {
  if (!/^https:\/\/[\w.-]+(?::\d+)?$/.test(config.url) || !config.email.trim() || !config.password.trim()) {
    throw new ClinicError("clinic_config_invalid");
  }
}

/** A cookie jar, because a Laravel session is cookies and node's fetch keeps none. */
function jar() {
  const store = new Map<string, string>();
  return {
    absorb(response: Response) {
      for (const raw of response.headers.getSetCookie?.() ?? []) {
        const [pair] = raw.split(";");
        const index = pair.indexOf("=");
        if (index > 0) store.set(pair.slice(0, index).trim(), pair.slice(index + 1).trim());
      }
    },
    header() { return [...store].map(([name, value]) => `${name}=${value}`).join("; "); },
    get(name: string) { return store.get(name); },
  };
}

const NUMBER = (value: unknown): number => {
  const parsed = Number(String(value ?? "").replace(/[^\d.-]/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
};
const TEXT = (value: unknown, max = 60): string => String(value ?? "").replace(/[\u0000-\u001F\u007F]/g, " ").trim().slice(0, max);

/**
 * The page's own data, lifted out of its JSON island. `marker` picks the right
 * island on a page that ships more than one; a page that ships none at all is
 * a page we did not actually reach (a login wall, an error), which must read
 * as a failure rather than as a day with no money in it.
 */
function island(html: string, marker: string): Record<string, unknown> {
  const blocks = [...html.matchAll(/<script[^>]+type="application\/json"[^>]*>([\s\S]*?)<\/script>/gi)];
  for (const [, body] of blocks) {
    if (!body.includes(marker)) continue;
    try {
      const parsed = JSON.parse(body.replace(/<\/script/gi, "<\\/script")) as { props?: { data?: unknown } };
      const data = parsed?.props?.data;
      if (data && typeof data === "object") return data as Record<string, unknown>;
    } catch { /* try the next island rather than failing on an unrelated one */ }
  }
  throw new ClinicError("clinic_report_unreadable");
}

const shares = (rows: unknown, nameKey: string): ClinicShare[] =>
  (Array.isArray(rows) ? rows : []).map(row => {
    const record = (row ?? {}) as Record<string, unknown>;
    return { name: TEXT(record[nameKey] ?? record.name ?? record.label), total: NUMBER(record.total ?? record.amount),
      ...(record.count === undefined ? {} : { count: NUMBER(record.count) }) };
  }).filter(share => share.name);

export type ClinicSession = {
  /** The finance report for a date range, inclusive, as YYYY-MM-DD. */
  finance(from: string, until: string): Promise<ClinicFinance>;
};

/** Signs in once, then reuses that session for every read below. */
export async function openClinicSession(config: ClinicConfig, fetcher: Fetcher = fetch): Promise<ClinicSession> {
  assertConfig(config);
  const cookies = jar();
  const get = async (path: string): Promise<Response> => {
    let response: Response;
    try {
      response = await fetcher(`${config.url}${path}`, {
        headers: { cookie: cookies.header(), "accept-language": "ar" },
        redirect: "manual", signal: AbortSignal.timeout(25_000),
      });
    } catch { throw new ClinicError("clinic_unreachable"); }
    cookies.absorb(response);
    return response;
  };

  const page = await get("/login");
  if (!page.ok) throw new ClinicError("clinic_login_unreachable");
  const html = await page.text();
  // Laravel's CSRF token travels twice: in the form and in the XSRF cookie.
  // The form's copy is the one the POST must echo back.
  const token = html.match(/name="_token"\s+value="([^"]+)"/)?.[1] ?? html.match(/value="([^"]+)"\s+name="_token"/)?.[1];
  if (!token) throw new ClinicError("clinic_login_form_changed");

  let signIn: Response;
  try {
    signIn = await fetcher(`${config.url}/login`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie: cookies.header(), "accept-language": "ar" },
      body: new URLSearchParams({ _token: token, email: config.email, password: config.password }).toString(),
      redirect: "manual", signal: AbortSignal.timeout(25_000),
    });
  } catch { throw new ClinicError("clinic_unreachable"); }
  cookies.absorb(signIn);
  // A successful Laravel login redirects; a failed one renders the form again.
  if (signIn.status < 300 || signIn.status >= 400) throw new ClinicError("clinic_login_rejected");

  return {
    async finance(from: string, until: string) {
      for (const value of [from, until]) if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new ClinicError("clinic_date_invalid");
      const response = await get(`/reports/finance?from=${from}&to=${until}`);
      if (!response.ok) throw new ClinicError("clinic_report_unreachable");
      const data = island(await response.text(), '"collected"');
      const summary = (data.summary ?? {}) as Record<string, unknown>;
      return {
        from, until, currency: TEXT(data.currency, 12) || "JOD",
        collected: NUMBER(summary.collected), refunded: NUMBER(summary.refunded), net: NUMBER(summary.net),
        outstanding: NUMBER(summary.outstanding), invoiced: NUMBER(summary.invoiced),
        collectionRate: NUMBER(summary.collection_rate),
        byCashier: shares(data.byCashier, "cashier"),
        byService: shares(data.byService, "service"),
        byMethod: shares(data.byMethod, "method"),
      };
    },
  };
}

/**
 * The secretary's backend: one signed request in (a WhatsApp message or poll
 * tap, as the bridge's queue stores it), one bounded reply out.
 *
 * Until 2026-10-09 this lived in app/api/whatsapp/team-chat/route.ts and the
 * bridge reached it over HTTPS -- which made the Next app, and the GitHub
 * build that produces it, part of answering every message. Basim wants the
 * site gone ("الغي الموقع تماما"), so the bridge now calls this directly
 * (see localTeamChatFetcher below) and the route is a thin wrapper kept only
 * until the site is removed. Same signature check, same settings file, same
 * database: nothing about the message's path changed except the network hop.
 */
import { handleTeamChatRequest, teamChatConfigFromEnv, type TeamChatConfig, type TeamChatEnvelope } from "./team-chat-gateway.ts";
import { chatDatabase, ensureSeedUsers } from "./titanium-server.ts";
import { readTeamChatSettings } from "./team-chat-settings.ts";
import { handleSecretaryEvent } from "./secretary-service.ts";
import { inferSecretaryIntent, searchSecretaryWeb } from "./secretary-intent.ts";
import { answerOdooQuestion, type OdooQuestionMatch } from "./odoo-questions.ts";
import { answerClinicQuestion, type ClinicQuestionMatch } from "./clinic-questions.ts";
import { classifyOdooQuestion } from "./odoo-question-model.ts";
import { exploreOdoo } from "./odoo-explore.ts";
import { odooPersonFor } from "./odoo-people.ts";
import { openOdooSession } from "./odoo-client.ts";

export async function handleTeamChatPost(request: Request): Promise<Response> {
  try {
    const settings = readTeamChatSettings();
    return handleTeamChatRequest(request, {
      config: teamChatConfigFromEnv(settings), getDatabase: chatDatabase,
      ...(settings.SECRETARY_ENABLED === "1" ? { secretary: (database: ReturnType<typeof chatDatabase>, event: TeamChatEnvelope, config: TeamChatConfig) => handleSecretaryEvent(database, event, config, {
        infer: input => inferSecretaryIntent(input, { apiKey: settings.OPENAI_API_KEY, model: settings.OPENAI_MODEL }),
        ...(settings.SECRETARY_WEB_ENABLED === "1" ? { search: (query: string) => searchSecretaryWeb(query, { apiKey: settings.OPENAI_API_KEY, model: settings.OPENAI_SEARCH_MODEL }) } : {}),
        // Live questions about the pharmacy's own system. Every one of the four
        // connection settings must be present -- a half-filled config can never
        // half-answer a question about real money or stock -- but once they are,
        // answering is the point of having configured Odoo at all, so this needs
        // no second switch. ODOO_QUESTIONS_ENABLED="0" turns it back off.
        ...(settings.ODOO_QUESTIONS_ENABLED !== "0" && settings.ODOO_URL && settings.ODOO_DB && settings.ODOO_USERNAME && settings.ODOO_API_KEY
          ? { askOdoo: (match: OdooQuestionMatch, at: number) => answerOdooQuestion(match, {
              odoo: { url: settings.ODOO_URL!, db: settings.ODOO_DB!, username: settings.ODOO_USERNAME!, apiKey: settings.ODOO_API_KEY! },
              ...(settings.ODOO_CURRENCY_LABEL ? { currencyLabel: settings.ODOO_CURRENCY_LABEL } : {}),
              ...(/^\d{1,3}$/.test(settings.ODOO_EXPIRY_WINDOW_DAYS || "") ? { expiryWindowDays: Number(settings.ODOO_EXPIRY_WINDOW_DAYS) } : {}),
            }, at) }
          : {}),
        // The clinics: a different business on a different system, asked about
        // by name. All three settings must be present -- a half-filled config
        // can never half-answer a question about real money.
        ...(settings.CLINIC_QUESTIONS_ENABLED !== "0" && settings.CLINIC_URL && settings.CLINIC_EMAIL && settings.CLINIC_PASSWORD
          ? { askClinic: (match: ClinicQuestionMatch, at: number) => answerClinicQuestion(match, {
              clinic: { url: settings.CLINIC_URL!, email: settings.CLINIC_EMAIL!, password: settings.CLINIC_PASSWORD! },
              ...(settings.CLINIC_CURRENCY_LABEL || settings.ODOO_CURRENCY_LABEL ? { currencyLabel: (settings.CLINIC_CURRENCY_LABEL || settings.ODOO_CURRENCY_LABEL)! } : {}),
            }, at) }
          : {}),
        // Wording only. The router says WHICH report was asked for; the figures
        // in the reply still come from the query above, never from the model.
        ...(settings.ODOO_QUESTIONS_ENABLED !== "0" && settings.OPENAI_API_KEY && settings.ODOO_URL && settings.ODOO_DB && settings.ODOO_USERNAME && settings.ODOO_API_KEY
          ? { classifyOdoo: (text: string) => classifyOdooQuestion(text, { apiKey: settings.OPENAI_API_KEY, model: settings.OPENAI_ROUTER_MODEL }) }
          : {}),
        // The open question over the whole database, run as the ASKING PERSON.
        // Someone with no Odoo key of their own gets null here, never the
        // owner's session -- a fallback would hand them the owner's
        // permissions while looking like it worked.
        ...(settings.ODOO_QUESTIONS_ENABLED !== "0" && settings.OPENAI_API_KEY && settings.ODOO_URL && settings.ODOO_DB && settings.ODOO_USERNAME && settings.ODOO_API_KEY
          ? { exploreOdoo: async (userId: string, text: string, at: number) => {
              const person = odooPersonFor(userId, { url: settings.ODOO_URL!, db: settings.ODOO_DB! }, settings.ODOO_USER_KEYS_JSON,
                // The owner's credentials are already here -- they are what the
                // scheduled reports run under -- so he needs no second copy of
                // them under his own name. Bound to his id alone.
                { userId: "basem", username: settings.ODOO_USERNAME, apiKey: settings.ODOO_API_KEY });
              if (!person) return null;
              const session = await openOdooSession(person.config);
              return exploreOdoo(text, { session, cacheKey: person.cacheKey, apiKey: settings.OPENAI_API_KEY,
                ...(settings.OPENAI_MODEL ? { model: settings.OPENAI_MODEL } : {}),
                ...(settings.ODOO_CURRENCY_LABEL ? { currencyLabel: settings.ODOO_CURRENCY_LABEL } : {}), now: at });
            } }
          : {}),
      }) } : {}),
    });
  } catch {
    return Response.json({ error: "Team chat settings unavailable." }, { status: 503, headers: { "cache-control": "private, no-store" } });
  }
}

/**
 * A drop-in for the bridge's `fetch`: the same signed POST the bridge always
 * built, answered in this process instead of by the website. The URL is kept
 * as the request's URL and nothing else -- no socket is opened for it.
 *
 * The members the bridge may message are the dashboard's `users` rows, which
 * the website used to seed on its first login page view; with no website that
 * seeding happens here, once, before the first message is answered.
 */
export function localTeamChatFetcher(): (url: string, init: RequestInit) => Promise<Response> {
  const seeded = ensureSeedUsers().catch(() => undefined);
  return async (url, init) => {
    await seeded;
    return handleTeamChatPost(new Request(url, init));
  };
}

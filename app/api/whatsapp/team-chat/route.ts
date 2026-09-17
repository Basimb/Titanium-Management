import { handleTeamChatRequest, teamChatConfigFromEnv } from "@/lib/team-chat-gateway";
import { chatDatabase } from "@/lib/titanium-server";
import { readTeamChatSettings } from "@/lib/team-chat-settings";
import { handleSecretaryEvent } from "@/lib/secretary-service";
import { inferSecretaryIntent, searchSecretaryWeb } from "@/lib/secretary-intent";
import { answerOdooQuestion } from "@/lib/odoo-questions";
import { classifyOdooQuestion } from "@/lib/odoo-question-model";
import { exploreOdoo } from "@/lib/odoo-explore";
import { odooPersonFor } from "@/lib/odoo-people";
import { openOdooSession } from "@/lib/odoo-client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const settings = readTeamChatSettings();
    return handleTeamChatRequest(request, {
      config: teamChatConfigFromEnv(settings), getDatabase: chatDatabase,
      ...(settings.SECRETARY_ENABLED === "1" ? { secretary: (database: ReturnType<typeof chatDatabase>, event: import("@/lib/team-chat-gateway").TeamChatEnvelope, config: import("@/lib/team-chat-gateway").TeamChatConfig) => handleSecretaryEvent(database, event, config, {
        infer: input => inferSecretaryIntent(input, { apiKey: settings.OPENAI_API_KEY, model: settings.OPENAI_MODEL }),
        ...(settings.SECRETARY_WEB_ENABLED === "1" ? { search: (query: string) => searchSecretaryWeb(query, { apiKey: settings.OPENAI_API_KEY, model: settings.OPENAI_SEARCH_MODEL }) } : {}),
        // Live questions about the pharmacy's own system. Every one of the four
        // connection settings must be present -- a half-filled config can never
        // half-answer a question about real money or stock -- but once they are,
        // answering is the point of having configured Odoo at all, so this needs
        // no second switch. ODOO_QUESTIONS_ENABLED="0" turns it back off.
        ...(settings.ODOO_QUESTIONS_ENABLED !== "0" && settings.ODOO_URL && settings.ODOO_DB && settings.ODOO_USERNAME && settings.ODOO_API_KEY
          ? { askOdoo: (match: import("@/lib/odoo-questions").OdooQuestionMatch, at: number) => answerOdooQuestion(match, {
              odoo: { url: settings.ODOO_URL!, db: settings.ODOO_DB!, username: settings.ODOO_USERNAME!, apiKey: settings.ODOO_API_KEY! },
              ...(settings.ODOO_CURRENCY_LABEL ? { currencyLabel: settings.ODOO_CURRENCY_LABEL } : {}),
              ...(/^\d{1,3}$/.test(settings.ODOO_EXPIRY_WINDOW_DAYS || "") ? { expiryWindowDays: Number(settings.ODOO_EXPIRY_WINDOW_DAYS) } : {}),
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

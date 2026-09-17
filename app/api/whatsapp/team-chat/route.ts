import { handleTeamChatRequest, teamChatConfigFromEnv } from "@/lib/team-chat-gateway";
import { chatDatabase } from "@/lib/titanium-server";
import { readTeamChatSettings } from "@/lib/team-chat-settings";
import { handleSecretaryEvent } from "@/lib/secretary-service";
import { inferSecretaryIntent, searchSecretaryWeb } from "@/lib/secretary-intent";
import { answerOdooQuestion } from "@/lib/odoo-questions";

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
              ...(/^\d{1,4}$/.test(settings.ODOO_LOW_STOCK_THRESHOLD || "") ? { lowStockThreshold: Number(settings.ODOO_LOW_STOCK_THRESHOLD) } : {}),
              ...(/^\d{1,3}$/.test(settings.ODOO_EXPIRY_WINDOW_DAYS || "") ? { expiryWindowDays: Number(settings.ODOO_EXPIRY_WINDOW_DAYS) } : {}),
            }, at) }
          : {}),
      }) } : {}),
    });
  } catch {
    return Response.json({ error: "Team chat settings unavailable." }, { status: 503, headers: { "cache-control": "private, no-store" } });
  }
}

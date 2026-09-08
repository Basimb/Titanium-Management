import { handleTeamChatRequest, teamChatConfigFromEnv } from "@/lib/team-chat-gateway";
import { chatDatabase } from "@/lib/titanium-server";
import { readTeamChatSettings } from "@/lib/team-chat-settings";
import { handleSecretaryEvent } from "@/lib/secretary-service";
import { inferSecretaryIntent, searchSecretaryWeb } from "@/lib/secretary-intent";

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
      }) } : {}),
    });
  } catch {
    return Response.json({ error: "Team chat settings unavailable." }, { status: 503, headers: { "cache-control": "private, no-store" } });
  }
}

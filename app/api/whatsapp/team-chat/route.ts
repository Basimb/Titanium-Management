// Kept only until the site is removed: the bridge answers messages in its own
// process now (lib/team-chat-backend.ts, 2026-10-09). This route is the same
// backend reachable over HTTPS, for the days both still run.
import { handleTeamChatPost } from "@/lib/team-chat-backend";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  return handleTeamChatPost(request);
}

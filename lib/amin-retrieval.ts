import type { DatabaseSync } from 'node:sqlite';

export type AminReferenceQuery = { source: 'knowledge' | 'conversation' | 'corrections'; query: string };
const tokens = (s: string) => [...new Set(s.normalize('NFKC').toLowerCase()
  .replace(/[\u064b-\u065f\u0670ـ]/g, '').replace(/[أإآ]/g, 'ا').replace(/ى/g, 'ي')
  .match(/[\p{L}\p{N}]{2,}/gu) || [])].slice(0, 12);

/** Same authenticated private conversation only. Scope and membership epoch precede ranking. */
export function searchAminConversation(db: DatabaseSync, input: {
  actorId: string; conversation: string; query: string; scope: Set<string>; now: number; since: number;
}) {
  const words = tokens(input.query);
  if (!words.length) return [];
  const rows = db.prepare(`SELECT event_key,original_text,result_json,scope_json,created_at FROM secretary_events
    WHERE actor_id=? AND conversation_key=? AND created_at>=? AND created_at<=?
    ORDER BY created_at DESC,rowid DESC LIMIT 240`).all(input.actorId, input.conversation,
      Math.max(input.since, input.now - 30 * 86400000), input.now) as Array<{
        event_key: string; original_text: string; result_json: string; scope_json: string; created_at: number;
      }>;
  const visible = rows.flatMap(row => {
    try {
      const scope = JSON.parse(row.scope_json), result = JSON.parse(row.result_json);
      if (!Array.isArray(scope) || !scope.every(id => typeof id === 'string' && input.scope.has(id))) return [];
      const reply = typeof result.reply === 'string' ? result.reply : '';
      const text = tokens(row.original_text + ' ' + reply);
      const score = words.filter(w => text.includes(w)).length;
      return score ? [{ row, reply, score }] : [];
    } catch { return []; }
  }).sort((a,b) => b.score-a.score || b.row.created_at-a.row.created_at);
  return visible.slice(0, 4).map(({row,reply}) => ({
    sourceId: row.event_key, recordedAt: row.created_at,
    staffSaid: row.original_text.slice(0, 650), aminReplied: reply.slice(0, 500),
    evidence: 'Historical conversation only; not current facts, approval or delivery proof.',
  }));
}

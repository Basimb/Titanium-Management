import { createHmac } from 'node:crypto';
import { boundedPlainText } from './group-privacy.mjs';
import { normalizePollChoices } from './polls.mjs';

const BACKEND_UNCONFIRMED_REPLY = 'تعذّر التأكد من نتيجة طلبك الآن. إذا كان يغيّر بيانات، راجع الموقع قبل إعادة إرساله. إذا كان مجرد سؤال، جرّب لاحقًا.';
function backendUnavailable(store, row, reason) {
  // An earlier timed-out attempt may have committed on the website. This is
  // feedback only, not permission to replay the command under another ID.
  const reasons = { backend_network: 'backend_network_exhausted', backend_429: 'backend_429_exhausted', backend_503: 'backend_503_exhausted' };
  store.backendResult(row.id, { status: 'unavailable', reply: BACKEND_UNCONFIRMED_REPLY,
    failureReason: Object.hasOwn(reasons, reason) ? reasons[reason] : 'backend_retry_exhausted' });
}

export function signatureHeaders(rawBody, key, now) {
  const timestamp = String(now);
  return {
    'content-type': 'application/json',
    'x-titanium-chat-timestamp': timestamp,
    'x-titanium-chat-signature': createHmac('sha256', Buffer.from(key, 'hex')).update(`${timestamp}\n${rawBody}`).digest('hex'),
  };
}

async function boundedResponse(response, now) {
  if (Number(response.headers.get('content-length')) > 16_384) throw new Error('response_too_large');
  if (!response.body) throw new Error('empty_response');
  const reader = response.body.getReader();
  const parts = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 16_384) throw new Error('response_too_large');
      parts.push(Buffer.from(value));
    }
  } finally { await reader.cancel().catch(() => {}); }
  const result = JSON.parse(Buffer.concat(parts).toString('utf8'));
  if (!result || Array.isArray(result) || typeof result.status !== 'string' || result.status.length > 64 ||
      typeof result.reply !== 'string' || result.reply.length > 4000 ||
      (result.taskId != null && (typeof result.taskId !== 'string' || result.taskId.length > 200))) {
    throw new Error('invalid_response');
  }
  // Keep only bounded display choices; any model-provided recipient is discarded.
  const choices = normalizePollChoices(result.choices, now);
  return { status: result.status, reply: boundedPlainText(result.reply), ...(result.taskId ? { taskId: result.taskId } : {}),
    ...(choices && result.reply ? { choices } : {}) };
}

export async function deliverOne(store, row, config, { fetcher = fetch, sendReply, now = Date.now,
  authorizeChat, onPrivacyBlocked = async () => {} }) {
  let body;
  try { body = JSON.parse(row.raw_body); } catch { store.fail(row.id, 'invalid_stored_body'); return; }
  // A removed employee/group must not regain access through an old queued row.
  if (!config.allowedNumbers.has(body.senderNumber) || body.senderNumber === config.botNumber ||
      (body.groupId !== null && (!config.allowedGroups.has(body.groupId) || body.groupId !== row.chat_jid))) {
    store.fail(row.id, 'authorization_removed');
    return;
  }
  // Check before both inference/mutation and delivery. Missing group policy fails closed.
  if ((body.groupId !== null && !authorizeChat) || (authorizeChat && !await authorizeChat(body))) {
    store.fail(row.id, 'privacy_check_failed');
    await onPrivacyBlocked(body).catch(() => {});
    return;
  }
  if (row.state === 'backend') {
    if (row.backend_attempts >= 5) { backendUnavailable(store, row, row.error_code); return; }
    store.attemptBackend(row.id);
    let response;
    try {
      response = await fetcher(config.backendUrl, {
        method: 'POST', body: row.raw_body,
        headers: signatureHeaders(row.raw_body, config.key, now()),
        // Cover one bounded schema repair plus public search/review and DB overhead.
        redirect: 'error', signal: AbortSignal.timeout(80_000),
      });
    } catch {
      if (row.backend_attempts + 1 >= 5) backendUnavailable(store, row, 'backend_network');
      else store.retry(row.id, 'backend', now() + Math.min(60_000, 2000 * 2 ** row.backend_attempts), 'backend_network');
      return;
    }
    if (response.status === 429 || response.status === 503) {
      const header = response.headers.get('retry-after');
      const seconds = header && /^\d+(?:\.\d+)?$/.test(header) ? Number(header) : header ? (Date.parse(header) - now()) / 1000 : NaN;
      const wait = Math.max(Math.min(60_000, 2000 * 2 ** row.backend_attempts),
        Number.isFinite(seconds) ? Math.max(1000, Math.min(180_000, Math.ceil(seconds * 1000))) : 0);
      await response.body?.cancel().catch(() => {});
      if (row.backend_attempts + 1 >= 5) backendUnavailable(store, row, `backend_${response.status}`);
      else store.retry(row.id, 'backend', now() + wait, `backend_${response.status}`);
      return;
    }
    if (response.status !== 200) {
      await response.body?.cancel().catch(() => {});
      store.fail(row.id, `backend_http_${response.status}`);
      return;
    }
    try { store.backendResult(row.id, await boundedResponse(response, now())); }
    catch { store.fail(row.id, 'backend_invalid_result'); }
    return;
  }
  if (row.state === 'reply') {
    if (row.reply_attempts >= 3) { store.fail(row.id, 'reply_retry_exhausted'); return; }
    store.attemptReply(row.id);
    try {
      // original chat and a persisted outgoing ID; never route from response text.
      await sendReply(row.chat_jid, boundedPlainText(row.reply), row.reply_id, body, JSON.parse(row.result || '{}'));
      store.done(row.id);
    } catch {
      if (row.reply_attempts + 1 >= 3) store.fail(row.id, 'reply_retry_exhausted');
      else store.retry(row.id, 'reply', now() + 5000 * 2 ** row.reply_attempts, 'reply_send_failed');
    }
  }
}


import { createHash, timingSafeEqual } from 'node:crypto';
import { withAbortSignal } from './group-privacy.mjs';
import { selectIncoming } from './identity.mjs';

export const MAX_VOICE_BYTES = 10 * 1024 * 1024;
export const MAX_VOICE_SECONDS = 300;

export function validVoiceMetadata(audio) {
  if (!audio || audio.ptt !== true || typeof audio.mimetype !== 'string' ||
    !/^audio\/ogg(?:;\s*codecs=opus)?$/i.test(audio.mimetype) ||
    !Number.isFinite(Number(audio.seconds)) || Number(audio.seconds) <= 0 || Number(audio.seconds) > MAX_VOICE_SECONDS ||
    !Number.isSafeInteger(Number(audio.fileLength)) || Number(audio.fileLength) <= 0 || Number(audio.fileLength) > MAX_VOICE_BYTES ||
    !(audio.mediaKey instanceof Uint8Array) || audio.mediaKey.length !== 32 ||
    !(audio.fileSha256 instanceof Uint8Array) || audio.fileSha256.length !== 32) return false;
  if (audio.directPath != null && (typeof audio.directPath !== 'string' || audio.directPath.length > 2048 ||
    !audio.directPath.startsWith('/') || audio.directPath.startsWith('//') || /[\\\u0000-\u0020]/.test(audio.directPath))) return false;
  if (!audio.directPath && !audio.url) return false;
  if (audio.url != null) {
    try {
      const url = new URL(audio.url);
      if (url.protocol !== 'https:' || url.hostname !== 'mmg.whatsapp.net' || url.username || url.password ||
        url.port || url.hash || audio.url.length > 3000) return false;
    } catch { return false; }
  }
  return true;
}

// Validate the actual Ogg/Opus container in memory. Do not trust a claimed duration
// or pass a user-controlled URL to Groq. Multiple/chained logical streams are denied.
export function opusDuration(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 47 || buffer.length > MAX_VOICE_BYTES) throw new Error('invalid_voice_container');
  let offset = 0, serial, sequence = 0, preSkip = 0, lastGranule = -1n, ended = false, packetComplete = false;
  while (offset < buffer.length) {
    if (ended || offset + 27 > buffer.length || buffer.toString('ascii', offset, offset + 4) !== 'OggS' || buffer[offset + 4] !== 0) {
      throw new Error('invalid_voice_container');
    }
    const flags = buffer[offset + 5];
    const pageSerial = buffer.readUInt32LE(offset + 14);
    const pageSequence = buffer.readUInt32LE(offset + 18);
    const segments = buffer[offset + 26];
    if (!segments || offset + 27 + segments > buffer.length || pageSequence !== sequence++) throw new Error('invalid_voice_container');
    let payloadLength = 0;
    for (let i = 0; i < segments; i++) payloadLength += buffer[offset + 27 + i];
    const start = offset + 27 + segments;
    const end = start + payloadLength;
    if (end > buffer.length) throw new Error('invalid_voice_container');
    if (serial === undefined) {
      if (!(flags & 2) || payloadLength < 19 || buffer.toString('ascii', start, start + 8) !== 'OpusHead' ||
        buffer[start + 8] !== 1 || buffer[start + 9] !== 1) throw new Error('invalid_voice_container');
      serial = pageSerial;
      preSkip = buffer.readUInt16LE(start + 10);
    } else if (serial !== pageSerial || (flags & 2)) throw new Error('invalid_voice_container');
    const granule = buffer.readBigInt64LE(offset + 6);
    if (granule >= 0n) {
      if (granule < lastGranule) throw new Error('invalid_voice_container');
      lastGranule = granule;
    }
    ended = !!(flags & 4);
    packetComplete = buffer[offset + 27 + segments - 1] < 255 && granule >= 0n;
    offset = end;
  }
  const duration = Number(lastGranule - BigInt(preSkip)) / 48_000;
  // Some voice recorders omit EOS. Complete pages, a complete final packet and
  // the decoded sample counter still establish the bounded duration.
  if (!packetComplete || !Number.isFinite(duration) || duration <= 0) throw new Error('voice_duration_invalid');
  if (duration > MAX_VOICE_SECONDS) throw new Error('voice_duration_exceeded');
  return duration;
}

export function safeVoiceTranscript(value) {
  if (typeof value !== 'string' || value.length > 2000) return null;
  const text = value.trim();
  if (!text || /^[0-9٠-٩۰-۹\s-]{4,20}$/.test(text) ||
    /(?:gsk_[a-zA-Z0-9]{12,}|sk-[a-zA-Z0-9_-]{12,}|bearer\s+[a-zA-Z0-9._-]{12,}|password|passcode|\botp\b|كلمة\s*(?:المرور|السر)|(?:رمز|كود)\s*(?:الدخول|التحقق|التفعيل))/i.test(text)) return null;
  return text;
}

export function createVoiceTranscriber({ apiKey, downloadContent, fetcher = fetch }) {
  if (typeof apiKey !== 'string' || !apiKey.trim() || apiKey.length > 500 || /[\r\n]/.test(apiKey) ||
    typeof downloadContent !== 'function') throw new Error('invalid_voice_settings');
  return async (audio, { authorize }) => {
    if (!validVoiceMetadata(audio) || typeof authorize !== 'function') throw new Error('voice_not_eligible');
    const signal = AbortSignal.timeout(15_000);
    let stream, audioBuffer;
    let stage = 'authorization';
    const chunks = [];
    try {
      if (!await withAbortSignal(authorize, signal)) throw new Error('voice_unauthorized');
      // Pin the CDN host, refuse redirects, and let an abort stop the streaming fetch.
      stage = 'download';
      stream = await withAbortSignal(() => downloadContent(audio, 'audio', {
        host: 'mmg.whatsapp.net', options: { signal, redirect: 'error' },
      }), signal);
      const abortStream = () => stream.destroy?.();
      signal.addEventListener('abort', abortStream, { once: true });
      try {
        let length = 0;
        await withAbortSignal(async () => {
          for await (const chunk of stream) {
            length += chunk.length;
            if (length > MAX_VOICE_BYTES || signal.aborted) throw new Error('voice_too_large');
            chunks.push(Buffer.from(chunk));
          }
        }, signal);
      } finally { signal.removeEventListener('abort', abortStream); }
      audioBuffer = Buffer.concat(chunks);
      stage = 'validation';
      if (!timingSafeEqual(createHash('sha256').update(audioBuffer).digest(), Buffer.from(audio.fileSha256))) throw new Error('voice_integrity_failed');
      opusDuration(audioBuffer);
      // Recheck current active sender + all current group members BEFORE upload to Groq.
      if (!await withAbortSignal(authorize, signal)) throw new Error('voice_unauthorized');
      const form = new FormData();
      form.set('file', new Blob([audioBuffer], { type: 'audio/ogg' }), 'voice.ogg');
      form.set('model', 'whisper-large-v3-turbo');
      form.set('language', 'ar');
      form.set('temperature', '0');
      form.set('response_format', 'verbose_json');
      stage = 'transcription';
      const response = await withAbortSignal(() => fetcher('https://api.groq.com/openai/v1/audio/transcriptions', {
        method: 'POST', headers: { authorization: `Bearer ${apiKey}` }, body: form, signal, redirect: 'error',
      }), signal);
      if (response.status !== 200 || Number(response.headers.get('content-length')) > 16_384 || !response.body) {
        await response.body?.cancel().catch(() => {});
        throw new Error('voice_transcription_unavailable');
      }
      const reader = response.body.getReader();
      const parts = []; let size = 0;
      try {
        await withAbortSignal(async () => {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > 16_384) throw new Error('voice_response_too_large');
            parts.push(Buffer.from(value));
          }
        }, signal);
      } finally { await reader.cancel().catch(() => {}); }
      const result = JSON.parse(Buffer.concat(parts).toString('utf8'));
      const text = safeVoiceTranscript(result?.text);
      if (!text || typeof result?.duration !== 'number' || result.duration <= 0 || result.duration > MAX_VOICE_SECONDS) throw new Error('voice_transcript_rejected');
      return text;
    } catch (error) {
      const known = new Set(['voice_unauthorized','voice_too_large','voice_integrity_failed','voice_duration_invalid','voice_duration_exceeded','voice_transcription_unavailable','voice_response_too_large','voice_transcript_rejected']);
      throw new Error(known.has(error?.message) ? error.message : `voice_${stage}_failed`);
    } finally {
      stream?.destroy?.();
      audioBuffer?.fill(0);
      for (const chunk of chunks) chunk.fill(0);
    }
  };
}

export async function selectVoiceIncoming(message, event, config, identity, now, activatedAt, { transcribe, authorize, reserve }) {
  const content = message?.message;
  if (!config.voiceEnabled || !content?.audioMessage || Object.keys(content).some(k => content[k] != null && !['audioMessage','messageContextInfo'].includes(k)) || !validVoiceMetadata(content.audioMessage)) return null;
  const quoted = content.audioMessage.contextInfo?.stanzaId;
  const projected = { ...message, message: { extendedTextMessage: { text: 'رسالة صوتية للعمل', ...(quoted ? { contextInfo: { stanzaId: quoted } } : {}) } } };
  const incoming = await selectIncoming(projected, event, config, identity, now, activatedAt);
  if (!incoming || !await authorize(incoming.body) || !reserve(incoming.body)) return null;
  const text = await transcribe(content.audioMessage, { authorize: () => authorize(incoming.body) });
  if (!safeVoiceTranscript(text) || !await authorize(incoming.body)) return null;
  return { ...incoming, body: { ...incoming.body, text, inputKind: 'voice' } };
}


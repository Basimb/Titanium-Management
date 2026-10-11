// Identity comes ONLY from the transport envelope and Baileys' learned mapping.
// The normalizer is Baileys.jidNormalizedUser, supplied by the running adapter.
function canonicalIdentity(value, normalizeJid) {
  if (typeof value !== 'string' || value.length > 100) return null;
  if (!/^[0-9]+(?::[0-9]+)?@(?:s\.whatsapp\.net|lid)$/.test(value)) return null;
  const jid = normalizeJid(value);
  return typeof jid === 'string' && /^[0-9]+@(?:s\.whatsapp\.net|lid)$/.test(jid) ? jid : null;
}

function phoneFromJid(jid) {
  const match = /^([1-9][0-9]{7,14})@s\.whatsapp\.net$/.exec(jid || '');
  return match?.[1] || null;
}

export async function resolvePhone(primary, alternate, { normalizeJid, lookupPhoneForLid }) {
  const jid = canonicalIdentity(primary, normalizeJid);
  if (!jid) return null;
  const alt = alternate == null ? null : canonicalIdentity(alternate, normalizeJid);
  if (alternate != null && !alt) return null;
  const known = new Set();
  for (const candidate of [jid, alt].filter(Boolean)) {
    const direct = phoneFromJid(candidate);
    if (direct) known.add(direct);
    else if (candidate.endsWith('@lid')) {
      let mapped;
      try { mapped = await lookupPhoneForLid(candidate); } catch { return null; }
      if (mapped != null) {
        const phone = phoneFromJid(canonicalIdentity(mapped, normalizeJid));
        if (!phone) return null;
        known.add(phone);
      }
    }
  }
  // Two inconsistent PNs, or two unrelated LIDs, must not gain authorization.
  if (jid.endsWith('@lid') && alt?.endsWith('@lid') && jid !== alt) return null;
  return known.size === 1 ? [...known][0] : null;
}

export async function selectIncoming(message, event, config, identity, now, activatedAt) {
  if (event.type !== 'notify' || event.requestId != null || !message?.key || message.key.fromMe) return null;
  const { key } = message;
  if (typeof key.id !== 'string' || !/^[a-zA-Z0-9_-]{1,200}$/.test(key.id)) return null;
  const chat = key.remoteJid;
  if (typeof chat !== 'string') return null;
  const isGroup = /^[0-9]+(?:-[0-9]+)?@g\.us$/.test(chat);
  if (isGroup && !config.allowedGroups.has(chat)) return null;
  if (!isGroup && !canonicalIdentity(chat, identity.normalizeJid)) return null;
  const timestampSeconds = Number(message.messageTimestamp);
  const sentAt = timestampSeconds * 1000;
  if (!Number.isFinite(sentAt) || sentAt < activatedAt - 1000 || sentAt < now - 300_000 || sentAt > now + 60_000) return null;
  const content = message.message;
  if (!content || typeof content !== 'object') return null;
  const fields = Object.keys(content).filter(key => content[key] != null);
  if (fields.some(key => !['conversation', 'extendedTextMessage', 'messageContextInfo'].includes(key))) return null;
  if (typeof content.conversation === 'string' && content.extendedTextMessage != null) return null;
  const text = content.conversation ?? content.extendedTextMessage?.text;
  if (typeof text !== 'string' || !text.trim() || text.length > 2000) return null;
  // Login codes are entered on the website, never forwarded to an AI service.
  if (/^[0-9٠-٩]{6}$/.test(text.trim())) return null;
  // Owner rule: in a group the secretary stays completely silent unless the
  // message names it ("سكرتير"). Filtered here, before the backend, so even a
  // backend failure can never produce a group reply to an unaddressed message.
  if (isGroup && !/سكرتير/.test(text)) return null;
  const senderNumber = await resolvePhone(isGroup ? key.participant : chat,
    isGroup ? key.participantAlt : key.remoteJidAlt, identity);
  if (!senderNumber || senderNumber === config.botNumber || !config.allowedNumbers.has(senderNumber)) return null;
  // A quote is only a reference. Never forward quoted content, names, or identities.
  const quotedId = content.extendedTextMessage?.contextInfo?.stanzaId;
  const replyToMessageId = typeof quotedId === 'string' && /^[a-zA-Z0-9_-]{1,200}$/.test(quotedId)
    ? quotedId : undefined;
  return {
    chatJid: isGroup ? chat : identity.normalizeJid(chat),
    body: { messageId: key.id, senderNumber, groupId: isGroup ? chat : null, text, receivedAt: now,
      ...(replyToMessageId ? { replyToMessageId } : {}) },
  };
}

const EmailSent = require('../models/EmailSent');
const MailboxMessage = require('../models/MailboxMessage');
const {
  getGmailMessage,
  getOAuthAccessToken,
  resolveImapSettings
} = require('./mailService');
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');

function normalizeSubjectRoot(subject) {
  let s = String(subject || '').trim();
  for (let i = 0; i < 4; i += 1) {
    const next = s.replace(/^(re|fwd|fw):\s*/i, '').trim();
    if (next === s) break;
    s = next;
  }
  return s.slice(0, 500);
}

function buildConversationKey(accountId, to, subject) {
  const peer = String(to || '')
    .trim()
    .toLowerCase();
  const root = normalizeSubjectRoot(subject).toLowerCase();
  return `${String(accountId)}:${peer}:${root}`.slice(0, 600);
}

function subjectMatchesRoot(subject, rootSubject) {
  const root = normalizeSubjectRoot(rootSubject).toLowerCase();
  const subj = normalizeSubjectRoot(subject).toLowerCase();
  if (!root || !subj) return false;
  return subj === root || subj.includes(root) || root.includes(subj);
}

function parseAddressList(value) {
  return String(value || '')
    .split(',')
    .map((p) => {
      const m = p.match(/<([^>]+)>/);
      return (m ? m[1] : p).trim().toLowerCase();
    })
    .filter(Boolean);
}

function addressesInclude(value, email) {
  const target = String(email || '').trim().toLowerCase();
  if (!target) return false;
  return parseAddressList(value).some((a) => a === target || a.endsWith(`@${target.split('@')[1]}`));
}

async function fetchGmailThreadMessages(account, threadId) {
  if (!threadId) return [];
  const accessToken = await getOAuthAccessToken(account);
  const res = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/threads/${encodeURIComponent(threadId)}?format=full`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data?.error?.message || `Gmail thread fetch failed (${res.status})`);
  }
  const messages = [];
  for (const item of data.messages || []) {
    try {
      messages.push(await getGmailMessage(account, item.id, account.email));
    } catch (err) {
      console.warn('[gmail] skip thread message', item.id, err?.message || err);
    }
  }
  return messages;
}

async function searchGmailConversationMessages(account, sent) {
  const root = normalizeSubjectRoot(sent.rootSubject || sent.subject);
  const peer = String(sent.to || '').trim().toLowerCase();
  const own = String(account.email || '').trim().toLowerCase();
  const since = sent.sentAt || sent.createdAt || new Date(Date.now() - 30 * 86400000);
  const afterSec = Math.floor(new Date(since).getTime() / 1000) - 86400;
  const q = [`after:${afterSec}`, `(from:${peer} OR to:${peer})`];
  if (root) q.push(`subject:"${root.replace(/"/g, '')}"`);
  const accessToken = await getOAuthAccessToken(account);
  const params = new URLSearchParams({ maxResults: '50', q: q.join(' ') });
  const res = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages?${params}`, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data?.error?.message || `Gmail search failed (${res.status})`);
  }
  const messages = [];
  for (const item of data.messages || []) {
    try {
      const full = await getGmailMessage(account, item.id, account.email);
      const involvesPeer =
        addressesInclude(full.from, peer) ||
        addressesInclude(full.to, peer) ||
        addressesInclude(full.from, own) ||
        addressesInclude(full.to, own);
      if (involvesPeer && subjectMatchesRoot(full.subject, root)) {
        messages.push(full);
      }
    } catch (err) {
      console.warn('[gmail] skip search hit', item.id, err?.message || err);
    }
  }
  return messages;
}

async function normalizeParsedMail(parsed, { providerMessageId, direction, labelIds }) {
  const from = parseAddressList(parsed.from?.text || parsed.from?.value?.[0]?.address || '')[0] || '';
  const to = parseAddressList(parsed.to?.text || parsed.to?.value?.map((v) => v.address).join(', ') || '')[0] || '';
  return {
    providerMessageId,
    threadId: parsed.messageId || '',
    labelIds: labelIds || [],
    direction,
    from,
    to,
    cc: parsed.cc?.text || '',
    subject: String(parsed.subject || '').slice(0, 1000),
    snippet: String(parsed.text || parsed.html || '').replace(/\s+/g, ' ').slice(0, 2000),
    body: String(parsed.text || '').slice(0, 200000),
    bodyHtml: String(parsed.html || '').slice(0, 200000),
    internalDate: parsed.date ? new Date(parsed.date) : null
  };
}

async function fetchImapConversationMessages(account, sent) {
  const settings = resolveImapSettings(account);
  const client = new ImapFlow({
    host: settings.host,
    port: settings.port,
    secure: settings.secure,
    auth: { user: settings.user, pass: settings.pass },
    logger: false
  });
  const peer = String(sent.to || '').trim().toLowerCase();
  const own = String(account.email || '').trim().toLowerCase();
  const root = normalizeSubjectRoot(sent.rootSubject || sent.subject);
  const since = new Date(sent.sentAt || sent.createdAt || Date.now() - 30 * 86400000);
  since.setDate(since.getDate() - 1);
  const messages = [];

  try {
    await client.connect();
    const folders = ['INBOX', '[Gmail]/Sent Mail', 'Sent'];
    for (const folderPath of folders) {
      let lock;
      try {
        lock = await client.getMailboxLock(folderPath);
      } catch {
        continue;
      }
      try {
        const exists = Number(client.mailbox?.exists || 0);
        if (!exists) continue;
        const startSeq = Math.max(1, exists - 80);
        const direction =
          /sent/i.test(folderPath) || folderPath.includes('[Gmail]/Sent') ? 'outbound' : 'inbound';
        for await (const msg of client.fetch(`${startSeq}:*`, {
          uid: true,
          source: true,
          envelope: true,
          internalDate: true
        })) {
          if (msg.internalDate && new Date(msg.internalDate) < since) continue;
          try {
            const parsed = await simpleParser(msg.source);
            const subject = String(parsed.subject || msg.envelope?.subject || '');
            if (!subjectMatchesRoot(subject, root)) continue;
            const from = parseAddressList(parsed.from?.text || '')[0] || '';
            const to = parseAddressList(parsed.to?.text || '')[0] || '';
            const involvesPeer =
              from === peer ||
              to === peer ||
              addressesInclude(parsed.from?.text, peer) ||
              addressesInclude(parsed.to?.text, peer);
            const involvesOwn =
              from === own ||
              to === own ||
              addressesInclude(parsed.from?.text, own) ||
              addressesInclude(parsed.to?.text, own);
            if (!involvesPeer || !involvesOwn) continue;
            const normalized = await normalizeParsedMail(parsed, {
              providerMessageId: `imap:${folderPath}:${msg.uid}`,
              direction,
              labelIds: [folderPath]
            });
            if (!normalized.internalDate && msg.internalDate) {
              normalized.internalDate = new Date(msg.internalDate);
            }
            messages.push(normalized);
          } catch {
            // skip
          }
        }
      } finally {
        try {
          lock.release();
        } catch {
          // ignore
        }
      }
    }
  } finally {
    try {
      await client.logout();
    } catch {
      // ignore
    }
  }
  return messages;
}

async function upsertConversationMessages(userId, account, sent, rawMessages, conversationKey) {
  const provider = account.method === 'oauth' ? 'gmail' : 'imap';
  let upserted = 0;
  for (const msg of rawMessages || []) {
    if (!msg?.providerMessageId) continue;
    await MailboxMessage.findOneAndUpdate(
      { accountId: account._id, providerMessageId: msg.providerMessageId },
      {
        $set: {
          userId,
          accountId: account._id,
          provider,
          ...msg,
          threadId: msg.threadId || sent.threadId || '',
          conversationKey,
          emailSentId: sent._id,
          isAppConversation: true,
          syncedAt: new Date()
        }
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    upserted += 1;
  }
  return upserted;
}

async function syncConversationForSent(sent, account) {
  if (!sent || sent.status !== 'sent' || !account) {
    return { upserted: 0, skipped: true };
  }
  const conversationKey =
    sent.conversationKey ||
    buildConversationKey(account._id, sent.to, sent.rootSubject || sent.subject);

  if (!sent.conversationKey) {
    await EmailSent.updateOne({ _id: sent._id }, { $set: { conversationKey } });
    sent.conversationKey = conversationKey;
  }

  let rawMessages = [];
  if (account.method === 'oauth') {
    if (sent.threadId) {
      rawMessages = await fetchGmailThreadMessages(account, sent.threadId);
    } else {
      rawMessages = await searchGmailConversationMessages(account, sent);
      const threadId = rawMessages.find((m) => m.threadId)?.threadId || '';
      if (threadId && !sent.threadId) {
        await EmailSent.updateMany(
          { userId: sent.userId, accountId: account._id, conversationKey },
          { $set: { threadId } }
        );
        sent.threadId = threadId;
      }
    }
  } else if (account.method === 'app_password') {
    rawMessages = await fetchImapConversationMessages(account, sent);
  } else {
    return { upserted: 0, skipped: true, reason: 'unsupported_method' };
  }

  const upserted = await upsertConversationMessages(
    sent.userId,
    account,
    sent,
    rawMessages,
    conversationKey
  );
  return { upserted, conversationKey, fetched: rawMessages.length };
}

async function syncAppConversationsForAccount(account, { limit = 40 } = {}) {
  if (!account) return { synced: 0, upserted: 0, conversations: 0 };

  const recentSent = await EmailSent.find({
    userId: account.userId,
    accountId: account._id,
    status: 'sent'
  })
    .sort({ sentAt: -1, createdAt: -1 })
    .limit(Math.min(limit * 3, 120));

  for (const row of recentSent) {
    if (row.conversationKey) continue;
    row.conversationKey = buildConversationKey(account._id, row.to, row.rootSubject || row.subject);
    row.rootSubject = normalizeSubjectRoot(row.rootSubject || row.subject);
    await row.save();
  }

  const sentRows = await EmailSent.find({
    userId: account.userId,
    accountId: account._id,
    status: 'sent',
    conversationKey: { $exists: true, $ne: '' }
  })
    .sort({ sentAt: -1, createdAt: -1 })
    .limit(Math.min(limit, 100));

  const byKey = new Map();
  for (const row of sentRows) {
    if (!byKey.has(row.conversationKey)) byKey.set(row.conversationKey, row);
  }

  let upserted = 0;
  let synced = 0;
  for (const sent of byKey.values()) {
    try {
      const result = await syncConversationForSent(sent, account);
      upserted += result.upserted || 0;
      synced += 1;
    } catch (err) {
      console.warn('[conversation-sync] failed', sent.conversationKey, err?.message || err);
    }
  }

  return { synced, upserted, conversations: byKey.size };
}

module.exports = {
  normalizeSubjectRoot,
  buildConversationKey,
  syncConversationForSent,
  syncAppConversationsForAccount,
  fetchGmailThreadMessages
};

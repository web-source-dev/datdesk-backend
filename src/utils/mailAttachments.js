const MAX_FILES = 8;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_BYTES = 25 * 1024 * 1024;

const ALLOWED_MIME = new Set([
  'application/pdf',
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/gif',
  'image/webp',
  'text/plain',
  'text/csv',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
]);

function isAllowedAttachment(name, contentType) {
  const ct = String(contentType || '').toLowerCase().split(';')[0].trim();
  if (ALLOWED_MIME.has(ct)) return true;
  return /\.(pdf|png|jpe?g|gif|webp|txt|csv|doc|docx|xls|xlsx)$/i.test(String(name || ''));
}

function parseAttachmentsInput(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  let total = 0;

  for (const item of raw.slice(0, MAX_FILES)) {
    const filename = String(item?.filename || item?.name || 'attachment').trim().slice(0, 200);
    const contentType = String(item?.contentType || item?.type || 'application/octet-stream')
      .split(';')[0]
      .trim();
    let b64 = String(item?.content || item?.data || '').trim();
    b64 = b64.replace(/^data:[^;]+;base64,/, '');
    if (!b64) continue;

    let buf;
    try {
      buf = Buffer.from(b64, 'base64');
    } catch {
      continue;
    }
    if (!buf.length || buf.length > MAX_FILE_BYTES) continue;
    if (!isAllowedAttachment(filename, contentType)) continue;

    total += buf.length;
    if (total > MAX_TOTAL_BYTES) break;

    out.push({
      filename,
      contentType,
      size: buf.length,
      content: buf.toString('base64')
    });
  }

  return out;
}

function attachmentBuffer(item) {
  if (!item) return Buffer.alloc(0);
  if (Buffer.isBuffer(item.content)) return item.content;
  if (item.content && Buffer.isBuffer(item.content.buffer)) {
    return Buffer.from(item.content.buffer);
  }
  let b64 = String(item.content || item.data || '').trim();
  b64 = b64.replace(/^data:[^;]+;base64,/, '').replace(/\s+/g, '');
  if (!b64) return Buffer.alloc(0);
  try {
    return Buffer.from(b64, 'base64');
  } catch {
    return Buffer.alloc(0);
  }
}

function attachmentsForSend(stored) {
  return (Array.isArray(stored) ? stored : [])
    .map((a) => ({
      filename: String(a.filename || a.name || 'attachment').slice(0, 200),
      contentType: String(a.contentType || a.type || 'application/octet-stream'),
      content: attachmentBuffer(a)
    }))
    .filter((a) => a.filename && a.content && a.content.length);
}

function attachmentsMeta(stored) {
  return (Array.isArray(stored) ? stored : []).map((a) => ({
    filename: a.filename,
    contentType: a.contentType,
    size: a.size || 0
  }));
}

module.exports = {
  MAX_FILES,
  MAX_FILE_BYTES,
  MAX_TOTAL_BYTES,
  parseAttachmentsInput,
  attachmentsForSend,
  attachmentsMeta
};

const MailComposer = require('nodemailer/lib/mail-composer');

function toBase64Url(buffer) {
  return Buffer.from(buffer)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function stripHtml(html) {
  return String(html || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function normalizeAttachmentBuffers(attachments) {
  return (Array.isArray(attachments) ? attachments : []).map((item) => ({
    filename: String(item.filename || item.name || 'attachment').slice(0, 200),
    contentType: String(item.contentType || item.type || 'application/octet-stream'),
    content: Buffer.isBuffer(item.content)
      ? item.content
      : Buffer.from(String(item.content || ''), 'base64')
  }));
}

function buildMailComposerOptions({ from, to, cc, bcc, subject, body, bodyHtml, replyTo, attachments }) {
  const html = String(bodyHtml || '').trim() || (/<[a-z][\s\S]*>/i.test(body) ? body : '');
  const text = html ? stripHtml(html) : String(body || '');
  const attach = normalizeAttachmentBuffers(attachments)
    .filter((a) => a.content && a.content.length)
    .map((a) => ({
      filename: a.filename,
      content: a.content,
      contentType: a.contentType,
      contentDisposition: 'attachment'
    }));

  return {
    from,
    to,
    cc: cc ? String(cc).trim() : undefined,
    bcc: bcc ? String(bcc).trim() : undefined,
    subject: String(subject || '').replace(/\r?\n/g, ' '),
    text: text || ' ',
    html: html || undefined,
    replyTo: replyTo || undefined,
    attachments: attach.length ? attach : undefined
  };
}

function buildMimeMessage(options) {
  const composer = new MailComposer(buildMailComposerOptions(options));
  return new Promise((resolve, reject) => {
    composer.compile().build((err, message) => {
      if (err) reject(err);
      else resolve(message);
    });
  });
}

function buildRawMimeBase64Url(options) {
  return buildMimeMessage(options).then((message) => toBase64Url(message));
}

module.exports = {
  stripHtml,
  buildMimeMessage,
  buildRawMimeBase64Url,
  buildMailComposerOptions,
  normalizeAttachmentBuffers
};

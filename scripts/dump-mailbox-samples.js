require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const mongoose = require('mongoose');

async function main() {
  await mongoose.connect(process.env.MONGODB_URI);
  const MailboxMessage = require('../src/models/MailboxMessage');
  const n = await MailboxMessage.countDocuments();
  const samples = await MailboxMessage.find({
    $or: [{ body: { $ne: '' } }, { snippet: { $ne: '' } }, { subject: { $ne: '' } }]
  })
    .sort({ internalDate: -1 })
    .limit(15)
    .select('subject snippet body from to direction internalDate');

  console.log('total', n);
  for (const s of samples) {
    console.log('=====');
    console.log('FROM', s.from);
    console.log('TO', s.to);
    console.log('DIR', s.direction);
    console.log('SUBJ', String(s.subject || '').slice(0, 160));
    console.log('SNIP', String(s.snippet || '').slice(0, 220));
    console.log('BODY', String(s.body || '').slice(0, 500).replace(/\s+/g, ' '));
  }
  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

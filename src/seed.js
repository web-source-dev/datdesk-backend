require('dotenv').config();

const mongoose = require('mongoose');
const User = require('./models/User');

async function ensureUser({ email, name, password, role }) {
  let user = await User.findOne({ email });
  if (!user) {
    user = await User.create({ name, email, password, role });
    console.log('Created user:', email, '/', password);
    return user;
  }
  console.log('User already exists:', email);
  return user;
}

async function seed() {
  const uri = process.env.MONGODB_URI || 'mongodb://localhost:27017/datdesk';
  await mongoose.connect(uri);

  const adminEmail = process.env.SEED_ADMIN_EMAIL || 'admin@datdesk.local';
  const adminPassword = process.env.SEED_ADMIN_PASSWORD || 'Admin123!';

  await ensureUser({
    email: adminEmail,
    name: 'Admin',
    password: adminPassword,
    role: 'admin'
  });

  // Keep legacy seed emails working if they already exist / for migration
  if (adminEmail !== 'admin@newdatapp.local') {
    await ensureUser({
      email: 'admin@newdatapp.local',
      name: 'Admin',
      password: adminPassword,
      role: 'admin'
    });
  }

  await ensureUser({
    email: 'user@datdesk.local',
    name: 'Demo User',
    password: 'User123!',
    role: 'user'
  });

  await ensureUser({
    email: 'user@newdatapp.local',
    name: 'Demo User',
    password: 'User123!',
    role: 'user'
  });

  await mongoose.disconnect();
  console.log('Seed complete.');
}

seed().catch((err) => {
  console.error(err);
  process.exit(1);
});

const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const BACKUP_DIR = path.join(__dirname, '..', 'backups');
const MONGODB_URI = process.env.MONGODB_URI;

async function backup() {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const backupPath = path.join(BACKUP_DIR, `backup_${timestamp}`);
  fs.mkdirSync(backupPath, { recursive: true });

  await mongoose.connect(MONGODB_URI);

  const db = mongoose.connection.db;
  const collections = await db.listCollections().toArray();

  for (const col of collections) {
    const docs = await db.collection(col.name).find({}).toArray();
    const filePath = path.join(backupPath, `${col.name}.json`);
    fs.writeFileSync(filePath, JSON.stringify(docs, null, 2));
    console.log(`  ${col.name}: ${docs.length} docs`);
  }

  const metadata = {
    timestamp: new Date().toISOString(),
    database: db.databaseName,
    collections: collections.map(c => c.name),
    docCount: {}
  };
  for (const col of collections) {
    metadata.docCount[col.name] = await db.collection(col.name).countDocuments();
  }
  fs.writeFileSync(path.join(backupPath, '_metadata.json'), JSON.stringify(metadata, null, 2));

  await mongoose.disconnect();
  console.log(`Backup saved: ${backupPath}`);
  return backupPath;
}

backup().catch(err => {
  console.error('Backup FAILED:', err.message);
  process.exit(1);
});

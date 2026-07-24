const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const BACKUP_DIR = path.join(__dirname, '..', 'backups');
const MONGODB_URI = process.env.MONGODB_URI;

async function restore(backupName) {
  const backupPath = path.join(BACKUP_DIR, backupName);
  if (!fs.existsSync(backupPath)) {
    console.error(`Backup not found: ${backupPath}`);
    console.log('Available backups:');
    const dirs = fs.readdirSync(BACKUP_DIR).filter(d => d.startsWith('backup_'));
    dirs.forEach(d => console.log(`  ${d}`));
    process.exit(1);
  }

  await mongoose.connect(MONGODB_URI);
  const db = mongoose.connection.db;

  const files = fs.readdirSync(backupPath).filter(f => f.endsWith('.json') && f !== '_metadata.json');

  for (const file of files) {
    const colName = file.replace('.json', '');
    const docs = JSON.parse(fs.readFileSync(path.join(backupPath, file), 'utf8'));

    if (docs.length === 0) {
      console.log(`  ${colName}: 0 docs (skipped)`);
      continue;
    }

    await db.collection(colName).deleteMany({});
    await db.collection(colName).insertMany(docs);
    console.log(`  ${colName}: ${docs.length} docs restored`);
  }

  await mongoose.disconnect();
  console.log('Restore complete!');
}

const backupName = process.argv[2];
if (!backupName) {
  console.log('Usage: node auto-restore.js <backup_folder_name>');
  console.log('Available backups:');
  const dirs = fs.readdirSync(BACKUP_DIR).filter(d => d.startsWith('backup_'));
  dirs.forEach(d => console.log(`  ${d}`));
  process.exit(1);
}

restore(backupName).catch(err => {
  console.error('Restore FAILED:', err.message);
  process.exit(1);
});

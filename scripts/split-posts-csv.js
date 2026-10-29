#!/usr/bin/env node
/**
 * Splits the scheduler CSV export into one CSV per user (ownerId) under Post data/.
 * Columns that are empty for every row of that user are dropped.
 *
 *   node scripts/split-posts-csv.js "<export.csv>" <ownerId> [<ownerId> ...]
 */
const fs = require('fs');
const path = require('path');
const { parseCsvObjects, toCsv } = require('../csvPostData');

const [source, ...ownerIds] = process.argv.slice(2);
if (!source || ownerIds.length === 0) {
  console.error('usage: node scripts/split-posts-csv.js <export.csv> <ownerId> [<ownerId> ...]');
  process.exit(1);
}

const outDir = path.join(__dirname, '..', 'Post data');
const { columns, records } = parseCsvObjects(fs.readFileSync(source, 'utf8'));

for (const ownerId of ownerIds) {
  const rows = records.filter((r) => r.ownerId === ownerId);
  if (rows.length === 0) {
    console.warn(`ownerId ${ownerId}: no rows, skipped`);
    continue;
  }
  const used = columns.filter((c) => rows.some((r) => r[c] !== ''));
  const file = path.join(outDir, `user_${ownerId}.csv`);
  fs.writeFileSync(file, toCsv(used, rows), 'utf8');
  console.log(`ownerId ${ownerId}: ${rows.length} rows, ${used.length} columns -> ${path.relative(process.cwd(), file)}`);
}

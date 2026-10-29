#!/usr/bin/env node
/**
 * Splits the scheduler CSV export into one test-sample CSV per user (ownerId) under Post data/,
 * named after the brand so it can be recognised: <brand>_<business-type>_<place>__<ownerId>.csv
 * (+N-more when the user runs several brands). Each account is labelled by one cheap text-only
 * Haiku call per user; labels are cached in config/test-samples.json and reused on re-runs
 * (--relabel forces a new call). A user's old user_<ownerId>.csv is removed.
 *
 *   node scripts/build-test-samples.js "<export.csv>" <ownerId> [<ownerId> ...] [--relabel]
 */
const fs = require('fs');
const path = require('path');
const { parseCsvObjects, toCsv, recordsToPostData } = require('../csvPostData');
const { callAnthropic, extractText, tryParseJson } = require('../brandGuidelinePipeline');

const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'Post data');
const MANIFEST = path.join(ROOT, 'config', 'test-samples.json');
const SECRETS = path.join(ROOT, 'config', 'local-secrets.json');
const CAPTIONS_PER_ACCOUNT = 12;

const LABEL_SYSTEM = `You label test data. For each social media account below, read its captions and links and return:
- brand_name: the name the business or creator operates under, exactly as they write it. Not partners, suppliers, tagged accounts or product makes. null if unclear.
- business_type: 1-3 plain words for what the business is (e.g. "pub", "chiropractic clinic", "florist", "car dealership", "author"). null if unclear.
- locality: the town or city the business is in, only if the captions clearly say so. null otherwise.
Return ONLY JSON: {"accounts":[{"account_id":string,"brand_name":string|null,"business_type":string|null,"locality":string|null}]}`;

function slug(text, max = 30) {
  return String(text || '')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    .slice(0, max).replace(/-+$/, '');
}

function accountBlock(postData, account) {
  const posts = postData.posts.filter((p) => p.account_id === account.account_id).slice(0, CAPTIONS_PER_ACCOUNT);
  const lines = posts.map((p) => {
    const extra = [p.links && p.links.length ? `links: ${p.links.join(' ')}` : '', p.tagged_place ? `tagged place: ${p.tagged_place}` : ''].filter(Boolean).join('; ');
    return `- ${p.caption_text.replace(/\s+/g, ' ').slice(0, 400)}${extra ? ` (${extra})` : ''}`;
  });
  return `Account ${account.account_id} (${account.platform}, ${account.posts} posts):\n${lines.join('\n')}`;
}

async function labelAccounts(postData, apiKey) {
  const userText = postData.accounts.map((a) => accountBlock(postData, a)).join('\n\n');
  const response = await callAnthropic({
    apiKey,
    model: 'claude-haiku-5-5',
    effort: 'low',
    system: LABEL_SYSTEM,
    messages: [{ role: 'user', content: [{ type: 'text', text: userText }] }],
  });
  const parsed = tryParseJson(extractText(response));
  const byId = new Map(((parsed && parsed.accounts) || []).map((a) => [String(a.account_id), a]));
  return {
    usage: response.usage || null,
    accounts: postData.accounts.map((a) => {
      const l = byId.get(String(a.account_id)) || {};
      return { account_id: a.account_id, platform: a.platform, posts: a.posts, brand_name: l.brand_name || null, business_type: l.business_type || null, locality: l.locality || null };
    }),
  };
}

// "the-plough" / "the-plough-inn" and "wctr" / "wise-choice-tattoo-removal" are one brand
function sameBrand(a, b) {
  if (a.includes(b) || b.includes(a)) return true;
  const initials = (x) => x.split('-').filter((w) => w !== 'the').map((w) => w[0]).join('');
  return initials(a) === b || initials(b) === a;
}

function fileNameFor(ownerId, accounts) {
  // the account with the most posts names the file; other brands are counted, not listed
  const named = [...accounts].sort((a, b) => b.posts - a.posts);
  const main = named.find((a) => a.brand_name) || named[0] || {};
  const mainBrand = slug(main.brand_name) || 'unknown-brand';
  const others = [];
  for (const b of named.map((a) => slug(a.brand_name)).filter(Boolean)) {
    if (!sameBrand(b, mainBrand) && !others.some((o) => sameBrand(o, b))) others.push(b);
  }
  // a place only when the main brand's accounts don't name different ones (multi-location brands)
  const places = [...new Set(named.filter((a) => slug(a.brand_name) && sameBrand(slug(a.brand_name), mainBrand)).map((a) => slug(a.locality)).filter(Boolean))];
  const parts = [mainBrand, slug(main.business_type, 24), places.length === 1 ? places[0] : ''].filter(Boolean);
  return `${parts.join('_')}${others.length ? `+${others.length}-more` : ''}__${ownerId}.csv`;
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

(async () => {
  const args = process.argv.slice(2);
  const relabel = args.includes('--relabel');
  const [source, ...ownerIds] = args.filter((a) => a !== '--relabel');
  if (!source || ownerIds.length === 0) {
    console.error('usage: node scripts/build-test-samples.js <export.csv> <ownerId> [<ownerId> ...] [--relabel]');
    process.exit(1);
  }
  const apiKey = process.env.ANTHROPIC_API_KEY || readJson(SECRETS, {}).apiKey;
  const manifest = readJson(MANIFEST, { source: path.basename(source), samples: {} });
  const { columns, records } = parseCsvObjects(fs.readFileSync(source, 'utf8'));
  let cost = 0;

  for (const ownerId of ownerIds) {
    const rows = records.filter((r) => r.ownerId === ownerId);
    if (rows.length === 0) {
      console.warn(`ownerId ${ownerId}: no rows, skipped`);
      continue;
    }
    const postData = recordsToPostData(rows, { ownerId });
    let entry = manifest.samples[ownerId];
    if (!entry || relabel) {
      if (!apiKey) throw new Error('No API key: set ANTHROPIC_API_KEY or config/local-secrets.json');
      const { accounts, usage } = await labelAccounts(postData, apiKey);
      if (usage) cost += (usage.input_tokens * 0.10 + usage.output_tokens * 0.50) / 1e6;
      entry = { owner_id: ownerId, rows: rows.length, accounts, ...(entry && entry.file ? { file: entry.file } : {}) };
    }
    const file = fileNameFor(ownerId, entry.accounts);
    if (entry.file && entry.file !== file && fs.existsSync(path.join(OUT_DIR, entry.file))) fs.unlinkSync(path.join(OUT_DIR, entry.file));
    entry.file = file;
    manifest.samples[ownerId] = entry;

    const used = columns.filter((c) => rows.some((r) => r[c] !== ''));
    fs.writeFileSync(path.join(OUT_DIR, file), toCsv(used, rows), 'utf8');
    const old = path.join(OUT_DIR, `user_${ownerId}.csv`);
    if (fs.existsSync(old)) fs.unlinkSync(old);
    console.log(`${ownerId}: ${rows.length} rows -> ${file}`);
    for (const a of entry.accounts) console.log(`    ${a.platform} ${a.account_id}: ${a.brand_name || '?'} | ${a.business_type || '?'} | ${a.locality || '-'}`);
  }

  fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + '\n');
  console.log(`labels saved to config/test-samples.json${cost ? ` · labelling cost ~$${cost.toFixed(4)}` : ''}`);
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});

/**
 * CSV post-data support. The scheduler export (one row per scheduled post, one
 * column per flattened field like `postImage[0]` or `extraData.place.address`)
 * is converted into the same { account_info, posts } shape the JSON seed files
 * use, so the rest of the pipeline never needs to know a CSV was involved.
 */

// accountId -> platform, inferred from the export: every accountId 25 row with a
// permalink points at instagram.com, and accountId 5 rows never have one.
const ACCOUNT_ID_PLATFORMS = { 5: 'facebook', 25: 'instagram' };

// ---------- RFC 4180 parsing / writing ----------

function parseCsv(text) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += ch;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => !(r.length === 1 && r[0] === ''));
}

function parseCsvObjects(text) {
  const [header, ...rows] = parseCsv(text);
  if (!header) return { columns: [], records: [] };
  const records = rows.map((r) => Object.fromEntries(header.map((col, i) => [col, r[i] !== undefined ? r[i] : ''])));
  return { columns: header, records };
}

function csvEscape(value) {
  const s = value === undefined || value === null ? '' : String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(columns, records) {
  const lines = [columns.map(csvEscape).join(',')];
  for (const rec of records) lines.push(columns.map((c) => csvEscape(rec[c])).join(','));
  return lines.join('\n') + '\n';
}

// ---------- CSV rows -> post data ----------

function normalizeCaption(raw) {
  // the export stores line breaks as a literal backslash-n
  return (raw || '').replace(/\\r\\n|\\n/g, '\n').replace(/\\t/g, '\t').trim();
}

function extractHashtags(caption) {
  return [...new Set(caption.match(/#[\p{L}\p{N}_]+/gu) || [])];
}

function firstImageUrl(rec) {
  return rec['postImage[0]'] || rec['extraData.thumbnail'] || rec.thumbnail || rec['extraData.thumbnails[0]'] || null;
}

function postLinks(rec) {
  const links = Object.keys(rec)
    .filter((col) => /^linkRelations\[\d+\]\.originalUrl$/.test(col) && rec[col])
    .map((col) => rec[col]);
  return [...new Set(links)];
}

function postDate(rec) {
  return rec.scheduleDateUtc || rec.postDate || rec.createdOn || '';
}

/**
 * Converts one owner's rows into { account_info, posts }, one post per row, newest
 * first. Cross-posts (the same content published to Facebook and Instagram as two
 * rows) are deliberately NOT merged here: on live data there's no reliable key
 * linking them (captions get reworded, media URLs and publish times differ), so each
 * post carries its platform label and the extraction prompt groups near-identical
 * posts itself (see extraction v3's cross_post_groups).
 */
function recordsToPostData(records, { ownerId } = {}) {
  const sorted = [...records].sort((a, b) => postDate(b).localeCompare(postDate(a)));
  const posts = sorted.map((rec, i) => {
    const caption = normalizeCaption(rec.postDesc);
    const post = {
      post_id: `p${i + 1}`,
      date: postDate(rec).slice(0, 10),
      platform: ACCOUNT_ID_PLATFORMS[rec.accountId] || `account_${rec.accountId}`,
      account_id: rec.loginId || null,
      caption_text: caption,
      hashtags: extractHashtags(caption),
      image_url: firstImageUrl(rec),
      media_type: rec.postVideo ? 'video' : 'image',
    };
    const links = postLinks(rec);
    if (links.length) post.links = links;
    const place = rec['extraData.place.name'];
    if (place) post.tagged_place = rec['extraData.place.address'] ? `${place} (${rec['extraData.place.address']})` : place;
    return post;
  });

  const platforms = [...new Set(posts.map((p) => p.platform))];
  return {
    account_info: {
      owner_id: ownerId || (records[0] && records[0].ownerId) || null,
      platform: platforms.join(' + '),
    },
    posts,
    accounts: summarizeAccounts(posts),
    source: { format: 'csv', rows: records.length },
  };
}

/**
 * One entry per connected social account (loginId = one Facebook page or Instagram
 * profile), largest first. Top hashtags are only a hint for telling accounts apart in
 * the UI - one owner can run several unrelated brands.
 */
function summarizeAccounts(posts) {
  const byAccount = new Map();
  for (const post of posts) {
    if (!post.account_id) continue;
    if (!byAccount.has(post.account_id)) byAccount.set(post.account_id, { account_id: post.account_id, platform: post.platform, posts: 0, tagCounts: {} });
    const acc = byAccount.get(post.account_id);
    acc.posts += 1;
    for (const tag of post.hashtags) acc.tagCounts[tag] = (acc.tagCounts[tag] || 0) + 1;
  }
  return [...byAccount.values()]
    .map(({ tagCounts, ...acc }) => ({
      ...acc,
      top_hashtags: Object.entries(tagCounts).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([tag]) => tag),
    }))
    .sort((a, b) => b.posts - a.posts);
}

/** Restricts post data to one connected account; account_info.platform follows. */
function filterToAccount(postData, accountId) {
  const posts = (postData.posts || []).filter((p) => p.account_id === accountId);
  const account = (postData.accounts || []).find((a) => a.account_id === accountId);
  return {
    ...postData,
    account_info: { ...postData.account_info, account_id: accountId, platform: account ? account.platform : postData.account_info.platform },
    posts,
  };
}

function csvTextToPostData(text) {
  const { records } = parseCsvObjects(text);
  const owners = [...new Set(records.map((r) => r.ownerId).filter(Boolean))];
  if (owners.length > 1) {
    const err = new Error(`CSV contains ${owners.length} different ownerIds - split it per user first (scripts/split-posts-csv.js).`);
    err.status = 400;
    throw err;
  }
  return recordsToPostData(records, { ownerId: owners[0] });
}

/** Keeps the N most recent posts (by date), preserving the file's original order among them. */
function limitPosts(posts, limit) {
  const n = Number(limit);
  if (!Number.isInteger(n) || n <= 0 || n >= posts.length) return posts;
  const keep = new Set(
    posts
      .map((p, i) => ({ p, i }))
      .sort((a, b) => (b.p.date || '').localeCompare(a.p.date || '') || a.i - b.i)
      .slice(0, n)
      .map(({ p }) => p)
  );
  return posts.filter((p) => keep.has(p));
}

module.exports = {
  parseCsv,
  parseCsvObjects,
  toCsv,
  recordsToPostData,
  csvTextToPostData,
  filterToAccount,
  limitPosts,
};

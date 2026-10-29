const sharp = require('sharp');

const HEX_COLOR_RE = /#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b/g;
const RGB_COLOR_RE = /rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*(?:,\s*[\d.]+\s*)?\)/g;
// Out-of-the-box palettes of WordPress (block editor presets, admin blue) and Bootstrap 4/5:
// every site on those themes declares them, so they say nothing about the brand.
const THEME_DEFAULT_HEXES = new Set([
  '#cf2e2e', '#ff6900', '#fcb900', '#7bdcb5', '#00d084', '#8ed1fc', '#0693e3', '#9b51e0', '#f78da7', '#abb8c3',
  '#0073aa', '#005177', '#2271b1', '#135e96', '#007cba',
  '#0d6efd', '#6610f2', '#6f42c1', '#d63384', '#dc3545', '#fd7e14', '#ffc107', '#198754', '#20c997', '#0dcaf0',
  '#007bff', '#0056b3', '#28a745', '#17a2b8',
]);
const FETCH_TIMEOUT_MS = 15000; // small-business hosts can take 10s+ to wake up
const STYLESHEET_TIMEOUT_MS = 6000;
const MAX_STYLESHEETS = 10;
const PAGE_TEXT_MAX_CHARS = 8000;
const COLOR_DISTANCE_TOLERANCE = 24;
const SHADE_MERGE_DISTANCE = 40; // neighbouring quantization buckets of one color sit 16-28 apart
const MIN_PIXEL_SHARE = 0.02; // a color covering less of an image than this is detail, not design

// ---------- deterministic color helpers (no LLM involved) ----------

function normalizeHex(hex) {
  let h = hex.replace('#', '').toLowerCase();
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  return `#${h}`;
}

function rgbStringToHex(rgbStr) {
  const m = rgbStr.match(/rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})/);
  if (!m) return null;
  const clamp = (n) => Math.max(0, Math.min(255, Number(n)));
  return `#${[m[1], m[2], m[3]].map((n) => clamp(n).toString(16).padStart(2, '0')).join('')}`;
}

function hexToRgb(hex) {
  const h = hex.replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

function colorDistance(hexA, hexB) {
  const [r1, g1, b1] = hexToRgb(hexA);
  const [r2, g2, b2] = hexToRgb(hexB);
  return Math.sqrt((r1 - r2) ** 2 + (g1 - g2) ** 2 + (b1 - b2) ** 2);
}

// Whites, blacks and greys are backgrounds and body text, not brand colors: they are kept
// apart as neutrals so they can't outrank the accent a brand actually repeats.
function isNeutralColor(hex) {
  const [r, g, b] = hexToRgb(hex);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  return max - min < 40 || max < 50 || min > 224;
}

// The family words the extraction prompt (v7+) uses when it says which colors a designer chose.
// Neighbouring families also count as a match: where orange ends and brown begins is fuzzy to
// the eye, and the exact value comes from the pixels anyway.
const NEIGHBOUR_FAMILIES = {
  red: ['orange', 'pink', 'brown'],
  orange: ['red', 'yellow', 'brown'],
  yellow: ['orange', 'beige', 'brown', 'green'],
  green: ['yellow', 'teal'],
  teal: ['green', 'blue'],
  blue: ['teal', 'navy', 'purple'],
  navy: ['blue', 'purple'],
  purple: ['blue', 'navy', 'pink'],
  pink: ['red', 'purple'],
  brown: ['orange', 'beige'],
  beige: ['brown', 'yellow', 'white'],
  black: ['grey', 'navy', 'brown'],
  white: ['grey', 'beige'],
  grey: ['black', 'white'],
};

function toHsl(hex) {
  const [r, g, b] = hexToRgb(hex).map((v) => v / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return { h: 0, s: 0, l };
  const s = d / (1 - Math.abs(2 * l - 1));
  let h;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return { h: (h * 60 + 360) % 360, s, l };
}

/** Names a measured color with the same family words the extraction prompt uses. */
function colorFamily(hex) {
  const { h, l } = toHsl(hex);
  if (isNeutralColor(hex)) return l < 0.25 ? 'black' : l > 0.8 ? 'white' : 'grey';
  if (h < 15 || h >= 345) return l > 0.75 ? 'pink' : 'red';
  if (h < 50) {
    if (l < 0.35) return 'brown';
    if (l > 0.75) return 'beige';
    return h < 40 ? 'orange' : 'yellow';
  }
  if (h < 70) return 'yellow';
  if (h < 160) return 'green';
  if (h < 195) return 'teal';
  if (h < 250) return l < 0.3 ? 'navy' : 'blue';
  if (h < 290) return 'purple';
  return 'pink';
}

/** The role the model gave a measured color's family (or a neighbouring one) in this image, or undefined. */
function designRoleFor(hex, namedFamilies) {
  const family = colorFamily(hex);
  if (namedFamilies.has(family)) return namedFamilies.get(family);
  const near = (NEIGHBOUR_FAMILIES[family] || []).find((n) => namedFamilies.has(n));
  return near ? namedFamilies.get(near) : undefined;
}

/** Keeps at most `max` shades of each family, so a palette isn't four teals. */
function limitPerFamily(hexes, max = 2) {
  const seen = {};
  return hexes.filter((hex) => {
    const family = colorFamily(hex);
    seen[family] = (seen[family] || 0) + 1;
    return seen[family] <= max;
  });
}

/** Folds near-identical shades into the heaviest one; input must be sorted by count, descending. */
function mergeShades(colors) {
  const kept = [];
  for (const c of colors) {
    const into = kept.find((k) => colorDistance(k.color, c.color) <= SHADE_MERGE_DISTANCE);
    if (!into) kept.push({ ...c });
    else {
      into.count += c.count;
      if (into.share !== undefined) into.share += c.share;
    }
  }
  return kept;
}

function palettesOverlap(hexListA, hexListB, tolerance = COLOR_DISTANCE_TOLERANCE) {
  if (hexListA.length === 0 || hexListB.length === 0) return false;
  return hexListA.some((a) => hexListB.some((b) => colorDistance(a, b) <= tolerance));
}

/**
 * Deterministic tally of hex/rgb color declarations in raw CSS text.
 * Never touches an LLM - this is a measurement, not a perception guess.
 */
function extractWebsiteCssColors(cssText) {
  if (!cssText) return [];
  const tally = new Map();

  for (const raw of cssText.match(HEX_COLOR_RE) || []) {
    const norm = normalizeHex(raw);
    if (isNeutralColor(norm) || THEME_DEFAULT_HEXES.has(norm)) continue;
    tally.set(norm, (tally.get(norm) || 0) + 1);
  }
  for (const raw of cssText.match(RGB_COLOR_RE) || []) {
    const hex = rgbStringToHex(raw);
    if (!hex || isNeutralColor(hex) || THEME_DEFAULT_HEXES.has(hex)) continue;
    tally.set(hex, (tally.get(hex) || 0) + 1);
  }

  return mergeShades([...tally.entries()]
    .map(([color, count]) => ({ color, count }))
    .sort((a, b) => b.count - a.count));
}

// ---------- website fetch ----------

async function fetchWithTimeout(url, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function stripHtmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, PAGE_TEXT_MAX_CHARS);
}

function discoverStylesheetUrls(html, baseUrl) {
  const urls = [];
  const linkRe = /<link\b[^>]*>/gi;
  let m;
  while ((m = linkRe.exec(html))) {
    const tag = m[0];
    if (!/rel=["']?\s*stylesheet/i.test(tag)) continue;
    const hrefMatch = tag.match(/href=["']([^"']+)["']/i);
    if (!hrefMatch) continue;
    try {
      urls.push(new URL(hrefMatch[1], baseUrl).toString());
    } catch {
      // malformed href, skip
    }
  }
  return urls;
}

/**
 * Fetches a website's homepage, extracts plain text for the LLM website-extraction
 * pass, discovers <link rel="stylesheet"> URLs, fetches those stylesheets (best
 * effort - a failed stylesheet just means fewer colors, never aborts the run),
 * and tallies color declarations across all of them plus any inline <style> blocks.
 */
async function fetchWebsiteContent(url) {
  if (!url) return { ok: false, error: 'No website URL provided' };
  try {
    let res;
    try {
      res = await fetchWithTimeout(url, FETCH_TIMEOUT_MS);
    } catch (err) {
      // slow small-business hosts often connect on the second try; a bad certificate won't
      if (/CERT|TLS|SSL/i.test(String(err.cause && (err.cause.code || err.cause.message)))) throw err;
      res = await fetchWithTimeout(url, FETCH_TIMEOUT_MS);
    }
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const html = await res.text();

    const pageText = stripHtmlToText(html);
    const stylesheetUrls = discoverStylesheetUrls(html, url);

    let combinedCss = '';
    let stylesheetsFetched = 0;
    let stylesheetsFailed = 0;
    for (const cssUrl of stylesheetUrls.slice(0, MAX_STYLESHEETS)) {
      try {
        const cssRes = await fetchWithTimeout(cssUrl, STYLESHEET_TIMEOUT_MS);
        if (cssRes.ok) {
          combinedCss += `${await cssRes.text()}\n`;
          stylesheetsFetched += 1;
        } else {
          stylesheetsFailed += 1;
        }
      } catch {
        stylesheetsFailed += 1;
      }
    }
    for (const block of html.match(/<style[^>]*>([\s\S]*?)<\/style>/gi) || []) {
      combinedCss += `${block}\n`;
    }

    return {
      ok: true,
      pageText,
      stylesheetUrls,
      stylesheetsFetched,
      stylesheetsFailed,
      cssColors: extractWebsiteCssColors(combinedCss),
    };
  } catch (err) {
    return { ok: false, error: describeWebsiteFetchError(err) };
  }
}

// Node's fetch says only "fetch failed" / "aborted"; the useful reason is on err.cause
function describeWebsiteFetchError(err) {
  if (err.name === 'AbortError') return `timed out after ${FETCH_TIMEOUT_MS / 1000}s`;
  const code = err.cause && (err.cause.code || err.cause.message);
  if (code && /CERT|TLS|SSL/i.test(code)) return `the site's security certificate is invalid (${code})`;
  return code ? `${err.message}: ${code}` : err.message;
}

// ---------- deterministic image color quantization (graphic_designed posts only) ----------

/** Every color bucket in the image with its pixel share, most common first. */
async function quantizeImageColors(buffer, { bucket = 16 } = {}) {
  try {
    const { data, info } = await sharp(buffer)
      .resize(64, 64, { fit: 'inside' })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    const tally = new Map();
    const channels = info.channels;
    const clamp = (v) => Math.max(0, Math.min(255, v));
    for (let i = 0; i + channels <= data.length; i += channels) {
      const r = clamp(Math.round(data[i] / bucket) * bucket);
      const g = clamp(Math.round(data[i + 1] / bucket) * bucket);
      const b = clamp(Math.round(data[i + 2] / bucket) * bucket);
      const hex = `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
      tally.set(hex, (tally.get(hex) || 0) + 1);
    }

    const total = data.length / channels;
    return [...tally.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([color, count]) => ({ color, count, share: count / total }));
  } catch {
    return [];
  }
}

/**
 * Measures the colors of every image of one type. When the extraction (v7+) listed the colors a
 * designer chose for an image (design_colors), only measured colors of those families are kept:
 * the pixels give the exact value, the model says which pixels are design rather than a photo
 * inside it. Graphics branded for another business are skipped. Older extraction versions have
 * no design_colors, so every measured color is kept, as before.
 */
async function aggregatePostColorsByType(posts, images, classifications, imageTypes, { designColorsApply = true } = {}) {
  const byPostId = new Map((classifications || []).map((c) => [c.post_id, c]));
  const perPost = [];
  const thirdPartyPostIds = [];
  for (const post of posts) {
    const img = images[post.post_id];
    if (!img || !img.ok) continue;
    const note = byPostId.get(post.post_id);
    if (!note || !imageTypes.includes(note.image_type)) continue;
    if (designColorsApply && note.owner === 'third_party') {
      thirdPartyPostIds.push(post.post_id);
      continue;
    }
    const buckets = await quantizeImageColors(Buffer.from(img.base64, 'base64'));
    let colors = mergeShades(buckets.filter((c) => !isNeutralColor(c.color)))
      .filter((c) => c.share >= MIN_PIXEL_SHARE)
      .slice(0, 8);
    let unmatched = [];
    if (designColorsApply && Array.isArray(note.design_colors)) {
      const named = new Map(note.design_colors
        .filter((d) => d && d.family)
        .map((d) => [String(d.family).toLowerCase(), d.role || null]));
      const kept = [];
      for (const c of colors) {
        const role = designRoleFor(c.color, named);
        if (role === undefined) unmatched.push(c);
        else kept.push({ ...c, role });
      }
      colors = kept;
    }
    colors = colors.slice(0, 5);
    unmatched = unmatched.slice(0, 5);
    const neutrals = mergeShades(buckets.filter((c) => isNeutralColor(c.color))).slice(0, 3);
    perPost.push({ post_id: post.post_id, date: post.date || null, colors, neutrals, unmatched });
  }
  const mostRecentDate = perPost.reduce((latest, p) => (p.date && (!latest || p.date > latest) ? p.date : latest), null);
  return {
    perPost,
    aggregated: tallyAcrossPosts(perPost, 'colors'),
    neutrals: tallyAcrossPosts(perPost, 'neutrals'),
    notDesignColors: tallyAcrossPosts(perPost, 'unmatched'),
    thirdPartyPostIds,
    mostRecentDate,
    postsUsed: perPost.length,
  };
}

// Ranks colors by how many posts they recur in (a brand color repeats across posts), then by
// pixel count - so one large image can't outvote a color used again and again. Shades within
// SHADE_MERGE_DISTANCE of a cluster's first shade count as one color, named after its most
// common shade (matching stays on the first shade so a cluster can't drift into a neighbour).
function tallyAcrossPosts(perPost, key) {
  const clusters = [];
  for (const p of perPost) {
    for (const c of p[key]) {
      let cluster = clusters.find((k) => colorDistance(k.anchor, c.color) <= SHADE_MERGE_DISTANCE);
      if (!cluster) {
        cluster = { anchor: c.color, color: c.color, best: 0, postIds: new Set(), count: 0, roles: new Set() };
        clusters.push(cluster);
      }
      cluster.postIds.add(p.post_id);
      cluster.count += c.count;
      if (c.role) cluster.roles.add(c.role);
      if (c.count > cluster.best) {
        cluster.best = c.count;
        cluster.color = c.color;
      }
    }
  }
  return clusters
    .map((k) => ({ color: k.color, family: colorFamily(k.color), posts: k.postIds.size, count: k.count, ...(k.roles.size ? { roles: [...k.roles] } : {}) }))
    .sort((a, b) => b.posts - a.posts || b.count - a.count);
}

// ---------- photo mood (photographic posts only; never a brand palette) ----------

// a photo with a text overlay still fills most of the frame, so it shows the photo look too
const PHOTO_TYPES = ['photographic', 'photo_with_overlay'];
const MIN_MOOD_PHOTOS = 6;
const MOOD_CONSISTENCY = 0.6; // share of photos that must agree before a tone is stated

/** Average warmth, lightness and saturation of one photo - stable across subjects, unlike its hex colors. */
async function measureTone(buffer) {
  try {
    const { data, info } = await sharp(buffer).resize(64, 64, { fit: 'inside' }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const ch = info.channels;
    let warmth = 0, lightness = 0, saturation = 0, n = 0;
    for (let i = 0; i + ch <= data.length; i += ch) {
      const r = data[i], g = data[i + 1], b = data[i + 2];
      const max = Math.max(r, g, b), min = Math.min(r, g, b);
      const l = (max + min) / 2;
      warmth += r - b;
      lightness += l;
      saturation += max === min ? 0 : (max - min) / (255 - Math.abs(2 * l - 255) || 1);
      n += 1;
    }
    if (!n) return null;
    const avg = { warmth: warmth / n, lightness: lightness / n, saturation: saturation / n };
    return {
      ...avg,
      warmth_tone: avg.warmth > 12 ? 'warm' : avg.warmth < -12 ? 'cool' : 'neutral',
      brightness: avg.lightness < 85 ? 'dark' : avg.lightness > 165 ? 'bright' : 'mid',
      saturation_level: avg.saturation < 0.18 ? 'muted' : avg.saturation > 0.4 ? 'vivid' : 'moderate',
    };
  } catch {
    return null;
  }
}

async function measurePhotoTones(posts, images, classifications) {
  const photoIds = new Set((classifications || []).filter((c) => PHOTO_TYPES.includes(c.image_type)).map((c) => c.post_id));
  const perPost = [];
  for (const post of posts) {
    const img = images[post.post_id];
    if (!img || !img.ok || !photoIds.has(post.post_id)) continue;
    const tone = await measureTone(Buffer.from(img.base64, 'base64'));
    if (tone) perPost.push({ post_id: post.post_id, ...tone });
  }
  const axes = {};
  for (const axis of ['warmth_tone', 'brightness', 'saturation_level']) {
    const counts = {};
    for (const p of perPost) counts[p[axis]] = (counts[p[axis]] || 0) + 1;
    const [value, count] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0] || [null, 0];
    axes[axis] = { value, share: perPost.length ? count / perPost.length : 0 };
  }
  return { perPost, axes, photosMeasured: perPost.length };
}

/**
 * The photo mood handed to content generation: what the account's photos look like, for
 * generating or choosing images - kept apart from brand colors. A tone is stated only when
 * 6+ photos were measured and 60%+ of them agree; recurring hues only when they show up in
 * half the photos; the model's style phrase only at high/medium with 3+ supporting photos.
 */
function summarizePhotoMood({ photoTones, photographyModeColors, photoStyle }) {
  const photos = (photoTones && photoTones.photosMeasured) || 0;
  if (photos < MIN_MOOD_PHOTOS) {
    return { status: 'not_confirmed', photos_measured: photos, reason: `only ${photos} photo(s) measured - at least ${MIN_MOOD_PHOTOS} are needed to describe a consistent look` };
  }
  const tones = {};
  for (const [axis, key] of [['warmth_tone', 'warmth'], ['brightness', 'brightness'], ['saturation_level', 'saturation']]) {
    const a = photoTones.axes[axis];
    if (a && a.value && a.share >= MOOD_CONSISTENCY) tones[key] = a.value;
  }
  const recurring = ((photographyModeColors && photographyModeColors.aggregated) || [])
    .filter((c) => c.posts >= Math.ceil(photos / 2))
    .slice(0, 3)
    .map((c) => ({ color: c.color, family: c.family || colorFamily(c.color), posts: c.posts }));
  const styleIds = new Set((photoStyle && photoStyle.supporting_post_ids) || []);
  const style = photoStyle && photoStyle.description && ['high', 'medium'].includes(photoStyle.confidence) && styleIds.size >= 3
    ? photoStyle.description
    : null;
  if (!Object.keys(tones).length && !style) {
    return { status: 'not_confirmed', photos_measured: photos, reason: 'the photos vary too much to describe one consistent look' };
  }
  return {
    status: 'confirmed',
    photos_measured: photos,
    tones,
    ...(recurring.length ? { recurring_colors: recurring } : {}),
    ...(style ? { style } : {}),
  };
}

/**
 * Brand colors come from designed graphics only. A photo with text laid over it is a photo: its
 * overlay text is too thin to measure apart from a photo subject of the same color (red script
 * over red roses), so it feeds the photo mood instead.
 */
function extractDesignedPostColors(posts, images, classifications) {
  return aggregatePostColorsByType(posts, images, classifications, ['graphic_designed']);
}

/** Same mechanism, but for the photography_mood_colors fallback - explicitly not a brand palette. */
function extractPhotographyModeColors(posts, images, classifications) {
  return aggregatePostColorsByType(posts, images, classifications, PHOTO_TYPES, { designColorsApply: false });
}

// ---------- per-field merge logic ----------

function mergeContentPillars(social) {
  return social.content_pillars || { items: [], evidence: [], confidence: 'none' };
}

function mergeHashtagStrategy(social) {
  return social.hashtag_strategy || { pattern_description: '', frequently_used: [], confidence: 'none', evidence: [] };
}

function mergeVoiceAndTone({ social, website, minPostThreshold }) {
  const postsAnalyzed = social.posts_analyzed || 0;
  const socialVoice = social.voice_and_tone || {};

  if (postsAnalyzed >= minPostThreshold && socialVoice.confidence && socialVoice.confidence !== 'none') {
    return {
      description: socialVoice.description || null,
      confidence: socialVoice.confidence,
      evidence: socialVoice.evidence || [],
      source: 'social',
    };
  }

  const websiteVoice = website && website.voice_and_tone_from_copy;
  if (websiteVoice && websiteVoice.description && websiteVoice.confidence && websiteVoice.confidence !== 'none') {
    return {
      description: websiteVoice.description,
      confidence: websiteVoice.confidence,
      evidence: websiteVoice.evidence || [],
      source: 'website_fallback_tentative',
    };
  }

  // Below the threshold with no website to fall back on: a thin social reading still beats
  // nothing, so keep it but cap its confidence and flag the small sample.
  if (socialVoice.description && socialVoice.confidence && socialVoice.confidence !== 'none') {
    return {
      description: socialVoice.description,
      confidence: 'low',
      evidence: socialVoice.evidence || [],
      source: 'social',
      low_sample: true,
    };
  }

  return {
    description: socialVoice.description || null,
    confidence: 'none',
    evidence: socialVoice.evidence || [],
    source: 'none',
  };
}

// Several signal types inside ONE post (a caption mention plus a hashtag) are still one post.
// When extraction lists supporting_post_ids, fewer than 2 distinct posts caps confidence at low.
function capBySupportingPosts(socialLoc) {
  const confidence = socialLoc.confidence || 'none';
  if (!Array.isArray(socialLoc.supporting_post_ids)) return confidence;
  const distinctPosts = new Set(socialLoc.supporting_post_ids).size;
  return distinctPosts < 2 && ['high', 'medium'].includes(confidence) ? 'low' : confidence;
}

const CONFIDENCE_ORDER = ['none', 'low', 'medium', 'high'];
const rank = (c) => Math.max(0, CONFIDENCE_ORDER.indexOf(c || 'none'));
const isConfident = (c) => rank(c) >= rank('medium');

/**
 * Brand name: account_info is ground truth; otherwise the posts' reading, capped at low
 * unless it's seen in 2+ distinct posts - one sign-off or one mention isn't enough to
 * print a name as fact. The website's name is used when the posts have no confident one.
 */
function mergeBrandName({ accountInfo, social, website }) {
  const given = accountInfo && (accountInfo.brand_name || accountInfo.name);
  if (given) return { value: given, confidence: 'high', source: 'account_info' };
  const signal = (social && social.brand_name) || {};
  const fromPosts = signal.value
    ? { value: signal.value, confidence: capBySupportingPosts(signal), source: 'social', supporting_post_ids: signal.supporting_post_ids || [], evidence: signal.evidence || [] }
    : null;
  const site = website && website.brand_name;
  const fromSite = site && site.value ? { value: site.value, confidence: site.confidence || 'none', source: 'website', evidence: site.evidence || [] } : null;

  if (fromPosts && fromSite && fromPosts.value.toLowerCase() === fromSite.value.toLowerCase()) {
    return { ...fromPosts, confidence: 'high', source: 'social+website' };
  }
  if (fromPosts && isConfident(fromPosts.confidence)) return fromPosts;
  if (fromSite && isConfident(fromSite.confidence)) return fromSite;
  return fromPosts || fromSite || { value: null, confidence: 'none', source: null };
}

/**
 * What the business is, what it offers and who it's for. A homepage usually says what
 * the business is outright, so on a confidence tie the website's category wins; offerings
 * are combined (the posts show what's current, the site what's permanent).
 */
function mergeBusinessProfile({ social, website }) {
  const s = (social && social.business_profile) || null;
  const fromPosts = s && s.what_it_is ? { ...s, confidence: capBySupportingPosts(s) } : null;
  const w = (website && website.business_profile_from_copy) || null;
  const fromSite = w && w.what_it_is ? w : null;
  if (!fromPosts && !fromSite) {
    return { what_it_is: null, offerings: [], audience: null, audience_confidence: 'none', confidence: 'none', source: null, evidence: [] };
  }

  const primary = !fromSite || (fromPosts && rank(fromPosts.confidence) > rank(fromSite.confidence)) ? fromPosts : fromSite;
  const seen = new Set();
  const offerings = [...((fromPosts && fromPosts.offerings) || []), ...((fromSite && fromSite.offerings) || [])]
    .filter((o) => o && !seen.has(o.toLowerCase()) && seen.add(o.toLowerCase()))
    .slice(0, 6);
  const audiences = [fromPosts, fromSite]
    .filter((x) => x && x.audience)
    .sort((a, b) => rank(b.audience_confidence) - rank(a.audience_confidence));

  return {
    what_it_is: primary.what_it_is,
    offerings,
    audience: audiences.length ? audiences[0].audience : null,
    audience_confidence: audiences.length ? audiences[0].audience_confidence || 'low' : 'none',
    confidence: fromPosts && fromSite ? CONFIDENCE_ORDER[Math.max(rank(fromPosts.confidence), rank(fromSite.confidence))] : primary.confidence || 'none',
    source: fromPosts && fromSite ? 'social+website' : fromPosts ? 'social' : 'website',
    supporting_post_ids: (fromPosts && fromPosts.supporting_post_ids) || [],
    evidence: [...((fromPosts && fromPosts.evidence) || []), ...((fromSite && fromSite.evidence) || []).map((e) => `[website] ${e}`)],
  };
}

function scoreWebsiteLocation(locationSignal, weights) {
  if (!locationSignal || !locationSignal.guessed_locality) return 0;
  const base = weights.provenance_weights[locationSignal.provenance] || 0;
  const isStale = !!(locationSignal.staleness_signal && locationSignal.staleness_signal.is_stale);
  return isStale ? base * weights.staleness_penalty : base;
}

function scoreSocialLocation(locationSignal, weights) {
  if (!locationSignal || !locationSignal.guessed_locality) return 0;
  return weights.corroboration_weights[locationSignal.corroboration] || 0;
}

function mergeLocation({ accountInfo, social, website, weights }) {
  if (accountInfo && accountInfo.address) {
    return {
      result: {
        value: accountInfo.address,
        confidence: 'high',
        source: 'account_info_address',
        basis: 'ground_truth',
        social_score: null,
        website_score: null,
      },
      conflicts: [],
    };
  }

  const socialLoc = social.location_signal || {};
  const websiteLoc = (website && website.location_signal) || null;

  const socialScore = scoreSocialLocation(socialLoc, weights);
  const websiteScore = websiteLoc ? scoreWebsiteLocation(websiteLoc, weights) : 0;

  const hasSocialGuess = !!socialLoc.guessed_locality;
  const hasWebsiteGuess = !!(websiteLoc && websiteLoc.guessed_locality);

  // "Dormansland" and "Dormansland, Surrey, United Kingdom" are the same place at two levels of detail
  const sameLocality = (a, b) => {
    const x = a.toLowerCase().trim();
    const y = b.toLowerCase().trim();
    return x === y || x.startsWith(y) || y.startsWith(x);
  };
  const agree = hasSocialGuess && hasWebsiteGuess && sameLocality(socialLoc.guessed_locality, websiteLoc.guessed_locality);
  const isRealDisagreement = hasSocialGuess && hasWebsiteGuess && !agree;

  let winner;
  if (!hasSocialGuess && !hasWebsiteGuess) winner = 'none';
  else if (!hasWebsiteGuess) winner = 'social';
  else if (!hasSocialGuess) winner = 'website';
  else if (websiteScore > socialScore) winner = 'website';
  else if (socialScore > websiteScore) winner = 'social';
  else winner = weights.tie_break_winner || 'social';

  // validation only sees the merged guideline, so the evidence has to travel with it
  const socialEvidence = { signals: socialLoc.signals || [], supporting_post_ids: socialLoc.supporting_post_ids || [] };

  let result;
  if (agree) {
    // posts and website independently name the same place: that is corroboration in itself
    result = {
      value: socialLoc.guessed_locality,
      confidence: CONFIDENCE_ORDER[Math.max(rank(capBySupportingPosts(socialLoc)), rank(websiteLoc.confidence), rank('medium'))],
      source: 'social+website',
      basis: 'social_and_website_agree',
      website_value: websiteLoc.guessed_locality,
      ...socialEvidence,
      social_score: socialScore,
      website_score: websiteScore,
    };
  } else if (winner === 'social') {
    result = {
      value: socialLoc.guessed_locality,
      confidence: capBySupportingPosts(socialLoc),
      source: 'social',
      basis: 'corroboration_score',
      ...socialEvidence,
      social_score: socialScore,
      website_score: websiteScore,
    };
  } else if (winner === 'website') {
    result = {
      value: websiteLoc.guessed_locality,
      confidence: websiteLoc.confidence || 'none',
      source: 'website',
      basis: 'provenance_recency_score',
      social_score: socialScore,
      website_score: websiteScore,
    };
  } else {
    result = { value: null, confidence: 'none', source: 'none', basis: 'no_signal', social_score: socialScore, website_score: websiteScore };
  }

  const conflicts = isRealDisagreement
    ? [{
        field: 'location',
        description: `social guessed "${socialLoc.guessed_locality}" (score ${socialScore}) vs website guessed "${websiteLoc.guessed_locality}" (score ${websiteScore}) - resolved to ${winner}`,
        social_score: socialScore,
        website_score: websiteScore,
        resolution: winner,
      }]
    : [];

  return { result, conflicts };
}

// Confidence comes from how much evidence there is (designed posts measured, and whether the
// top color recurs across them), not from how many colors came out - one image yields 5.
function designedPostsConfidence(designedPostColors) {
  const postsUsed = designedPostColors.postsUsed || 0;
  const topRecurrence = ((designedPostColors.aggregated || [])[0] || {}).posts || 0;
  if (postsUsed >= 5 && topRecurrence >= 3) return 'medium';
  if (postsUsed >= 2) return 'low';
  return 'none';
}

// A low/none-confidence palette is not a verdict: keep the measured colors for inspection
// under unconfirmed_colors, but never present them as hex_colors (the brand palette).
function withoutUnconfirmedColors(palette) {
  if (['high', 'medium'].includes(palette.confidence) || !(palette.hex_colors || []).length) return palette;
  return { ...palette, hex_colors: [], unconfirmed_colors: palette.hex_colors };
}

function mergeColorPalette({ website, designedPostColors, photographyModeColors, minDistinctCssColors = 3 }) {
  const cssColors = (website && website.cssColors) || [];
  const cssHexes = limitPerFamily(cssColors.map((c) => c.color)).slice(0, 6);
  const designedHexes = limitPerFamily((designedPostColors.aggregated || []).map((c) => c.color)).slice(0, 6);

  const hasCss = cssColors.length > 0;
  const cssSparse = hasCss && cssColors.length < minDistinctCssColors;
  const hasDesigned = designedHexes.length > 0;

  if (hasCss && hasDesigned) {
    if (palettesOverlap(cssHexes, designedHexes)) {
      return {
        result: {
          hex_colors: mergeShades([...cssHexes, ...designedHexes].map((color) => ({ color, count: 1 }))).map((c) => c.color).slice(0, 8),
          confidence: cssSparse ? 'medium' : 'high',
          basis: 'website_css+designed_posts_corroborated',
        },
        conflicts: [],
      };
    }

    const websiteStale = !!(
      website.location_signal &&
      website.location_signal.staleness_signal &&
      website.location_signal.staleness_signal.is_stale
    );
    const preferDesigned = websiteStale || cssSparse;
    return {
      result: {
        hex_colors: preferDesigned ? designedHexes : cssHexes,
        confidence: 'medium',
        basis: preferDesigned ? 'designed_posts_preferred_recency' : 'website_css_preferred_freshness',
      },
      conflicts: [{
        field: 'color_palette',
        description: `website CSS colors [${cssHexes.join(', ')}] conflict with designed-post colors [${designedHexes.join(', ')}] - resolved to ${preferDesigned ? 'designed_posts' : 'website_css'}`,
        resolution: preferDesigned ? 'designed_posts' : 'website_css',
      }],
    };
  }

  if (hasCss) {
    return {
      result: { hex_colors: cssHexes, confidence: cssSparse ? 'low' : 'medium', basis: 'website_css_only' },
      conflicts: [],
    };
  }

  if (hasDesigned) {
    return {
      result: { hex_colors: designedHexes, confidence: designedPostsConfidence(designedPostColors), basis: 'designed_posts_only' },
      conflicts: [],
    };
  }

  const photographyHexes = (photographyModeColors && photographyModeColors.aggregated || []).slice(0, 6).map((c) => c.color);
  if (photographyHexes.length > 0) {
    return {
      result: { hex_colors: [], confidence: 'none', basis: 'photography_only_not_a_confirmed_palette', photography_mood_colors: photographyHexes },
      conflicts: [],
    };
  }

  return { result: { hex_colors: [], confidence: 'none', basis: 'no_usable_signal' }, conflicts: [] };
}

/**
 * Dispatches each of the 5 guideline fields to its own merge mechanism, rather
 * than one uniform confidence x domain-weight score - see the per-field
 * mechanisms above. Returns { guideline, meta } where meta.conflicts logs every
 * real cross-source disagreement (not every merge decision - agreement isn't a
 * conflict).
 */
function mergeGuidelines({ accountInfo, social, website, designedPostColors, photographyModeColors, weights, minPostThreshold }) {
  const conflicts = [];

  const voiceAndTone = mergeVoiceAndTone({ social, website, minPostThreshold });

  const { result: location, conflicts: locationConflicts } = mergeLocation({ accountInfo, social, website, weights });
  conflicts.push(...locationConflicts);

  const { result: colorPalette, conflicts: colorConflicts } = mergeColorPalette({
    website,
    designedPostColors: designedPostColors || { aggregated: [] },
    photographyModeColors: photographyModeColors || { aggregated: [] },
  });
  conflicts.push(...colorConflicts);

  const guideline = {
    brand_name: mergeBrandName({ accountInfo, social, website }),
    business_profile: mergeBusinessProfile({ social, website }),
    content_pillars: mergeContentPillars(social),
    voice_and_tone: voiceAndTone,
    hashtag_strategy: mergeHashtagStrategy(social),
    location,
    color_palette: withoutUnconfirmedColors(colorPalette),
  };

  return {
    guideline,
    meta: {
      posts_analyzed: social.posts_analyzed || 0,
      website_used: !!website,
      conflicts,
    },
  };
}

module.exports = {
  mergeBrandName,
  mergeBusinessProfile,
  extractWebsiteCssColors,
  isNeutralColor,
  colorFamily,
  measurePhotoTones,
  summarizePhotoMood,
  fetchWebsiteContent,
  quantizeImageColors,
  extractDesignedPostColors,
  extractPhotographyModeColors,
  mergeGuidelines,
  palettesOverlap,
};

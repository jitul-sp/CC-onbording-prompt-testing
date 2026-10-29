const fs = require('fs/promises');
const path = require('path');
const sharp = require('sharp');

const {
  fetchWebsiteContent,
  extractDesignedPostColors,
  extractPhotographyModeColors,
  measurePhotoTones,
  mergeGuidelines,
} = require('./websiteMergePipeline');

const MIN_POST_THRESHOLD = 10;
const MAX_TOKENS = 16000;

/**
 * Shape reference for the social extraction output. The prompt text lives in
 * prompts/extraction.system.md; this mirrors it so the schema has one canonical
 * source in code.
 */
const EXTRACTION_SYSTEM_PROMPT_SCHEMA = {
  content_pillars: { items: 'string[]', evidence: 'string[]', confidence: 'high|medium|low|none' },
  voice_and_tone: { description: 'string', confidence: 'high|medium|low|none', evidence: 'string[]' },
  hashtag_strategy: { pattern_description: 'string', frequently_used: 'string[]', confidence: 'high|medium|low|none', evidence: 'string[]' },
  location_signal: {
    guessed_locality: 'string|null',
    corroboration: 'corroborated_2plus|single_mention|none',
    signal_types: 'string[]',
    signals: 'string[]',
    supporting_post_ids: 'string[]',
    confidence: 'high|medium|low|none',
  },
  brand_name: {
    value: 'string|null',
    signal_types: 'string[]',
    evidence: 'string[]',
    supporting_post_ids: 'string[]',
    confidence: 'high|medium|low|none',
  },
  business_profile: {
    what_it_is: 'string|null',
    offerings: 'string[]',
    audience: 'string|null',
    audience_confidence: 'high|medium|low|none',
    evidence: 'string[]',
    supporting_post_ids: 'string[]',
    confidence: 'high|medium|low|none',
  },
  post_image_classifications: [{
    post_id: 'string',
    image_type: 'photographic|photo_with_overlay|graphic_designed|no_image',
    owner: 'own|third_party|unclear (graphics only)',
    design_colors: [{ family: 'red|orange|yellow|green|teal|blue|navy|purple|pink|brown|beige|black|white|grey', role: 'headline|text|logo|background|accent' }],
  }],
  photo_style: { description: 'string|null', supporting_post_ids: 'string[]', confidence: 'high|medium|low|none' },
  cross_post_groups: [{ post_ids: 'string[]', basis: 'identical_caption|near_identical_caption|same_media|same_media_and_caption' }],
  content_language: 'string (ISO 639-1)',
  posts_received: 'number',
  posts_analyzed: 'number (distinct posts after grouping cross-posts)',
  confidence_notes: 'string',
};
// ---------- image pipeline (unchanged mechanism: fetch, normalize via sharp, base64) ----------

// Total budget for all images in one request: the Messages API caps a request at 32 MB,
// and base64 inflates bytes by ~4/3, so keep the raw JPEGs well under that.
const TOTAL_IMAGE_BYTES_BUDGET = 18_000_000;
const MAX_IMAGE_BYTES = 1_000_000;
const IMAGE_FETCH_CONCURRENCY = 6;

// Node's fetch reports every network error as "fetch failed"; the real reason
// (DNS, connection reset, timeout...) is on err.cause.
function describeFetchError(err) {
  if (err.name === 'AbortError') return 'timed out after 10s';
  const cause = err.cause;
  if (!cause) return err.message;
  return `${err.message}: ${cause.code || cause.message}${cause.hostname ? ` (${cause.hostname})` : ''}`;
}

async function fetchImageBuffer(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}`, retryable: res.status >= 500 };
    return { ok: true, buf: Buffer.from(await res.arrayBuffer()) };
  } catch (err) {
    return { ok: false, error: describeFetchError(err), retryable: true };
  } finally {
    clearTimeout(timer);
  }
}

async function fetchAndResizeImage(url, { debug = false, runId = null, postId = null, debugDir = null, maxBytes = MAX_IMAGE_BYTES } = {}) {
  try {
    // one retry for transient network errors (Wi-Fi/VPN blips, S3 resets)
    let fetched = await fetchImageBuffer(url);
    if (!fetched.ok && fetched.retryable) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      fetched = await fetchImageBuffer(url);
    }
    if (!fetched.ok) return { ok: false, error: fetched.error };

    const buf = fetched.buf;
    const probe = sharp(buf).rotate();
    const metadata = await probe.metadata();
    const longestEdge = Math.max(metadata.width || 0, metadata.height || 0);
    // smaller per-image budgets (many posts in one request) also get a smaller max edge
    // 1024px is enough to read on-image text and classify the image; image tokens scale with
    // pixel area, so this is ~40% cheaper per image than the API's 1568px sweet spot
    const maxEdge = 1024;

    let quality = 85;
    let outBuf;
    for (;;) {
      let pipeline = sharp(buf).rotate();
      if (longestEdge > maxEdge) {
        pipeline = pipeline.resize({ width: maxEdge, height: maxEdge, fit: 'inside', withoutEnlargement: true });
      }
      outBuf = await pipeline.jpeg({ quality }).toBuffer();
      if (outBuf.length <= maxBytes || quality <= 40) break;
      quality -= 10;
    }

    if (debug && runId && postId && debugDir) {
      const dir = path.join(debugDir, runId);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, `${postId}.jpg`), outBuf);
    }

    return { ok: true, base64: outBuf.toString('base64'), mediaType: 'image/jpeg' };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function fetchImagesForPosts(posts, opts) {
  const images = {};
  let fetched = 0;
  let failed = 0;
  const imageCount = posts.filter((p) => p.image_url).length;
  const maxBytes = Math.min(MAX_IMAGE_BYTES, Math.floor(TOTAL_IMAGE_BYTES_BUDGET / Math.max(1, imageCount)));
  const queue = posts.filter((p) => p.image_url);
  const worker = async () => {
    for (let post = queue.shift(); post; post = queue.shift()) {
      const result = await fetchAndResizeImage(post.image_url, { ...opts, postId: post.post_id, maxBytes });
      images[post.post_id] = result;
      if (result.ok) fetched += 1;
      else failed += 1;
    }
  };
  await Promise.all(Array.from({ length: IMAGE_FETCH_CONCURRENCY }, worker));
  return { images, fetched, failed };
}

// ---------- Anthropic call ----------

// Current models think adaptively and reject sampling params (effort etc. 400 since
// 2026-10-21). Thinking can't be capped directly - effort is the only depth control - so
// max_tokens must leave room for thinking plus the full JSON answer.
const EFFORT_LEVELS = ['low', 'medium', 'high'];

async function callAnthropic({ apiKey, model, effort, system, messages }) {
  const body = JSON.stringify({
    model,
    max_tokens: MAX_TOKENS,
    ...(EFFORT_LEVELS.includes(effort) ? { output_config: { effort } } : {}),
    system,
    messages,
  });

  const attempt = async () => {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body,
    });
    let json = null;
    try {
      json = await res.json();
    } catch {
      // leave json null
    }
    if (!res.ok) {
      const message = (json && json.error && json.error.message) || `Anthropic API error (HTTP ${res.status})`;
      const err = new Error(message);
      err.status = res.status;
      err.retryable = res.status >= 500;
      throw err;
    }
    return json;
  };

  let response;
  try {
    response = await attempt();
  } catch (err) {
    if (!err.retryable) throw err;
    response = await attempt();
  }

  if (response.stop_reason === 'max_tokens') {
    const thinking = response.usage && response.usage.output_tokens_details && response.usage.output_tokens_details.thinking_tokens;
    const err = new Error(
      `Model hit the ${MAX_TOKENS}-token output limit before finishing` +
        (thinking ? ` (${thinking} of those tokens were thinking)` : '') +
        ' - read fewer posts or lower the effort.'
    );
    err.status = 422;
    throw err;
  }
  if (response.stop_reason === 'refusal') {
    const category = response.stop_details && response.stop_details.category;
    const err = new Error(`Model declined the request${category ? ` (category: ${category})` : ''}.`);
    err.status = 422;
    throw err;
  }
  return response;
}

function extractText(anthropicResponse) {
  if (!anthropicResponse || !Array.isArray(anthropicResponse.content)) return '';
  return anthropicResponse.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
}

function tryParseJson(text) {
  if (!text) return null;
  let t = text.trim();
  const fence = t.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fence) t = fence[1].trim();
  try {
    return JSON.parse(t);
  } catch {
    return null;
  }
}

// ---------- placeholder resolution ----------

function substituteSimple(text, map) {
  let out = text;
  for (const [key, value] of Object.entries(map)) {
    out = out.split(`{{${key}}}`).join(value);
  }
  return out;
}

function resolveAccountInfoJson(accountInfo) {
  if (!accountInfo || Object.keys(accountInfo).length === 0) return 'none provided';
  return JSON.stringify(accountInfo, null, 2);
}

// optional fields that CSV-sourced posts carry (JSON seed files usually don't)
function postExtraLines(post) {
  const lines = [];
  if (post.platform) lines.push(`Platform: ${post.platform}`);
  if (post.media_type === 'video') lines.push('Media: video (thumbnail frame shown)');
  if (post.tagged_place) lines.push(`Tagged place: ${post.tagged_place}`);
  if (post.links && post.links.length) lines.push(`Links: ${post.links.join(' ')}`);
  return lines;
}

function buildPostsTextBlock(posts, images) {
  const lines = [];
  for (const post of posts) {
    lines.push(`--- Post ${post.post_id} ---`);
    if (post.date) lines.push(`Date: ${post.date}`);
    lines.push(`Caption: ${post.caption_text || '(none)'}`);
    lines.push(`Hashtags: ${(post.hashtags || []).join(' ') || '(none)'}`);
    for (const line of postExtraLines(post)) lines.push(line);
    const img = images[post.post_id];
    if (post.image_url && img && !img.ok) lines.push(`Image: fetch failed (${img.error}) - proceeding caption-only for this post.`);
    else if (post.image_url && img && img.ok) lines.push('Image: attached below.');
    lines.push('');
  }
  return lines.join('\n');
}

function buildPostsContentBlocks(posts, images) {
  const blocks = [];
  for (const post of posts) {
    let header = `--- Post ${post.post_id} ---\n`;
    if (post.date) header += `Date: ${post.date}\n`;
    header += `Caption: ${post.caption_text || '(none)'}\n`;
    header += `Hashtags: ${(post.hashtags || []).join(' ') || '(none)'}\n`;
    for (const line of postExtraLines(post)) header += `${line}\n`;
    const img = images[post.post_id];
    if (post.image_url && img && !img.ok) header += `Image: fetch failed (${img.error}) - proceeding caption-only for this post.\n`;
    else if (post.image_url && img && img.ok) header += 'Image: attached below.\n';
    blocks.push({ type: 'text', text: header });
    if (post.image_url && img && img.ok) {
      blocks.push({ type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.base64 } });
    }
  }
  return blocks;
}

// ---------- stage runners ----------

async function runExtractionStage({ postData, promptVersion, model, effort, apiKey, debug, runId, debugDir }) {
  const posts = postData.posts || [];
  const { images, fetched, failed } = await fetchImagesForPosts(posts, { debug, runId, debugDir });

  const simpleMap = {
    MIN_POST_THRESHOLD: String(MIN_POST_THRESHOLD),
    ACCOUNT_INFO_JSON: resolveAccountInfoJson(postData.account_info),
    POST_COUNT: String(posts.length),
  };

  const system = substituteSimple(promptVersion.system_prompt, simpleMap);
  const templateAfterSimple = substituteSimple(promptVersion.user_template, simpleMap);

  let content;
  let userTextForLog;
  if (templateAfterSimple.includes('{{POSTS_BLOCK}}')) {
    const [before, after] = templateAfterSimple.split('{{POSTS_BLOCK}}');
    content = [{ type: 'text', text: before }, ...buildPostsContentBlocks(posts, images), { type: 'text', text: after }];
    userTextForLog = before + buildPostsTextBlock(posts, images) + after;
  } else {
    content = [{ type: 'text', text: templateAfterSimple }];
    userTextForLog = templateAfterSimple;
  }

  const start = Date.now();
  const response = await callAnthropic({ apiKey, model, effort, system, messages: [{ role: 'user', content }] });
  const latencyMs = Date.now() - start;

  const outputRaw = extractText(response);
  const outputParsed = tryParseJson(outputRaw);

  return {
    system_prompt: system,
    user_text: userTextForLog,
    outputRaw,
    outputParsed,
    usage: response.usage || null,
    latencyMs,
    images,
    imagesFetched: fetched,
    imagesFailed: failed,
    imageNotes: Object.entries(images).filter(([, v]) => !v.ok).map(([postId, v]) => ({ post_id: postId, error: v.error })),
  };
}

async function runWebsiteExtractionStage({ websiteUrl, promptVersion, model, effort, apiKey }) {
  const fetchResult = await fetchWebsiteContent(websiteUrl);
  // no page means nothing to read - don't pay for a model call that can only return "none"
  if (!fetchResult.ok) {
    return { system_prompt: null, user_text: null, outputRaw: null, outputParsed: null, usage: null, latencyMs: 0, fetchResult };
  }
  const cssColors = fetchResult.cssColors;

  const simpleMap = {
    WEBSITE_FETCH_STATUS: fetchResult.ok
      ? `ok (stylesheets fetched: ${fetchResult.stylesheetsFetched}, failed: ${fetchResult.stylesheetsFailed})`
      : `failed - ${fetchResult.error} - proceed with no page content.`,
    WEBSITE_PAGE_TEXT: fetchResult.ok ? fetchResult.pageText : '(no page content - website fetch failed)',
    WEBSITE_CSS_COLORS_JSON: JSON.stringify(cssColors, null, 2),
  };

  const system = substituteSimple(promptVersion.system_prompt, simpleMap);
  const userText = substituteSimple(promptVersion.user_template, simpleMap);

  const start = Date.now();
  const response = await callAnthropic({ apiKey, model, effort, system, messages: [{ role: 'user', content: [{ type: 'text', text: userText }] }] });
  const latencyMs = Date.now() - start;

  const outputRaw = extractText(response);
  const outputParsed = tryParseJson(outputRaw);

  return { system_prompt: system, user_text: userText, outputRaw, outputParsed, usage: response.usage || null, latencyMs, fetchResult };
}

async function runValidationStage({ postData, promptVersion, model, effort, apiKey, mergedGuideline, socialVoiceAndTone, websitePageText, postsAnalyzed }) {
  const posts = postData.posts || [];
  const simpleMap = {
    ACCOUNT_INFO_JSON: resolveAccountInfoJson(postData.account_info),
    // captions only - validation can't see images, so URLs would just be wasted tokens
    POSTS_JSON: JSON.stringify(posts.map(({ image_url, account_id, ...rest }) => ({ ...rest, had_image: !!image_url })), null, 2),
    WEBSITE_TEXT_EXCERPT: websitePageText || '(no website content fetched)',
    SOCIAL_VOICE_AND_TONE_JSON: JSON.stringify(socialVoiceAndTone || null, null, 2),
    POSTS_ANALYZED: String(postsAnalyzed || 0),
    MIN_POST_THRESHOLD: String(MIN_POST_THRESHOLD),
    MERGED_GUIDELINE_JSON: JSON.stringify(mergedGuideline, null, 2),
  };

  const system = substituteSimple(promptVersion.system_prompt, simpleMap);
  const userText = substituteSimple(promptVersion.user_template, simpleMap);

  const start = Date.now();
  const response = await callAnthropic({ apiKey, model, effort, system, messages: [{ role: 'user', content: [{ type: 'text', text: userText }] }] });
  const latencyMs = Date.now() - start;

  const outputRaw = extractText(response);
  const outputParsed = tryParseJson(outputRaw);

  return { system_prompt: system, user_text: userText, outputRaw, outputParsed, usage: response.usage || null, latencyMs };
}

function resolveLocationForCompose(guideline) {
  if (!guideline || !guideline.location) return null;
  // a low-confidence guess stated as fact in the paragraph is worse than no location
  if (!['high', 'medium'].includes(guideline.location.confidence) || !guideline.location.value) return null;
  return guideline.location.value;
}

const CONFIDENT = ['high', 'medium'];
const MIN_POSTS_FOR_SPECIFIC_DETAIL = 6;

/**
 * Decides in code - not in the prompt - what compose may state. Colors and location never
 * go in (location is passed separately, already gated). Each remaining field is tagged by
 * its confidence: high/medium -> "specific", low -> "general" (broad terms only), none ->
 * dropped. Evidence quotes are dropped too: compose doesn't need them, and they are where
 * caption specifics and image details could leak into a paragraph that should stay general.
 * The whole paragraph is "general" when the sample is small or content/voice aren't confident.
 */
function buildComposeBrief(guideline, postsAnalyzed) {
  const brief = {};
  const usage = (field) => (field && CONFIDENT.includes(field.confidence) ? 'specific' : field && field.confidence === 'low' ? 'general' : null);

  // brand name and location are facts, not style: they're stated only when confident and,
  // unlike other names, kept even in a general paragraph
  const brandName = guideline.brand_name;
  if (brandName && CONFIDENT.includes(brandName.confidence) && brandName.value) brief.brand_name = brandName.value;
  const location = resolveLocationForCompose(guideline);
  if (location) brief.location = location;

  // what the business is and sells is also a fact: confident or withheld, never guessed
  const profile = guideline.business_profile;
  if (profile && CONFIDENT.includes(profile.confidence) && profile.what_it_is) {
    brief.business_profile = { what_it_is: profile.what_it_is };
    if ((profile.offerings || []).length) brief.business_profile.offerings = profile.offerings;
    if (profile.audience && CONFIDENT.includes(profile.audience_confidence)) brief.business_profile.audience = profile.audience;
  }

  const pillars = guideline.content_pillars;
  if (usage(pillars)) brief.content_pillars = { items: pillars.items || [], use: usage(pillars) };

  const voice = guideline.voice_and_tone;
  if (usage(voice) && voice.description) {
    brief.voice_and_tone = { description: voice.description, use: usage(voice) };
    if (voice.source === 'website_fallback_tentative') brief.voice_and_tone.source = voice.source;
  }

  // hashtags are only worth mentioning as a confirmed habit
  const tags = guideline.hashtag_strategy;
  if (tags && CONFIDENT.includes(tags.confidence)) {
    brief.hashtag_strategy = { pattern_description: tags.pattern_description, frequently_used: tags.frequently_used || [] };
  }

  const sparse =
    (postsAnalyzed || 0) < MIN_POSTS_FOR_SPECIFIC_DETAIL ||
    !brief.content_pillars || brief.content_pillars.use !== 'specific' ||
    !brief.voice_and_tone || brief.voice_and_tone.use !== 'specific' || !!(voice && voice.low_sample);
  return { brief, detailLevel: sparse ? 'general' : 'specific' };
}

/**
 * The same brief, re-keyed around the brand instead of its social feed. The extraction
 * fields are named after what the account posts ("content_pillars", "hashtag_strategy");
 * handed to compose under those names, the paragraph comes out as a report on the posts
 * ("its posts highlight..."). Compose v7+ reads this via {{BRAND_BRIEF_JSON}}.
 */
function toBrandBrief(brief, detailLevel) {
  const out = {};
  if (brief.brand_name) out.brand_name = brief.brand_name;
  if (brief.business_profile) {
    out.what_it_is = brief.business_profile.what_it_is;
    // offerings carry concrete names and prices; in a general paragraph they may only be
    // used as broad categories, so they get the same "use" flag as known_for
    if (brief.business_profile.offerings) {
      out.offers = { items: brief.business_profile.offerings, use: detailLevel === 'general' ? 'general' : 'specific' };
    }
    if (brief.business_profile.audience) out.serves = brief.business_profile.audience;
  }
  if (brief.location) out.location = brief.location;
  if (brief.content_pillars) out.known_for = brief.content_pillars;
  if (brief.voice_and_tone) out.voice = brief.voice_and_tone;
  if (brief.hashtag_strategy) {
    // "#allemagne (18 of 20 posts)" -> "#allemagne": the counts are feed statistics, not brand
    const tags = (brief.hashtag_strategy.frequently_used || [])
      .map((t) => (String(t).match(/#[\p{L}\p{N}_]+/u) || [])[0])
      .filter(Boolean);
    if (tags.length) out.signature_hashtags = [...new Set(tags)].slice(0, 5);
  }
  return out;
}

async function runComposeStage({ postData, promptVersion, model, effort, apiKey, validatedGuideline, contentLanguage, postsAnalyzed }) {
  const resolvedLocation = resolveLocationForCompose(validatedGuideline);
  const { brief, detailLevel } = buildComposeBrief(validatedGuideline, postsAnalyzed);
  const simpleMap = {
    COMPOSE_BRIEF_JSON: JSON.stringify(brief, null, 2),
    BRAND_BRIEF_JSON: JSON.stringify(toBrandBrief(brief, detailLevel), null, 2),
    DETAIL_LEVEL: detailLevel,
    CONTENT_LANGUAGE: contentLanguage || 'unknown - use English',
    ACCOUNT_INFO_JSON: resolveAccountInfoJson(postData.account_info),
    VALIDATED_GUIDELINE_JSON: JSON.stringify(validatedGuideline, null, 2),
    RESOLVED_LOCATION: resolvedLocation === null ? 'null' : resolvedLocation,
    BRAND_NAME: brief.brand_name || 'null',
  };

  const system = substituteSimple(promptVersion.system_prompt, simpleMap);
  const userText = substituteSimple(promptVersion.user_template, simpleMap);

  const start = Date.now();
  const response = await callAnthropic({ apiKey, model, effort, system, messages: [{ role: 'user', content: [{ type: 'text', text: userText }] }] });
  const latencyMs = Date.now() - start;

  return {
    system_prompt: system,
    user_text: userText,
    outputRaw: extractText(response),
    outputParsed: null,
    usage: response.usage || null,
    latencyMs,
    resolvedLocation,
    detailLevel,
    brief,
  };
}

// Keeps only the first post of each cross-post group the extraction prompt reported,
// so the same image published to two platforms isn't measured twice for colors.
function withoutCrossPostDuplicates(classifications, crossPostGroups) {
  const duplicates = new Set();
  for (const group of crossPostGroups || []) {
    const ids = (group && group.post_ids) || [];
    ids.slice(1).forEach((id) => duplicates.add(id));
  }
  return classifications.filter((c) => !duplicates.has(c.post_id));
}

/**
 * Runs social extraction, optionally runs website extraction (only when
 * account_info.website is present AND a website_extraction prompt version was
 * given - both are optional so a missing website never blocks the run), runs
 * the deterministic color sub-pipeline, and merges everything into the 5-field
 * guideline via mergeGuidelines(). Validation/compose stages consume the result.
 */
async function runMergedGuideline({ postData, extractionPromptVersion, websiteExtractionPromptVersion, model, effort, apiKey, debug, runId, debugDir, mergeWeights }) {
  const posts = postData.posts || [];
  const accountInfo = postData.account_info || null;
  const websiteUrl = accountInfo && accountInfo.website;

  // the two extractions are independent, so run them side by side
  const [extraction, websiteStage] = await Promise.all([
    runExtractionStage({ postData, promptVersion: extractionPromptVersion, model, effort, apiKey, debug, runId, debugDir }),
    websiteUrl && websiteExtractionPromptVersion
      ? runWebsiteExtractionStage({ websiteUrl, promptVersion: websiteExtractionPromptVersion, model, effort, apiKey })
      : null,
  ]);

  let website = null;
  if (websiteStage && websiteStage.outputParsed) {
    website = {
      ...websiteStage.outputParsed,
      cssColors: websiteStage.fetchResult.ok ? websiteStage.fetchResult.cssColors : [],
      // validation fact-checks against the page text, so it has to travel with the result
      pageText: websiteStage.fetchResult.ok ? websiteStage.fetchResult.pageText : null,
    };
  }

  let designedPostColors = { aggregated: [], perPost: [], postsUsed: 0 };
  let photographyModeColors = { aggregated: [], perPost: [], postsUsed: 0 };
  let photoTones = { perPost: [], axes: {}, photosMeasured: 0 };
  if (extraction.outputParsed) {
    const classifications = withoutCrossPostDuplicates(
      extraction.outputParsed.post_image_classifications || [],
      extraction.outputParsed.cross_post_groups
    );
    designedPostColors = await extractDesignedPostColors(posts, extraction.images, classifications);
    photographyModeColors = await extractPhotographyModeColors(posts, extraction.images, classifications);
    photoTones = await measurePhotoTones(posts, extraction.images, classifications);
  }

  let merged = null;
  let mergeMeta = null;
  if (extraction.outputParsed) {
    const { guideline, meta } = mergeGuidelines({
      accountInfo,
      social: extraction.outputParsed,
      website,
      designedPostColors,
      photographyModeColors,
      weights: mergeWeights,
      minPostThreshold: MIN_POST_THRESHOLD,
    });
    merged = guideline;
    mergeMeta = meta;
  }

  return { extraction, websiteStage, website, merged, mergeMeta, designedPostColors, photographyModeColors, photoTones };
}

module.exports = {
  MIN_POST_THRESHOLD,
  EXTRACTION_SYSTEM_PROMPT_SCHEMA,
  fetchAndResizeImage,
  fetchImagesForPosts,
  callAnthropic,
  extractText,
  tryParseJson,
  substituteSimple,
  resolveAccountInfoJson,
  buildComposeBrief,
  toBrandBrief,
  runExtractionStage,
  runWebsiteExtractionStage,
  runValidationStage,
  runComposeStage,
  runMergedGuideline,
  resolveLocationForCompose,
};

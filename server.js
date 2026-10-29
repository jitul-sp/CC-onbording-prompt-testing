const express = require('express');
const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const brandGuidelinePipeline = require('./brandGuidelinePipeline');
const { colorFamily, summarizePhotoMood } = require('./websiteMergePipeline');
const csvPostData = require('./csvPostData');

const ROOT = __dirname;
const POST_DATA_DIR = path.join(ROOT, 'Post data');
const PROMPTS_DIR = path.join(ROOT, 'Saved prompts');
const ROLES_FILE = path.join(PROMPTS_DIR, 'roles.json');
const RUN_LOGS_DIR = path.join(ROOT, 'Run logs');
const RUN_LOGS_FILE = path.join(RUN_LOGS_DIR, 'runs.jsonl');
const CONFIG_DIR = path.join(ROOT, 'config');
const MODELS_FILE = path.join(CONFIG_DIR, 'models.json');
const SECRETS_FILE = path.join(CONFIG_DIR, 'local-secrets.json');
const MERGE_WEIGHTS_FILE = path.join(CONFIG_DIR, 'merge-weights.json');
const TEST_SAMPLES_FILE = path.join(CONFIG_DIR, 'test-samples.json'); // brand labels, see scripts/build-test-samples.js
const DEBUG_IMAGES_DIR = path.join(RUN_LOGS_DIR, '_debug_images');

const PORT = process.env.PORT || 5175;
const DEFAULT_POST_LIMIT = 20;
// below this there's too little to describe a brand - refuse rather than pay for a guess
const MIN_POSTS_TO_RUN = 3;

let currentApiKey = null;
let currentApiKeyRemembered = false;

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(ROOT, 'public')));

function wrapAsync(fn) {
  return (req, res, next) => fn(req, res, next).catch(next);
}

function isSafeSegment(name) {
  return typeof name === 'string' && name.length > 0 && !name.includes('/') && !name.includes('\\') && name !== '.' && name !== '..';
}

// ---------- roles / prompts storage helpers ----------

async function readRoles() {
  const raw = await fs.readFile(ROLES_FILE, 'utf8');
  return JSON.parse(raw);
}

async function writeRoles(roles) {
  await fs.writeFile(ROLES_FILE, JSON.stringify(roles, null, 2) + '\n', 'utf8');
}

async function listPromptVersions(role) {
  const dir = path.join(PROMPTS_DIR, role);
  let files;
  try {
    files = await fs.readdir(dir);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
  const versionFiles = files.filter((f) => /^v\d+\.json$/.test(f));
  const versions = [];
  for (const f of versionFiles) {
    const raw = await fs.readFile(path.join(dir, f), 'utf8');
    versions.push(JSON.parse(raw));
  }
  versions.sort((a, b) => a.version - b.version);
  return versions;
}

async function getPromptVersion(role, version) {
  const file = path.join(PROMPTS_DIR, role, `v${version}.json`);
  try {
    const raw = await fs.readFile(file, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

async function getLatestPromptVersion(role) {
  const versions = await listPromptVersions(role);
  if (!versions || versions.length === 0) return null;
  return versions[versions.length - 1];
}

// ---------- config ----------

async function readMergeWeights() {
  const raw = await fs.readFile(MERGE_WEIGHTS_FILE, 'utf8');
  return JSON.parse(raw);
}

// ---------- API key ----------

async function loadSecretsAtBoot() {
  try {
    const raw = await fs.readFile(SECRETS_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.apiKey === 'string' && parsed.apiKey.length > 0) {
      currentApiKey = parsed.apiKey;
      currentApiKeyRemembered = true;
    }
  } catch (err) {
    if (err.code !== 'ENOENT') console.error('Failed to read local-secrets.json:', err.message);
  }
}

// ---------- routes: post data ----------

function isPostDataFilename(name) {
  return /\.(json|csv)$/i.test(name);
}

// Samples used to be named user_<ownerId>.csv; old run logs still point there, so map such a
// name to its renamed <brand>__<ownerId>.csv file.
async function resolvePostDataFilename(filename) {
  const legacy = filename.match(/^user_(\d+)\.csv$/);
  if (!legacy) return filename;
  try {
    await fs.access(path.join(POST_DATA_DIR, filename));
    return filename;
  } catch {
    const renamed = (await fs.readdir(POST_DATA_DIR)).find((f) => f.endsWith(`__${legacy[1]}.csv`));
    return renamed || filename;
  }
}

async function readTestSampleLabels() {
  try {
    return JSON.parse(await fs.readFile(TEST_SAMPLES_FILE, 'utf8')).samples || {};
  } catch {
    return {};
  }
}

// Reads a post-data file into { account_info, posts }; CSV exports are converted on the fly,
// and each account gets the brand label stored for that sample (if any).
async function loadPostDataFile(filename) {
  const resolved = await resolvePostDataFilename(filename);
  const raw = await fs.readFile(path.join(POST_DATA_DIR, resolved), 'utf8');
  if (!resolved.toLowerCase().endsWith('.csv')) return JSON.parse(raw);
  const postData = csvPostData.csvTextToPostData(raw);
  const sample = Object.values(await readTestSampleLabels()).find((s) => s.file === resolved);
  if (sample) {
    const labels = new Map(sample.accounts.map((a) => [a.account_id, a]));
    postData.accounts = postData.accounts.map((a) => {
      const l = labels.get(a.account_id);
      return l ? { ...a, brand_name: l.brand_name, business_type: l.business_type, locality: l.locality } : a;
    });
  }
  return postData;
}

/** The posts as the model saw them (captions + original image URLs), for the run-detail view. */
function snapshotInputs(posts) {
  return posts.map((p) => ({
    post_id: p.post_id,
    date: p.date || null,
    platform: p.platform || null,
    account_id: p.account_id || null,
    caption_text: p.caption_text || '',
    image_url: p.image_url || null,
    media_type: p.media_type || null,
    tagged_place: p.tagged_place || null,
  }));
}

/**
 * Runs logged before `inputs` existed: rebuild the post list from the file with
 * the run's account filter and post limit. Only trusted if the count matches.
 */
async function reconstructInputs(entry) {
  if (!entry.post_data_file || !isSafeSegment(entry.post_data_file) || !isPostDataFilename(entry.post_data_file)) return null;
  try {
    let postData = await loadPostDataFile(entry.post_data_file);
    if (entry.account_id) postData = csvPostData.filterToAccount(postData, entry.account_id);
    const posts = csvPostData.limitPosts(postData.posts || [], entry.post_limit === undefined ? null : entry.post_limit);
    if (entry.posts_count && posts.length !== entry.posts_count) return null;
    return snapshotInputs(posts);
  } catch {
    return null;
  }
}

app.get('/api/post-data', wrapAsync(async (req, res) => {
  const files = await fs.readdir(POST_DATA_DIR);
  res.json(files.filter(isPostDataFilename).sort());
}));

app.get('/api/post-data/:filename', wrapAsync(async (req, res) => {
  const { filename } = req.params;
  if (!isSafeSegment(filename) || !isPostDataFilename(filename)) {
    return res.status(400).json({ error: 'Invalid filename' });
  }
  try {
    res.json(await loadPostDataFile(filename));
  } catch (err) {
    if (err.code === 'ENOENT') return res.status(404).json({ error: 'File not found' });
    if (err.status) return res.status(err.status).json({ error: err.message });
    throw err;
  }
}));

// ---------- routes: roles ----------

app.get('/api/roles', wrapAsync(async (req, res) => {
  res.json(await readRoles());
}));

app.post('/api/roles', wrapAsync(async (req, res) => {
  const { id, label, description } = req.body || {};
  if (!isSafeSegment(id) || !/^[a-z0-9_-]+$/.test(id)) {
    return res.status(400).json({ error: 'id must be lowercase letters/digits/hyphen/underscore only' });
  }
  if (!label) return res.status(400).json({ error: 'label is required' });
  const roles = await readRoles();
  if (roles.some((r) => r.id === id)) return res.status(409).json({ error: 'Role already exists' });
  roles.push({ id, label, description: description || '' });
  await writeRoles(roles);
  await fs.mkdir(path.join(PROMPTS_DIR, id), { recursive: true });
  res.status(201).json(roles);
}));

app.put('/api/roles/:id', wrapAsync(async (req, res) => {
  const { id } = req.params;
  const { label, description } = req.body || {};
  const roles = await readRoles();
  const role = roles.find((r) => r.id === id);
  if (!role) return res.status(404).json({ error: 'Role not found' });
  if (label !== undefined) role.label = label;
  if (description !== undefined) role.description = description;
  await writeRoles(roles);
  res.json(role);
}));

app.delete('/api/roles/:id', wrapAsync(async (req, res) => {
  const { id } = req.params;
  const cascade = req.query.cascade === 'true';
  const roles = await readRoles();
  const idx = roles.findIndex((r) => r.id === id);
  if (idx === -1) return res.status(404).json({ error: 'Role not found' });

  const dir = path.join(PROMPTS_DIR, id);
  let contents = [];
  try {
    contents = await fs.readdir(dir);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  if (contents.length > 0 && !cascade) {
    return res.status(409).json({ error: `Role "${id}" has ${contents.length} version(s). Pass cascade=true to delete anyway.`, versionCount: contents.length });
  }

  await fs.rm(dir, { recursive: true, force: true });
  roles.splice(idx, 1);
  await writeRoles(roles);
  res.json(roles);
}));

// ---------- routes: prompt versions ----------

app.get('/api/prompts/:role', wrapAsync(async (req, res) => {
  const versions = await listPromptVersions(req.params.role);
  if (versions === null) return res.status(404).json({ error: 'Role not found' });
  res.json(versions);
}));

app.get('/api/prompts/:role/:version', wrapAsync(async (req, res) => {
  const version = Number(req.params.version);
  if (!Number.isInteger(version)) return res.status(400).json({ error: 'Invalid version' });
  const prompt = await getPromptVersion(req.params.role, version);
  if (!prompt) return res.status(404).json({ error: 'Version not found' });
  res.json(prompt);
}));

app.post('/api/prompts/:role', wrapAsync(async (req, res) => {
  const { role } = req.params;
  const { name, system_prompt, user_template, notes } = req.body || {};
  if (!system_prompt || !user_template) {
    return res.status(400).json({ error: 'system_prompt and user_template are required' });
  }
  const versions = await listPromptVersions(role);
  if (versions === null) return res.status(404).json({ error: 'Role not found' });
  const nextVersion = versions.length === 0 ? 1 : versions[versions.length - 1].version + 1;
  const entry = {
    id: `${role}-v${nextVersion}`,
    role,
    version: nextVersion,
    name: name || `${role} v${nextVersion}`,
    system_prompt,
    user_template,
    created_at: new Date().toISOString(),
    notes: notes || '',
  };
  await fs.writeFile(path.join(PROMPTS_DIR, role, `v${nextVersion}.json`), JSON.stringify(entry, null, 2) + '\n', 'utf8');
  res.status(201).json(entry);
}));

app.put('/api/prompts/:role/:version', wrapAsync(async (req, res) => {
  const { role } = req.params;
  const version = Number(req.params.version);
  if (!Number.isInteger(version)) return res.status(400).json({ error: 'Invalid version' });
  const existing = await getPromptVersion(role, version);
  if (!existing) return res.status(404).json({ error: 'Version not found' });
  const { name, system_prompt, user_template, notes } = req.body || {};
  const updated = {
    ...existing,
    name: name !== undefined ? name : existing.name,
    system_prompt: system_prompt !== undefined ? system_prompt : existing.system_prompt,
    user_template: user_template !== undefined ? user_template : existing.user_template,
    notes: notes !== undefined ? notes : existing.notes,
    updated_at: new Date().toISOString(),
  };
  await fs.writeFile(path.join(PROMPTS_DIR, role, `v${version}.json`), JSON.stringify(updated, null, 2) + '\n', 'utf8');
  res.json(updated);
}));

app.delete('/api/prompts/:role/:version', wrapAsync(async (req, res) => {
  const { role } = req.params;
  const version = Number(req.params.version);
  const file = path.join(PROMPTS_DIR, role, `v${version}.json`);
  try {
    await fs.unlink(file);
  } catch (err) {
    if (err.code === 'ENOENT') return res.status(404).json({ error: 'Version not found' });
    throw err;
  }
  res.json({ ok: true });
}));

// ---------- cost tracking ----------

async function readModels() {
  return JSON.parse(await fs.readFile(MODELS_FILE, 'utf8'));
}

// usage objects as returned by the API; thinking tokens are already inside output_tokens
function estimateCostUsd(modelEntry, usages) {
  if (!modelEntry || modelEntry.price_in_per_mtok === undefined) return null;
  let cost = 0;
  for (const u of usages) {
    if (!u) continue;
    const input = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
    cost += (input * modelEntry.price_in_per_mtok + (u.output_tokens || 0) * modelEntry.price_out_per_mtok) / 1e6;
  }
  return Math.round(cost * 1e5) / 1e5;
}

function stageUsage(u) {
  if (!u) return null;
  return {
    input_tokens: u.input_tokens || 0,
    output_tokens: u.output_tokens || 0,
    thinking_tokens: (u.output_tokens_details && u.output_tokens_details.thinking_tokens) || 0,
  };
}

// ---------- routes: models ----------

app.get('/api/models', wrapAsync(async (req, res) => {
  res.json(await readModels());
}));

// ---------- routes: api key ----------

app.get('/api/key/status', wrapAsync(async (req, res) => {
  res.json({ remembered: currentApiKeyRemembered, active: currentApiKey !== null });
}));

app.post('/api/key', wrapAsync(async (req, res) => {
  const { apiKey, remember } = req.body || {};
  if (!apiKey) {
    currentApiKey = null;
    currentApiKeyRemembered = false;
    await fs.writeFile(SECRETS_FILE, JSON.stringify({ apiKey: null }, null, 2) + '\n', 'utf8');
    return res.json({ remembered: false, active: false });
  }
  currentApiKey = apiKey;
  currentApiKeyRemembered = !!remember;
  await fs.writeFile(
    SECRETS_FILE,
    JSON.stringify({ apiKey: remember ? apiKey : null }, null, 2) + '\n',
    'utf8'
  );
  res.json({ remembered: currentApiKeyRemembered, active: true });
}));

// ---------- routes: run ----------

/** The code-measured colors that fed color_palette (pixel quantization, not the model). */
function buildColorMeasurementEntry(mergedResult) {
  const pick = (m) => ({
    posts_used: m.postsUsed || 0,
    colors: (m.aggregated || []).slice(0, 8),
    neutrals: (m.neutrals || []).slice(0, 4),
    not_design_colors: (m.notDesignColors || []).slice(0, 6),
    third_party_post_ids: m.thirdPartyPostIds || [],
  });
  const tones = mergedResult.photoTones || {};
  return {
    designed_posts: pick(mergedResult.designedPostColors || {}),
    photography: { ...pick(mergedResult.photographyModeColors || {}), tones: tones.axes || {}, photos_measured: tones.photosMeasured || 0 },
  };
}

const BRAND_COLOR_GAPS = {
  no_usable_signal: 'there are no designed graphics in the posts and no website colors to measure',
  photography_only_not_a_confirmed_palette: 'the posts are photos, and photo colors are not a brand palette - add the website to measure its colors',
  website_css_only: 'the website declares too few colors to confirm a palette',
};

/**
 * The brand palette handed to content generation next to the paragraph. Colors are measured
 * in code and given only at high/medium confidence; otherwise none, with the reason - never a guess.
 */
function buildBrandColors(mergedResult) {
  const palette = (mergedResult.merged && mergedResult.merged.color_palette) || {};
  if (['high', 'medium'].includes(palette.confidence) && (palette.hex_colors || []).length) {
    const measured = (mergedResult.designedPostColors && mergedResult.designedPostColors.aggregated) || [];
    const colors = palette.hex_colors.map((hex) => {
      const m = measured.find((c) => c.color === hex);
      return { color: hex, family: colorFamily(hex), ...(m && m.roles ? { used_for: m.roles } : {}) };
    });
    return { status: 'confirmed', colors, confidence: palette.confidence, basis: palette.basis };
  }
  const designedUsed = (mergedResult.designedPostColors && mergedResult.designedPostColors.postsUsed) || 0;
  const reason = BRAND_COLOR_GAPS[palette.basis]
    || `only ${designedUsed} designed post(s), or no color repeats across 3 of them - too little to confirm a palette`;
  return { status: 'not_confirmed', colors: [], confidence: palette.confidence || 'none', basis: palette.basis || null, reason };
}

function normalizeWebsiteUrl(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const withScheme = /^https?:\/\//i.test(raw.trim()) ? raw.trim() : `https://${raw.trim()}`;
  try {
    const url = new URL(withScheme);
    return ['http:', 'https:'].includes(url.protocol) && url.hostname.includes('.') ? url.href : null;
  } catch {
    return null;
  }
}

const CONFIDENCE_RANK = { none: 0, low: 1, medium: 2, high: 3 };

/**
 * Validation reads captions only, so it can't confirm a name seen on logos/on-image text:
 * keep the merge's brand_name, but let validation lower its confidence (never raise it).
 */
function withMergedBrandName(validated, mergedGuideline) {
  // validation must return every field; if it drops one, fall back to the merged reading
  const corrected = { ...(mergedGuideline || {}), ...validated };
  const merged = mergedGuideline && mergedGuideline.brand_name;
  if (!merged) return corrected;
  const checked = corrected.brand_name;
  const lowered = checked && checked.value === merged.value && (CONFIDENCE_RANK[checked.confidence] ?? 3) < CONFIDENCE_RANK[merged.confidence];
  const removed = checked && !checked.value && merged.source !== 'account_info';
  return { ...corrected, brand_name: lowered || removed ? { ...merged, confidence: removed ? 'none' : checked.confidence } : merged };
}

function buildPipelineWebsiteEntry(postData, websiteExtractionVersion, mergedResult) {
  if (websiteExtractionVersion && mergedResult.websiteStage) {
    return {
      version: websiteExtractionVersion.version,
      output_parsed: mergedResult.websiteStage.outputParsed,
      fetch_ok: mergedResult.websiteStage.fetchResult.ok,
      fetch_error: mergedResult.websiteStage.fetchResult.ok ? null : mergedResult.websiteStage.fetchResult.error,
    };
  }
  const hasWebsiteUrl = !!(postData.account_info && postData.account_info.website);
  return {
    skipped: true,
    reason: hasWebsiteUrl ? 'no website_extraction prompt version exists' : 'no website given (enter one in Website, or add account_info.website to the file)',
  };
}

app.post('/api/run', wrapAsync(async (req, res) => {
  const { post_data_file, role, version, model, effort, debug, post_limit, account_id, brand_name, website } = req.body || {};

  if (!currentApiKey) {
    return res.status(400).json({ error: 'No API key set. Enter your Anthropic API key first.' });
  }
  if (!post_data_file || !role || version === undefined || !model) {
    return res.status(400).json({ error: 'post_data_file, role, version, and model are required' });
  }
  if (!isSafeSegment(post_data_file) || !isPostDataFilename(post_data_file)) {
    return res.status(400).json({ error: 'Invalid post data filename' });
  }
  // omitted -> DEFAULT_POST_LIMIT; explicit null/'' -> every post in the file
  const postLimit = post_limit === undefined ? DEFAULT_POST_LIMIT : post_limit === null || post_limit === '' ? null : Number(post_limit);
  if (postLimit !== null && (!Number.isInteger(postLimit) || postLimit < 1)) {
    return res.status(400).json({ error: 'post_limit must be a positive whole number (or empty for all posts)' });
  }

  let postData;
  try {
    postData = await loadPostDataFile(post_data_file);
  } catch (err) {
    if (err.code === 'ENOENT') return res.status(404).json({ error: 'Post data file not found' });
    return res.status(400).json({ error: err.status ? err.message : 'Post data file could not be parsed' });
  }

  if (account_id) {
    postData = csvPostData.filterToAccount(postData, String(account_id));
    if (postData.posts.length === 0) return res.status(400).json({ error: `No posts for account ${account_id} in this file` });
  }
  // a known brand name (in production: the connected page's name) is ground truth
  const brandName = typeof brand_name === 'string' ? brand_name.trim().slice(0, 120) : '';
  if (brandName) postData = { ...postData, account_info: { ...postData.account_info, brand_name: brandName } };
  const websiteUrl = normalizeWebsiteUrl(website);
  if (website && !websiteUrl) return res.status(400).json({ error: 'Website must be a valid http(s) URL' });
  if (websiteUrl) postData = { ...postData, account_info: { ...postData.account_info, website: websiteUrl } };
  const postsAvailable = (postData.posts || []).length;
  postData = { ...postData, posts: csvPostData.limitPosts(postData.posts || [], postLimit) };
  const posts = postData.posts;
  if (posts.length < MIN_POSTS_TO_RUN && role !== 'website_extraction') {
    return res.status(400).json({ error: `Only ${posts.length} post(s) selected - at least ${MIN_POSTS_TO_RUN} are needed to say anything about a brand. Pick a bigger account or raise "Posts to read".` });
  }
  const lowPostWarning = posts.length < brandGuidelinePipeline.MIN_POST_THRESHOLD;

  const promptVersion = await getPromptVersion(role, Number(version));
  if (!promptVersion) return res.status(404).json({ error: 'Prompt version not found' });

  const runId = crypto.randomUUID();
  const timestamp = new Date().toISOString();
  const runEffort = ['low', 'medium', 'high'].includes(effort) ? effort : null;

  const logEntry = {
    run_id: runId,
    timestamp,
    post_data_file,
    account_id: account_id ? String(account_id) : null,
    brand_name_given: brandName || null,
    website_given: websiteUrl || null,
    prompt_role: role,
    prompt_version: Number(version),
    model,
    effort: runEffort,
    posts_count: posts.length,
    posts_available: postsAvailable,
    post_limit: postLimit,
    low_post_warning: lowPostWarning,
    images_fetched: 0,
    images_failed: 0,
    inputs: snapshotInputs(posts),
    input_snapshot: null,
    output_raw: null,
    output_parsed: null,
    latency_ms: 0,
    usage: null,
    error: null,
    pipeline: null,
  };
  // every API call this run paid for, for the cost estimate (single-stage roles use logEntry.usage)
  let stageUsages = null;

  try {
    if (role === 'extraction') {
      const result = await brandGuidelinePipeline.runExtractionStage({
        postData,
        promptVersion,
        model,
        effort: runEffort,
        apiKey: currentApiKey,
        debug: !!debug,
        runId,
        debugDir: DEBUG_IMAGES_DIR,
      });
      logEntry.input_snapshot = { system_prompt: result.system_prompt, user_text: result.user_text };
      logEntry.output_raw = result.outputRaw;
      logEntry.output_parsed = result.outputParsed;
      logEntry.latency_ms = result.latencyMs;
      logEntry.usage = result.usage;
      logEntry.images_fetched = result.imagesFetched;
      logEntry.images_failed = result.imagesFailed;
      logEntry.image_notes = result.imageNotes;
      if (result.outputParsed === null) {
        logEntry.error = 'Model output was not valid JSON; see output_raw.';
      }
    } else if (role === 'website_extraction') {
      const websiteUrl = postData.account_info && postData.account_info.website;
      if (!websiteUrl) {
        const skip = { skipped: true, reason: 'account_info.website not present in this post-data file - nothing to fetch.' };
        logEntry.output_raw = JSON.stringify(skip, null, 2);
        logEntry.output_parsed = skip;
      } else {
        const result = await brandGuidelinePipeline.runWebsiteExtractionStage({
          websiteUrl,
          promptVersion,
          model,
          effort: runEffort,
          apiKey: currentApiKey,
        });
        logEntry.input_snapshot = { system_prompt: result.system_prompt, user_text: result.user_text };
        logEntry.output_raw = result.outputRaw;
        logEntry.output_parsed = result.outputParsed;
        logEntry.latency_ms = result.latencyMs;
        logEntry.usage = result.usage;
        if (!result.fetchResult.ok) {
          logEntry.website_fetch_error = result.fetchResult.error;
          logEntry.error = `Website could not be fetched: ${result.fetchResult.error}`;
        } else if (result.outputParsed === null) {
          logEntry.error = 'Model output was not valid JSON; see output_raw.';
        }
      }
    } else if (role === 'validation') {
      const extractionVersion = await getLatestPromptVersion('extraction');
      if (!extractionVersion) return res.status(409).json({ error: 'No extraction prompt versions exist yet - validation needs one to run against.' });
      const websiteExtractionVersion = await getLatestPromptVersion('website_extraction');
      const mergeWeights = await readMergeWeights();

      const merged = await brandGuidelinePipeline.runMergedGuideline({
        postData,
        extractionPromptVersion: extractionVersion,
        websiteExtractionPromptVersion: websiteExtractionVersion,
        model,
        effort: runEffort,
        apiKey: currentApiKey,
        debug: !!debug,
        runId,
        debugDir: DEBUG_IMAGES_DIR,
        mergeWeights,
      });

      logEntry.images_fetched = merged.extraction.imagesFetched;
      logEntry.images_failed = merged.extraction.imagesFailed;
      logEntry.image_notes = merged.extraction.imageNotes;

      if (merged.extraction.outputParsed === null) {
        logEntry.error = 'Prerequisite extraction stage returned invalid JSON; cannot proceed to validation.';
        logEntry.output_raw = merged.extraction.outputRaw;
        await appendLog(logEntry);
        return res.status(200).json(logEntry);
      }

      logEntry.pipeline = {
        extraction: { version: extractionVersion.version, output_parsed: merged.extraction.outputParsed },
        website_extraction: buildPipelineWebsiteEntry(postData, websiteExtractionVersion, merged),
        color_measurement: buildColorMeasurementEntry(merged),
        merged_guideline: merged.merged,
        merge_meta: merged.mergeMeta,
      };

      const validation = await brandGuidelinePipeline.runValidationStage({
        postData,
        promptVersion,
        model,
        effort: runEffort,
        apiKey: currentApiKey,
        mergedGuideline: merged.merged,
        socialVoiceAndTone: merged.extraction.outputParsed.voice_and_tone,
        websitePageText: merged.website ? merged.website.pageText : null,
        postsAnalyzed: merged.mergeMeta ? merged.mergeMeta.posts_analyzed : posts.length,
      });
      logEntry.input_snapshot = { system_prompt: validation.system_prompt, user_text: validation.user_text };
      logEntry.output_raw = validation.outputRaw;
      logEntry.output_parsed = validation.outputParsed;
      logEntry.latency_ms = merged.extraction.latencyMs + (merged.websiteStage ? merged.websiteStage.latencyMs : 0) + validation.latencyMs;
      logEntry.usage = validation.usage;
      logEntry.usage_by_stage = {
        extraction: stageUsage(merged.extraction.usage),
        website_extraction: merged.websiteStage ? stageUsage(merged.websiteStage.usage) : null,
        validation: stageUsage(validation.usage),
      };
      stageUsages = [merged.extraction.usage, merged.websiteStage && merged.websiteStage.usage, validation.usage];
      if (validation.outputParsed === null) {
        logEntry.error = 'Model output was not valid JSON; see output_raw.';
      }
    } else if (role === 'compose') {
      const extractionVersion = await getLatestPromptVersion('extraction');
      const validationVersion = await getLatestPromptVersion('validation');
      if (!extractionVersion || !validationVersion) {
        return res.status(409).json({ error: 'Compose needs at least one extraction and one validation prompt version to run against.' });
      }
      const websiteExtractionVersion = await getLatestPromptVersion('website_extraction');
      const mergeWeights = await readMergeWeights();

      const merged = await brandGuidelinePipeline.runMergedGuideline({
        postData,
        extractionPromptVersion: extractionVersion,
        websiteExtractionPromptVersion: websiteExtractionVersion,
        model,
        effort: runEffort,
        apiKey: currentApiKey,
        debug: !!debug,
        runId,
        debugDir: DEBUG_IMAGES_DIR,
        mergeWeights,
      });

      logEntry.images_fetched = merged.extraction.imagesFetched;
      logEntry.images_failed = merged.extraction.imagesFailed;
      logEntry.image_notes = merged.extraction.imageNotes;

      if (merged.extraction.outputParsed === null) {
        logEntry.error = 'Prerequisite extraction stage returned invalid JSON; cannot proceed to compose.';
        logEntry.output_raw = merged.extraction.outputRaw;
        await appendLog(logEntry);
        return res.status(200).json(logEntry);
      }

      // logged before validation so a failed later stage still shows what ran before it
      logEntry.pipeline = {
        extraction: { version: extractionVersion.version, output_parsed: merged.extraction.outputParsed },
        website_extraction: buildPipelineWebsiteEntry(postData, websiteExtractionVersion, merged),
        color_measurement: buildColorMeasurementEntry(merged),
        merged_guideline: merged.merged,
        merge_meta: merged.mergeMeta,
      };

      const validation = await brandGuidelinePipeline.runValidationStage({
        postData,
        promptVersion: validationVersion,
        model,
        effort: runEffort,
        apiKey: currentApiKey,
        mergedGuideline: merged.merged,
        socialVoiceAndTone: merged.extraction.outputParsed.voice_and_tone,
        websitePageText: merged.website ? merged.website.pageText : null,
        postsAnalyzed: merged.mergeMeta ? merged.mergeMeta.posts_analyzed : posts.length,
      });
      logEntry.pipeline.validation = { version: validationVersion.version, output_parsed: validation.outputParsed, output_raw: validation.outputParsed ? undefined : validation.outputRaw };
      if (validation.outputParsed === null || !validation.outputParsed.corrected_guideline) {
        logEntry.error = 'Prerequisite validation stage returned invalid JSON; cannot proceed to compose.';
        logEntry.output_raw = validation.outputRaw;
        await appendLog(logEntry);
        return res.status(200).json(logEntry);
      }


      const compose = await brandGuidelinePipeline.runComposeStage({
        postData,
        promptVersion,
        model,
        effort: runEffort,
        apiKey: currentApiKey,
        validatedGuideline: withMergedBrandName(validation.outputParsed.corrected_guideline, merged.merged),
        contentLanguage: merged.extraction.outputParsed.content_language,
        postsAnalyzed: merged.mergeMeta ? merged.mergeMeta.posts_analyzed : posts.length,
      });
      logEntry.detail_level = compose.detailLevel;
      logEntry.pipeline.compose_brief = { detail_level: compose.detailLevel, brief: compose.brief };
      logEntry.usage_by_stage = {
        extraction: stageUsage(merged.extraction.usage),
        website_extraction: merged.websiteStage ? stageUsage(merged.websiteStage.usage) : null,
        validation: stageUsage(validation.usage),
        compose: stageUsage(compose.usage),
      };
      logEntry.validation_issue_count = (validation.outputParsed.issues_found || []).length;
      logEntry.content_language = merged.extraction.outputParsed.content_language || null;
      stageUsages = [merged.extraction.usage, merged.websiteStage && merged.websiteStage.usage, validation.usage, compose.usage];
      logEntry.input_snapshot = { system_prompt: compose.system_prompt, user_text: compose.user_text };
      logEntry.output_raw = compose.outputRaw;
      logEntry.output_parsed = null;
      logEntry.latency_ms = merged.extraction.latencyMs + (merged.websiteStage ? merged.websiteStage.latencyMs : 0) + validation.latencyMs + compose.latencyMs;
      logEntry.usage = compose.usage;
      logEntry.resolved_location = compose.resolvedLocation;
      logEntry.brand_colors = buildBrandColors(merged);
      logEntry.photo_mood = summarizePhotoMood({
        photoTones: merged.photoTones,
        photographyModeColors: merged.photographyModeColors,
        photoStyle: merged.extraction.outputParsed.photo_style,
      });
    } else {
      return res.status(400).json({ error: `Unknown role "${role}" for run execution.` });
    }
  } catch (err) {
    logEntry.error = err.message;
    await appendLog(logEntry);
    return res.status(err.status && err.status < 500 ? 400 : 502).json({ ...logEntry });
  }

  const modelEntry = (await readModels()).find((m) => m.id === model);
  logEntry.cost_usd = estimateCostUsd(modelEntry, stageUsages || [logEntry.usage]);
  await appendLog(logEntry);
  res.json(logEntry);
}));

async function appendLog(entry) {
  await fs.appendFile(RUN_LOGS_FILE, JSON.stringify(entry) + '\n', 'utf8');
}

// ---------- routes: logs ----------

async function readAllLogs() {
  let raw;
  try {
    raw = await fs.readFile(RUN_LOGS_FILE, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  return raw
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

app.get('/api/logs', wrapAsync(async (req, res) => {
  const { role, post_data_file, page = '1', pageSize = '20' } = req.query;
  let entries = await readAllLogs();
  if (role) entries = entries.filter((e) => e.prompt_role === role);
  if (post_data_file) entries = entries.filter((e) => e.post_data_file === post_data_file);
  entries.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

  const p = Math.max(1, parseInt(page, 10) || 1);
  const ps = Math.max(1, parseInt(pageSize, 10) || 20);
  const start = (p - 1) * ps;
  const pageItems = entries.slice(start, start + ps).map((e) => ({
    run_id: e.run_id,
    timestamp: e.timestamp,
    post_data_file: e.post_data_file,
    prompt_role: e.prompt_role,
    prompt_version: e.prompt_version,
    model: e.model,
    effort: e.effort || null,
    temperature: e.temperature,
    latency_ms: e.latency_ms,
    cost_usd: e.cost_usd === undefined ? null : e.cost_usd,
    low_post_warning: e.low_post_warning,
    error: e.error,
  }));

  res.json({ total: entries.length, page: p, pageSize: ps, items: pageItems });
}));

app.get('/api/logs/:run_id', wrapAsync(async (req, res) => {
  const entries = await readAllLogs();
  const entry = entries.find((e) => e.run_id === req.params.run_id);
  if (!entry) return res.status(404).json({ error: 'Run not found' });
  // compose runs logged before the brief was recorded: rebuild it from the validated guideline
  const validated = entry.pipeline && entry.pipeline.validation && entry.pipeline.validation.output_parsed;
  if (entry.prompt_role === 'compose' && entry.pipeline && !entry.pipeline.compose_brief && validated && validated.corrected_guideline) {
    const postsAnalyzed = entry.pipeline.merge_meta ? entry.pipeline.merge_meta.posts_analyzed : entry.posts_count;
    const { brief, detailLevel } = brandGuidelinePipeline.buildComposeBrief(withMergedBrandName(validated.corrected_guideline, entry.pipeline.merged_guideline), postsAnalyzed);
    entry.pipeline.compose_brief = { detail_level: detailLevel, brief, reconstructed: true };
  }
  if (!entry.inputs && entry.prompt_role !== 'website_extraction') {
    const inputs = await reconstructInputs(entry);
    if (inputs) {
      entry.inputs = inputs;
      entry.inputs_reconstructed = true;
    }
  }
  res.json(entry);
}));

// ---------- error handling ----------

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: err.message || 'Internal server error' });
});

// ---------- boot ----------

async function main() {
  await loadSecretsAtBoot();
  await brandGuidelinePipeline.loadExtractionSystemPromptReference(PROMPTS_DIR);
  app.listen(PORT, '127.0.0.1', () => {
    console.log(`Brand Prompt Lab running at http://127.0.0.1:${PORT}`);
  });
}

main();

const fs = require('fs');
const path = require('path');
const pipeline = require('./brandGuidelinePipeline');
const { colorFamily, summarizePhotoMood } = require('./websiteMergePipeline');

const PROMPTS_DIR = path.join(__dirname, '..', 'prompts');
const MERGE_WEIGHTS = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'merge-weights.json'), 'utf8'));

// USD per million tokens; output includes thinking tokens
const PRICES = { 'claude-haiku-5-5': { input: 0.10, output: 0.50 } };

function loadPrompt(role) {
  return {
    role,
    system_prompt: fs.readFileSync(path.join(PROMPTS_DIR, `${role}.system.md`), 'utf8'),
    user_template: fs.readFileSync(path.join(PROMPTS_DIR, `${role}.user.md`), 'utf8'),
  };
}

const PROMPTS = {
  extraction: loadPrompt('extraction'),
  website_extraction: loadPrompt('website_extraction'),
  validation: loadPrompt('validation'),
  compose: loadPrompt('compose'),
};

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

const BRAND_COLOR_GAPS = {
  no_usable_signal: 'there are no designed graphics in the posts and no website colors to measure',
  photography_only_not_a_confirmed_palette: 'the posts are photos, and photo colors are not a brand palette - add the website to measure its colors',
  website_css_only: 'the website declares too few colors to confirm a palette',
};

/**
 * Colors are measured in code and given only at high/medium confidence; otherwise none,
 * with the reason - never a guess.
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

function stageUsage(u) {
  if (!u) return null;
  return {
    input_tokens: u.input_tokens || 0,
    output_tokens: u.output_tokens || 0,
    thinking_tokens: (u.output_tokens_details && u.output_tokens_details.thinking_tokens) || 0,
  };
}

function estimateCostUsd(model, usages) {
  const price = PRICES[model];
  if (!price) return null;
  let cost = 0;
  for (const u of usages) {
    if (!u) continue;
    cost += (u.input_tokens * price.input + u.output_tokens * price.output) / 1e6;
  }
  return Math.round(cost * 1e5) / 1e5;
}

/**
 * Runs extraction (+ website extraction when account_info.website is set) -> merge ->
 * validation -> compose, and returns the paragraph, brand colors and photo mood.
 *
 * postData: { account_info: { brand_name?, website?, address? }, posts: [{ post_id, date,
 *   platform, caption_text, hashtags, image_url, links?, tagged_place? }] } - one social
 *   account, newest posts first (20 recommended).
 */
async function runBrandGuide({ postData, apiKey, model = 'claude-haiku-5-5', effort = 'medium' }) {
  const posts = postData.posts || [];
  const merged = await pipeline.runMergedGuideline({
    postData,
    extractionPromptVersion: PROMPTS.extraction,
    websiteExtractionPromptVersion: PROMPTS.website_extraction,
    model,
    effort,
    apiKey,
    mergeWeights: MERGE_WEIGHTS,
  });
  if (!merged.extraction.outputParsed) {
    throw new Error('Extraction returned no valid JSON - cannot continue.');
  }
  const postsAnalyzed = merged.mergeMeta ? merged.mergeMeta.posts_analyzed : posts.length;

  // colors and photo mood need only the measurement and the merge - not validation or compose
  const brandColors = buildBrandColors(merged);
  const photoMood = summarizePhotoMood({
    photoTones: merged.photoTones,
    photographyModeColors: merged.photographyModeColors,
    photoStyle: merged.extraction.outputParsed.photo_style,
  });

  const validation = await pipeline.runValidationStage({
    postData,
    promptVersion: PROMPTS.validation,
    model,
    effort,
    apiKey,
    mergedGuideline: merged.merged,
    socialVoiceAndTone: merged.extraction.outputParsed.voice_and_tone,
    websitePageText: merged.website ? merged.website.pageText : null,
    postsAnalyzed,
  });
  if (!validation.outputParsed || !validation.outputParsed.corrected_guideline) {
    // no paragraph without a validated guideline, but the measured outputs still stand
    return { error: 'Validation returned no valid JSON - no paragraph.', paragraph: null, brand_colors: brandColors, photo_mood: photoMood };
  }
  const guideline = withMergedBrandName(validation.outputParsed.corrected_guideline, merged.merged);

  const compose = await pipeline.runComposeStage({
    postData,
    promptVersion: PROMPTS.compose,
    model,
    effort,
    apiKey,
    validatedGuideline: guideline,
    contentLanguage: merged.extraction.outputParsed.content_language,
    postsAnalyzed,
  });

  const usage = {
    extraction: stageUsage(merged.extraction.usage),
    website_extraction: merged.websiteStage ? stageUsage(merged.websiteStage.usage) : null,
    validation: stageUsage(validation.usage),
    compose: stageUsage(compose.usage),
  };

  return {
    paragraph: compose.outputRaw,
    brand_colors: brandColors,
    photo_mood: photoMood,
    detail_level: compose.detailLevel,
    content_language: merged.extraction.outputParsed.content_language || null,
    guideline,
    validation_issues: validation.outputParsed.issues_found || [],
    image_failures: merged.extraction.imageNotes || [],
    usage,
    cost_usd: estimateCostUsd(model, Object.values(usage)),
  };
}

module.exports = { runBrandGuide, PROMPTS };

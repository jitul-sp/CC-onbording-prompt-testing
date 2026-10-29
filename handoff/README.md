# Brand guide pipeline

## Files

| Path | What it is |
| --- | --- |
| `prompts/extraction.system.md`, `.user.md` | Social extraction prompt (sees post images) |
| `prompts/website_extraction.system.md`, `.user.md` | Website extraction prompt (homepage text) |
| `prompts/validation.system.md`, `.user.md` | Validation prompt (fact-checks the merged guideline) |
| `prompts/compose.system.md`, `.user.md` | Compose prompt (writes the paragraph) |
| `src/runBrandGuide.js` | Entry point: `runBrandGuide({ postData, apiKey, model, effort })` |
| `src/brandGuidelinePipeline.js` | Stages: image fetch, Anthropic call, extraction, website extraction, validation, compose brief + compose |
| `src/websiteMergePipeline.js` | Website fetch, per-field merge, confidence caps, color measurement, photo mood |
| `src/postData.csv.js` | Optional adapter: scheduler CSV export to `postData` |
| `config/merge-weights.json` | Location merge weights |
| `example/run.js` | CLI example |

## Run

```
npm install
ANTHROPIC_API_KEY=... node example/run.js <export.csv> <loginId> [postLimit]
```

Defaults: `claude-haiku-5-5`, `output_config.effort: "medium"`, `max_tokens` 16000, no sampling parameters. About $0.012 and 60–90 s per 20-post run.

## Input

One social account (one `loginId`), newest posts first, 20 recommended:

```json
{
  "account_info": { "brand_name": "optional, treated as ground truth", "website": "optional https URL", "address": "optional" },
  "posts": [
    { "post_id": "p1", "date": "2026-10-20", "platform": "facebook", "caption_text": "...", "hashtags": ["#..."],
      "image_url": "https://...", "links": ["https://..."], "tagged_place": "optional" }
  ]
}
```

Facebook and Instagram copies of the same post stay as separate posts; the extraction prompt groups them.

## Output

```json
{
  "paragraph": "The Plough is a pub serving food and drinks in Dormansland ...",
  "brand_colors": { "status": "confirmed | not_confirmed", "colors": [{ "color": "#60d0d0", "family": "teal", "used_for": ["headline"] }], "confidence": "medium", "basis": "...", "reason": "only when not_confirmed" },
  "photo_mood": { "status": "confirmed | not_confirmed", "photos_measured": 18, "tones": { "warmth": "warm", "brightness": "mid" }, "recurring_colors": [], "style": "...", "reason": "only when not_confirmed" },
  "detail_level": "specific | general",
  "content_language": "en",
  "guideline": { "brand_name": {}, "business_profile": {}, "content_pillars": {}, "voice_and_tone": {}, "hashtag_strategy": {}, "location": {}, "color_palette": {} },
  "validation_issues": [],
  "image_failures": [],
  "usage": { "extraction": {}, "website_extraction": null, "validation": {}, "compose": {} },
  "cost_usd": 0.0114
}
```

## Call order

1. Extraction and website extraction in parallel (website only when `account_info.website` is set and fetchable).
2. Code: color measurement, photo tones, per-field merge (`mergeGuidelines`).
3. Validation.
4. Code: `withMergedBrandName`, then `buildComposeBrief` / `toBrandBrief` (confidence gate; colors never reach compose).
5. Compose.
6. Code: `buildBrandColors`, `summarizePhotoMood`.

## Prompt placeholders (filled by code)

| Prompt | Placeholders |
| --- | --- |
| extraction | `{{ACCOUNT_INFO_JSON}}`, `{{POST_COUNT}}`, `{{MIN_POST_THRESHOLD}}`, `{{POSTS_BLOCK}}` (posts interleaved with their images) |
| website_extraction | `{{WEBSITE_FETCH_STATUS}}`, `{{WEBSITE_PAGE_TEXT}}`, `{{WEBSITE_CSS_COLORS_JSON}}` |
| validation | `{{POSTS_JSON}}`, `{{ACCOUNT_INFO_JSON}}`, `{{WEBSITE_TEXT_EXCERPT}}`, `{{SOCIAL_VOICE_AND_TONE_JSON}}`, `{{POSTS_ANALYZED}}`, `{{MIN_POST_THRESHOLD}}`, `{{MERGED_GUIDELINE_JSON}}` |
| compose | `{{BRAND_BRIEF_JSON}}`, `{{DETAIL_LEVEL}}`, `{{CONTENT_LANGUAGE}}` |

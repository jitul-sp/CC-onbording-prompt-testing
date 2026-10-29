# Pipeline steps: AI vs code

One run takes one social account's recent posts (20 by default), plus an optional website, and returns three outputs: `paragraph`, `brand_colors` and `photo_mood`.

**AI** = an LLM call (Claude Haiku 5.5, effort `medium`). **Code** = deterministic JavaScript.
Rule of the split: AI reads and interprets; code measures, counts and decides what is confident enough to output.

| # | Step | Done by | File / function |
|---|---|---|---|
| 1 | Load posts | Code | `postData.csv.js` |
| 2 | Fetch images | Code | `brandGuidelinePipeline.js` → `fetchImagesForPosts` |
| 3 | Fetch website | Code | `websiteMergePipeline.js` → `fetchWebsiteContent` |
| 4 | Social extraction | **AI** | `runExtractionStage` + `prompts/extraction.*` |
| 5 | Website extraction | **AI** | `runWebsiteExtractionStage` + `prompts/website_extraction.*` |
| 6 | Measure brand colors | Code | `extractDesignedPostColors` |
| 7 | Measure photo tones | Code | `measurePhotoTones`, `extractPhotographyModeColors` |
| 8 | Merge into one guideline | Code | `mergeGuidelines` |
| 9 | Brand colors + photo mood outputs | Code | `buildBrandColors`, `summarizePhotoMood` |
| 10 | Validation | **AI** | `runValidationStage` + `prompts/validation.*` |
| 11 | Protect brand name | Code | `withMergedBrandName` |
| 12 | Confidence gate (compose brief) | Code | `buildComposeBrief`, `toBrandBrief` |
| 13 | Compose paragraph | **AI** | `runComposeStage` + `prompts/compose.*` |

Steps 4 and 5 run in parallel. Step 9 needs only steps 6–8, so the color and photo outputs are built before validation and are still returned if validation fails. Steps 10–13 run in sequence and produce only the paragraph.

---

## 1. Load posts — Code

- Reads the scheduler CSV export and turns each row into a post: `post_id`, `date`, `platform`, `caption_text`, `hashtags`, `image_url`, `links`, `tagged_place`.
- Keeps one social account (`loginId`) and its N newest posts (default 20).
- Facebook and Instagram copies of the same post are **not** merged here. There is no reliable shared key between them, so the extraction prompt groups them (step 4).
- Optional ground truth goes in `account_info`: `brand_name`, `website`, `address`.

## 2. Fetch images — Code

- Downloads each post image, resizes it to at most 1024 px, and re-encodes it as JPEG at quality 85.
- Limits: 1 MB per image, 18 MB in total, 6 downloads at a time.
- A failed download is retried once after 1 s. Failures are reported in `image_failures`, and the run continues without that image.

## 3. Fetch website — Code (only when `account_info.website` is set)

- Fetches the homepage's visible text (up to 8,000 characters) and up to 10 linked stylesheets.
- Timeout is 15 s with one retry. Certificate (TLS) errors are not retried.
- Counts the color declarations in the CSS. White, black, greys and WordPress/Bootstrap default theme colors are dropped, and near-identical shades are merged.
- If the fetch fails, step 5 makes **no** AI call.

## 4. Social extraction — AI (sees images)

The model gets every caption with its image. It returns one JSON object containing:

| Field | What the model does |
|---|---|
| `cross_post_groups` | Groups copies of the same post (other platforms, other pages, same day) so they count as **one** piece of evidence |
| `brand_name` | The name the business operates under, not partners or product makes. Confidence by number of distinct posts: 3+ high, 2 medium, 1 low |
| `location_signal` | The town or city, from captions, hashtags, tags, on-image text or own links. Needs 2+ distinct posts for medium or high |
| `business_profile` | What the business is, 2–6 things it sells, and who it serves (only if stated in 2+ posts) |
| `content_pillars` | 2–5 recurring topics |
| `voice_and_tone` | The dominant voice, in one phrase |
| `hashtag_strategy` | How hashtags are used, and the recurring ones |
| `post_image_classifications` | Each image: `photographic`, `photo_with_overlay` or `graphic_designed`. For graphics also `owner` (own / third_party) and `design_colors` (color family + role, e.g. teal / headline). **Never hex values** |
| `photo_style` | One phrase describing what the photos look like (lighting, setting, framing) |
| `content_language` | The captions' language (ISO code) |

- Every claim carries evidence. Quotes must be verbatim with a post id. Anything seen only in an image is marked `[image]`.

## 5. Website extraction — AI (text only)

- From the homepage text, the model returns:
  - brand name;
  - location, with how trustworthy its source is (structured data > contact field > about text > footer only);
  - a copyright or "last updated" date;
  - business profile;
  - the tone of the website copy (used only as a fallback when there are too few posts).
- It does not pick colors.

## 6. Measure brand colors — Code

Only `graphic_designed` images are measured. Photos never are, and photos with text overlays count as photos.

1. Graphics marked `third_party` (another business's poster) are skipped.
2. Each image is shrunk to 64 px. Pixel colors are rounded and counted.
3. Neutrals are set aside: whites, blacks, greys, and very pale or very dark tones.
4. Shades closer than 40 (RGB distance) are merged, and colors covering under 2% of the image are dropped.
5. **Only colors whose family the AI named for that image are kept** (step 4's `design_colors`), together with their role. This removes any photo pixels inside a graphic.
6. Across posts, colors are ranked by how many posts they appear in, then by pixel count.

## 7. Measure photo tones — Code

For every photo (`photographic` + `photo_with_overlay`), code measures:
- the average warmth (red minus blue), lightness and saturation;
- the bucket each falls into: warm / neutral / cool, dark / mid / bright, muted / moderate / vivid;
- recurring colors across photos.

## 8. Merge into one guideline — Code

For each field it picks a winner between the user's input, the posts and the website, and gives it a confidence level:

| Field | Rule |
|---|---|
| Brand name | User-entered = high. Posts and website agree = high. Posts capped at low with fewer than 2 distinct posts |
| Location | Address field = truth. Posts and website agree = at least medium. Posts capped at low with fewer than 2 distinct posts. Website weighed by source tier and staleness (`config/merge-weights.json`) |
| Business profile | Higher-confidence source wins (website on a tie). Offerings merged, max 6. Audience only at high/medium |
| Voice | Posts win at 10+ distinct posts. Below that, kept at low (`low_sample`). Website copy is the fallback, marked tentative |
| Pillars, hashtags | From posts |
| Color palette | Website CSS and graphics agree = high. They disagree = medium (conflict logged). Website only = medium. Graphics only = medium with 5+ graphics and the top color in 3+ of them. Anything lower is moved to `unconfirmed_colors` |

Conflicts are logged in `merge_meta`.

## 9. Brand colors + photo mood outputs — Code

Built from steps 6–8 only; nothing after this step changes them.

- **`brand_colors`:**
  - Confirmed only at high/medium confidence. At most 2 shades per color family, max 6 colors, each with its family and what it is used for.
  - Otherwise the list is empty and a reason is given.
- **`photo_mood`:**
  - Needs 6+ photos. A tone is stated only when 60% or more of the photos agree.
  - Recurring hues must appear in at least half the photos.
  - The AI's `photo_style` phrase is added only at high/medium confidence with 3+ supporting photos.
  - Otherwise `not_confirmed`, with a reason.

## 10. Validation — AI (captions + website text, no images)

- Fact-checks the merged guideline against the original captions and website text.
- Removes or softens claims it can't trace back to a source, fixes misquotes, and drops any audience that isn't stated outright.
- Never sees images: the request is a single text block, and each post's `image_url` is replaced by a `had_image: true/false` flag before the posts go into the prompt (`runValidationStage`). Its input is about 9,500 tokens, against about 24,000 for extraction, which carries the images.
- So it keeps `[image]` evidence unless a caption contradicts it. Counts cross-post copies as one.
- Returns `issues_found` and a `corrected_guideline`.

## 11. Protect brand name — Code

- Validation can lower the brand name's confidence but never replace it, because the name is often seen only on logos, which validation can't see.
- Any field validation dropped is restored from the merge.

## 12. Confidence gate — Code

This step decides what the paragraph is **allowed** to say:

- **High/medium:** used with specific detail.
- **Low:** used in broad terms only.
- **None:** dropped.
- **Location, brand name and audience:** only at high/medium.
- **Colors and evidence quotes:** always removed.
- The brief is renamed to describe the business: `known_for`, `offers`, `serves`, `voice`, `signature_hashtags`.
- **Detail level:** `general` (40–60 words, no named products, events or prices) when there are fewer than 6 distinct posts, or known-for or voice is not high/medium. Otherwise `specific` (60–90 words).

## 13. Compose paragraph — AI

- Writes one paragraph **from the brief only**, in the brand's voice and the content language, the way the brand would introduce itself.
- Never mentions posts, the account, the feed, followers, social media or "the tone is…". Never mentions colors. Never adds anything that isn't in the brief.

---

## Cost and time (20 posts, Haiku 5.5, no website)

| Stage | Share of cost |
|---|---|
| Social extraction | ~63% |
| Validation | ~31% |
| Compose | ~6% |

About **$0.012 and 60–90 s per run**. Most of the cost is output and thinking tokens, not images.

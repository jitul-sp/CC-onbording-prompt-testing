# Post data — sample files

Six files, each built to exercise a specific behavior described in the project spec (`brand-prompt-lab-FINAL-REQUIREMENTS.md`, section 10). Each entry below says what a **correct** composed paragraph should and shouldn't contain.

**A note on `image_url` values:** these are seed/offline sample files, so every `image_url` in this folder points at `media.example.com` (the IANA-reserved documentation domain) — none of them are real, fetchable images. That means every run against these files, not just file 06, will hit the "image fetch failed → continue with caption-only" path (section 6.2 of the spec). That's expected and harmless: it's exactly the fallback behavior the pipeline is supposed to have. To exercise the real vision path (an image actually reaching the model), replace an `image_url` with a real hosted link — e.g. your own Instagram CDN URL. File 06 is still the dedicated test for the failure path: it's structured with one clearly-labeled bad link (`p4-expired-signature-abc123.jpg`, styled after an expired signed URL) among otherwise normal posts, so you can point the run history / output panel at it and confirm exactly one failure is reported, not the whole batch.

## 1. `01_cafe_rich_highconfidence.json`
Rich, consistent data (10 posts) + a real `account_info.address`.

**Should:** name the neighborhood/city from the address with high confidence, describe a warm/casual, community-focused voice, and mention concrete themes actually in the captions (coffee, local art, patio, trivia nights, community board). No `mixed_voice`.
**Shouldn't:** hedge on location (the address is ground truth), invent products/services not mentioned in captions, or read as generic "great coffee, great vibes" copy with no specifics.

## 2. `02_newbiz_sparse_lowconfidence.json`
Only 3 posts, no address.

**Should:** trigger the low-post warning (1–4 posts), stay deliberately general/plain rather than overclaiming, and not assert a location at all (none is inferable from 3 posts with no repeated signal).
**Shouldn't:** claim high confidence about voice or themes from so little data, or invent a location.

## 3. `03_creator_no_accountinfo.json`
No `account_info` object at all — solo creator, first-person captions.

**Should:** run normally (missing `account_info` is optional by design, not an error), and reflect a first-person, casual/motivational voice grounded in the actual captions (home workouts, consistency, personal records).
**Shouldn't:** treat the missing `account_info` as an error or gap to apologize for, or invent a brand name / business framing that doesn't fit a solo creator.

## 4. `04_mixedvoice_inconsistent.json`
First 4 posts are formal/corporate-press-release tone; last 4 (later dates) are meme-casual.

**Should (extraction v1):** set `mixed_voice: true` and leave it unresolved.
**Should (extraction v2 → compose v2):** set `mixed_voice: true`, populate `recommended_primary_voice` with the more recent, attested tone (meme-casual — it's both the majority-adjacent and the most recent shift), and have the composed paragraph commit fully to that one voice rather than blending both.
**Shouldn't:** blend formal and meme-casual language in the same paragraph when using v2, or recommend a voice that isn't actually attested in the posts.

Use this file specifically to A/B `extraction v1` vs `v2` on mixed-voice handling.

## 5. `05_contentinferred_location.json`
No address. `#eastaustin` repeats across 4 posts (one signal *type*: hashtag); one separate caption explicitly names "East Austin" (a second, distinct signal type); one post is a one-off Dallas pop-up mention (outlier, different city).

**Should (extraction v2 → validation v2):** treat the hashtag + the explicit caption mention as two distinct signal types and accept "East Austin" with reasonable confidence, while excluding the Dallas mention as noise, not as evidence of a second location.
**Should (extraction v1):** may accept the location more loosely from the repeated hashtag alone, without reasoning about signal-type diversity.
**Shouldn't:** cite the Dallas post as location evidence, or (in v2) accept location confidence built from only one signal type no matter how many times it repeats.

Use this file specifically to A/B `extraction v1` vs `v2` on location corroboration.

## 6. `06_brokenimage_edgecase.json`
7 posts, address present, consistent diner/family-run voice. Post `p4`'s `image_url` is the intentionally-broken one (styled as an expired signed URL).

**Should:** complete the run normally, fall back to caption-only for `p4`, and report exactly one image failure (not seven) in the run log / output panel's per-image failure notes.
**Shouldn't:** abort the run, silently drop `p4`'s caption text along with its image, or report failures for posts other than `p4`.

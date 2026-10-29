# Brand Guideline Prompt Lab

A local tool for testing and iterating on prompts that turn Instagram/Facebook post data into a short brand-guideline paragraph (meant to pre-fill Content Canvas's input box). Full requirements: `brand-prompt-lab-FINAL-REQUIREMENTS.md`.

## Running it

```
npm install
npm start
```

Opens on `http://127.0.0.1:5175`. The server only binds to localhost — it holds your API key and has no auth layer.

## The 5-field guideline

Every run ultimately produces a guideline with exactly 5 fields: `content_pillars`, `voice_and_tone`, `hashtag_strategy`, `location`, `color_palette`. `content_pillars` and `hashtag_strategy` are social-only (carried straight from extraction). The other three are merged from social + website signals in `websiteMergePipeline.js`'s `mergeGuidelines()`, using a different mechanism per field rather than one uniform score:

- **voice_and_tone** — rule-based: real posting behavior (`posts_analyzed >= MIN_POST_THRESHOLD` and non-`none` confidence) always wins over a website copy-tone guess. Only when social data is too sparse does the website's tone get used, tagged `source: "website_fallback_tentative"` so compose never presents it as observed behavior.
- **location** — score-based, but on provenance + recency rather than raw confidence: website signals are weighted by how structurally reliable their source was (`structured_data` > `platform_maintained_field` > `freeform_about_text` > `footer_or_copyright_only`) and penalized if stale; social signals are weighted by corroboration (`corroborated_2plus` > `single_mention`). Weights live in `config/merge-weights.json`. `account_info.address`, when present, always short-circuits this as ground truth.
- **color_palette** — never asked of the LLM directly (naming colors is a perception guess, not a measurement). Extraction only classifies each post's image as `photographic` or `graphic_designed`; `websiteMergePipeline.js` then runs real color quantization (via `sharp`) on `graphic_designed` posts only, and separately parses the site's linked stylesheets for color declarations. The two are combined when they agree, reconciled by recency when they conflict, and photography-only tones are reported separately as `photography_mood_colors` — never folded into `hex_colors` as if they were a real brand choice.

## The 4 prompt roles

| Role | What it does | Output |
|---|---|---|
| **extraction** | Reads raw social posts (+ images, + account info) and pulls out social-only signals: content pillars, voice/tone, hashtag strategy, a location signal, and per-image `photographic`/`graphic_designed` classification. | JSON |
| **website_extraction** | Reads the account's website (`account_info.website`) and pulls out a location signal (with provenance + staleness) plus a copy-tone reading, and reports on app-supplied CSS colors. Skipped gracefully whenever no website URL is present. | JSON |
| **validation** | Fact-checks the *merged* guideline (social + website) against the source posts and website text, corrects unsupported claims. | JSON (`corrected_guideline`) |
| **compose** | Writes the final plain-language paragraph from the validated guideline. | Plain text paragraph — **this is the actual deliverable** |

## How a "Run" actually works

The UI only asks you to pick **one** role and **one** version at a time — but validation and compose each need earlier stages' output to run at all. So a single Run does different amounts of work depending on which role you pick:

- **Run extraction** → runs just that one social-extraction call. You see its raw JSON.
- **Run website_extraction** → runs just that one website call against `account_info.website` from the selected post-data file (or reports a graceful skip if that field is absent). You see its raw JSON.
- **Run validation** → the server auto-runs the **latest** extraction, then (if a website URL is present and a `website_extraction` version exists) the **latest** website_extraction, computes the color sub-pipeline, merges everything via `mergeGuidelines()`, then runs your selected validation version against that merged guideline. You see validation's JSON.
- **Run compose** → the server does everything validation does, using the **latest** validation version, then runs your selected compose version. You see the final paragraph.

In other words: picking **compose** and hitting Run tests the whole pipeline end-to-end in one click. Picking an earlier role lets you inspect that stage in isolation, but still silently completes whatever comes *before* it using the latest version of each earlier role — not necessarily the version you're actively drafting.

**Practical implication:** if you're trying to see how an extraction change affects the final paragraph, make sure your edited extraction version is the highest version number for that role (or delete/supersede older ones) — otherwise a compose run will keep using whichever extraction version is currently "latest," not the one you just tweaked. Every run's full input/output (including which upstream versions were auto-used, the merged guideline, and any logged `meta.conflicts`, under `pipeline` in the log entry) is recorded in `Run logs/runs.jsonl`, so you can always check exactly what fed into a given result.

This auto-chaining isn't in the original requirements doc — it's a design decision made to reconcile "the UI has one role/version selector" with "validation and compose need upstream output to run." If you'd rather explicitly choose which extraction/validation version feeds a given compose test (instead of always defaulting to latest), that's a reasonable change to ask for.

## Role & version rules (section 5 of the requirements doc)

- **Role** = a category/folder (`extraction`, `validation`, `compose`, or any custom one you add). Its `id` is permanent once created — only `label`/`description` can be edited afterward.
- **Version** = one file inside a role's folder (`v1.json`, `v2.json`, ...). Editing a version overwrites its `system_prompt`/`user_template` in place; "Save as new version" duplicates it into a new file instead, leaving the original untouched.
- Deleting a role only works if it has no versions, unless you confirm a cascade delete.
- Deleting or editing a prompt version never breaks past run history — every run log entry stores its own frozen copy of the exact prompt text that was actually sent (`input_snapshot`), independent of whatever the saved prompt file looks like now.

## Seed content

`Saved prompts/` ships two versions of extraction, validation, and compose (v1 baseline, v2 tightened — see each file's `notes` field for the changelog) and one version of `website_extraction` (new role, no prior version to tighten yet). `Post data/` ships six sample files built to exercise specific edge cases — see `Post data/README.md` for what each one tests and what a correct paragraph should/shouldn't contain. Two of them (`01_cafe_rich_highconfidence.json`, `06_brokenimage_edgecase.json`) include an `account_info.website` field, so they're the ones that exercise the website-merge path; the rest exercise the "no website" graceful-skip path.

## Merge weights

`config/merge-weights.json` holds the tunable weights `mergeGuidelines()` uses for the score-based fields (`location`): `provenance_weights` (per website signal-source tier), `staleness_penalty` (applied when a website's `staleness_signal.is_stale` is true), `corroboration_weights` (per social signal-strength tier), and `tie_break_winner`. Edit it directly — like the prompt files, it's a real file on disk, not a hardcoded constant.

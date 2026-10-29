# Brand Guideline Prompt Lab — Final Project Requirements

Single source of truth for building this tool. This supersedes all earlier draft specs from this conversation — anything here is final; anything not repeated here should be treated as superseded.

## 1. Purpose

A local tool for testing and iterating on prompts that generate a brand-guideline **paragraph** from Instagram/Facebook post data. The end deliverable of every run is a short plain-language paragraph meant to pre-fill Content Canvas's existing input box — that paragraph's quality is what this whole tool exists to let you evaluate.

Post data is supplied manually as JSON files (not live-fetched from platform APIs). Images are supplied as links in that JSON and must be fetched and resized before being sent to the model.

## 2. Runtime & stack

- Runs entirely locally: Node.js (v18+) + Express backend, a single-page vanilla HTML/CSS/JS frontend, no build step.
- Real folders on disk — not a database — so prompts and post data stay easy to inspect/edit/version outside the tool (e.g. in a code editor or git).
- Image resizing via `sharp`. Anthropic API calls via native `fetch`.
- Model and temperature are chosen in the UI at run time, from an editable config file — never hardcoded as fixed values in server logic.
- Anthropic API key is entered in the UI and, if "remember" is checked, persisted locally on the machine — never in code or committed to git.

## 3. Folder structure

```
brand-prompt-lab/
├── server.js
├── package.json
├── .gitignore                      # excludes config/local-secrets.json
├── config/
│   ├── local-secrets.json          # gitignored — remembered API key
│   └── models.json                 # editable list of selectable models
├── Post data/                      # JSON post-data files
│   ├── 01_cafe_rich_highconfidence.json
│   ├── 02_newbiz_sparse_lowconfidence.json
│   ├── 03_creator_no_accountinfo.json
│   ├── 04_mixedvoice_inconsistent.json
│   ├── 05_contentinferred_location.json
│   ├── 06_brokenimage_edgecase.json
│   └── README.md                   # what each sample tests, expected output
├── Saved prompts/
│   ├── roles.json                  # manifest of role categories
│   ├── extraction/
│   │   ├── v1.json
│   │   └── v2.json
│   ├── validation/
│   │   ├── v1.json
│   │   └── v2.json
│   └── compose/
│       ├── v1.json
│       └── v2.json
├── Run logs/
│   └── runs.jsonl                  # append-only log of every run
└── public/
    ├── index.html
    ├── app.js
    └── styles.css
```

All seven `Saved prompts` files and all seven `Post data` files (six samples + README) are provided as ready-to-use seed content — see sections 9 and 10.

## 4. Data schemas

### 4.1 Post data JSON (one file per account)

```json
{
  "account_info": {
    "handle": "@brewhouse_atx",
    "platform": "instagram",
    "bio_description": "Coffee & community since 2019.",
    "address": "1400 S Congress Ave, Austin, TX",
    "website": "https://brewhouseatx.com"
  },
  "posts": [
    {
      "post_id": "p1",
      "date": "2026-07-14",
      "caption_text": "the actual caption as posted",
      "hashtags": ["#brewhouseatx", "#atxcoffee"],
      "image_url": "https://.../p1.jpg"
    }
  ]
}
```

- `account_info` is entirely optional — the object or any field within it may be omitted.
- `hashtags` is optional per post, defaults to `[]`.
- `image_url` is optional per post — text-only posts are valid.
- Expect up to 10 posts per file; fewer must be handled gracefully (section 8).
- `date` is optional but recommended — helps the prompt reason about recency and voice drift.

### 4.2 Prompt file (one JSON file per version)

```json
{
  "id": "extraction-v2",
  "role": "extraction",
  "version": 2,
  "name": "Extraction v2 - stricter location + voice recommendation",
  "system_prompt": "...",
  "user_template": "...",
  "created_at": "2026-09-08T00:00:00Z",
  "notes": "changelog note describing what changed vs the previous version"
}
```

`user_template` contains placeholders (e.g. `{{ACCOUNT_INFO_JSON}}`, `{{POSTS_BLOCK}}`) resolved server-side at run time — see section 7.

### 4.3 Roles manifest (`Saved prompts/roles.json`)

```json
[
  { "id": "extraction", "label": "Extraction", "description": "Extracts structured brand guideline JSON from posts" },
  { "id": "validation", "label": "Validation", "description": "Fact-checks the extraction output against source posts" },
  { "id": "compose", "label": "Compose Paragraph", "description": "Writes the final plain-language paragraph for the input box" }
]
```

### 4.4 Run log entry (`Run logs/runs.jsonl`, one JSON object per line)

```json
{
  "run_id": "uuid",
  "timestamp": "2026-09-08T10:04:00Z",
  "post_data_file": "01_cafe_rich_highconfidence.json",
  "prompt_role": "compose",
  "prompt_version": 2,
  "model": "claude-sonnet-4-6",
  "temperature": 0.4,
  "posts_count": 10,
  "low_post_warning": false,
  "images_fetched": 10,
  "images_failed": 0,
  "input_snapshot": { "system_prompt": "...", "user_text": "..." },
  "output_raw": "...",
  "output_parsed": null,
  "latency_ms": 3120,
  "usage": { "input_tokens": 1840, "output_tokens": 96 },
  "error": null
}
```

- JSONL format so runs append without rewriting the file.
- Never log the raw API key. Never log full base64 image payloads — reference post_ids and per-image success/failure instead.
- `input_snapshot` stores the fully resolved prompt text actually sent — this is what makes a run's history self-contained even after the source prompt version is later edited or deleted.

## 5. Role & version model

Two distinct levels, each with different mutability:

| Level | What it is | Editable | Stable |
|---|---|---|---|
| **Role** | A category/folder (e.g. "extraction") | `label`, `description` in `roles.json` | `id` / folder name — never changes once created |
| **Version** | One file inside a role folder (e.g. `v2.json`) | Full content: `system_prompt`, `user_template` | The `role` + `version` number |

Actions:

| Action | Role level | Version level |
|---|---|---|
| Add | New folder + entry in `roles.json` | New file, version auto-incremented |
| Edit | Rename label/description only | Overwrite `system_prompt`/`user_template` in place |
| Save as new | — | Duplicates current content into a new version file; original untouched |
| Delete | Only if folder is empty, or with a cascade confirmation | Deletes just that one file |

Deleting or editing a prompt version never breaks the ability to read a past run's full detail, since every run log stores its own frozen copy of the exact text used (see 4.4).

## 6. Image handling pipeline

1. Fetch each `image_url` server-side (avoids browser CORS issues with CDN links).
2. On fetch failure (404, timeout, expired signed URL) — skip that image, continue the run using caption-only for that post, record the failure in the run log. Never abort the whole run over one broken link.
3. On success, use `sharp` to normalize:
   - Convert to JPEG.
   - Cap the longest edge at ~1568px before compressing further (Anthropic's vision cost/quality guidance).
   - Iteratively lower JPEG quality (start ~85, step down by 10) until under ~1MB or a quality floor (~40) is hit, whichever comes first.
4. Base64-encode for the API call. Don't persist resized images to disk by default; optionally support a `debug: true` flag that saves them to a temp folder for visual inspection.

## 7. Placeholder resolution (server-side, at run time)

| Placeholder | Resolved from |
|---|---|
| `{{MIN_POST_THRESHOLD}}` | Configurable, default `10` |
| `{{ACCOUNT_INFO_JSON}}` | `account_info` from the selected file, or `"none provided"` |
| `{{POST_COUNT}}` | `posts.length` |
| `{{POSTS_BLOCK}}` | Generated per post: `--- Post {{post_id}} ---`, date, caption, hashtags, then the resized image attached inline if present |
| `{{POSTS_JSON}}` (validation) | The same posts array sent to extraction |
| `{{STAGE_1_OUTPUT_JSON}}` (validation) | Raw extraction output |
| `{{VALIDATED_GUIDELINE_JSON}}` (compose) | Validation's `corrected_guideline` |
| `{{RESOLVED_LOCATION}}` (compose) | `account_info.address` if present, else `location_inference.guessed_locality` if its confidence isn't `"none"`, else `null` |

## 8. Low post availability & edge cases

| Condition | Behavior |
|---|---|
| `posts` is empty | Block the run: "No posts in this file — add at least one post to run a prompt." |
| 1-4 posts | Allow the run; show a non-dismissible warning banner; log `low_post_warning: true`. |
| 5-9 posts | Allow the run; lighter advisory note; still log the flag. |
| 10 posts | Normal run, no warning. |
| `account_info` missing | Proceed normally — optional by design. |
| An `image_url` fails | Skip that image, continue with caption-only, note the failure in the run log and a small inline note in the output panel. |
| Image already under ~1MB | Skip resizing, pass through re-encoded to base64. |
| Model output isn't valid JSON (extraction/validation roles) | Don't crash — log the raw text as `error` context and display it in the output panel. |
| API call fails (bad key, rate limit, network) | Show the error clearly, log it, don't silently retry more than once. |
| Mixed voice across posts | Extraction v2 / validation v2 / compose v2 handle this explicitly via `recommended_primary_voice` (see section 9) — v1 only flags `mixed_voice: true` without resolving it. |
| Location signal is thin or repeats one source only | Extraction v2 / validation v2 require 2+ independent signal *types*, not just 2 mentions of the same hashtag — v1 only requires 2 posts regardless of signal type. |

## 9. Seed prompts shipped with this spec

Two versions per role, ready to drop into `Saved prompts/`:

- **extraction v1 / v2** — v2 tightens location corroboration (requires 2+ distinct signal types, not just repeated mentions of the same hashtag) and adds a `recommended_primary_voice` field to resolve `mixed_voice` cases instead of just flagging them.
- **validation v1 / v2** — v2 adds matching checks: confirms location evidence uses diverse signal types, and confirms `recommended_primary_voice` is present and supported whenever `mixed_voice` is true.
- **compose v1 / v2** — v2 targets a shorter paragraph (50-80 words vs. 2-4 open-ended sentences) and explicitly writes in whichever voice `recommended_primary_voice` specifies rather than blending tones.

v2 across all three roles is designed to be used together — `compose v2` depends on the `recommended_primary_voice` field that only `extraction v2` produces. Mixing `extraction v1` with `compose v2` will just leave that instruction unused, not break anything.

Use `04_mixedvoice_inconsistent.json` and `05_contentinferred_location.json` (section 10) specifically to A/B v1 vs v2 on the two problems v2 was built to address.

## 10. Seed post data shipped with this spec

Six sample files in `Post data/`, each targeting a specific behavior, with a README documenting what a *correct* paragraph output should and shouldn't contain for each:

1. Rich, consistent data + address → tests a clean high-confidence paragraph.
2. Sparse data (3 posts), no address → tests graceful low-confidence degradation.
3. No `account_info` at all, solo creator → tests optional account info + first-person voice.
4. Inconsistent tone (formal ↔ meme-casual) → tests `mixed_voice` handling.
5. No address, location only inferable from repeated content signals, plus a one-off outlier mention → tests corroboration logic specifically.
6. One broken `image_url` among otherwise normal posts → tests the image-fetch failure path.

## 11. UI requirements

Single page, three areas:

1. **Run configuration** — Post Data file dropdown; Role → Version dropdown with Add/Edit/"Save as new"/Delete actions for both roles and versions; Model dropdown (from `config/models.json`); Temperature input; API key field with "remember on this machine" checkbox; low-post/missing-data warning banner; Run button.
2. **Output panel** — the composed paragraph front and center (this is the primary artifact being tested); collapsible raw model output; pretty-printed JSON when applicable (extraction/validation roles); latency + token usage; any per-image fetch failures called out.
3. **Run history** — table of past runs (timestamp, post-data file, role/version, model, temperature, latency), filterable by role and by post-data file, expandable to full input/output detail per run.

## 12. API endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/post-data` | List files in `Post data/` |
| GET | `/api/post-data/:filename` | Get one file's contents |
| GET | `/api/roles` | List roles |
| POST | `/api/roles` | Add a role |
| PUT | `/api/roles/:id` | Edit label/description |
| DELETE | `/api/roles/:id` | Delete (with confirmation if non-empty) |
| GET | `/api/prompts/:role` | List versions for a role |
| GET | `/api/prompts/:role/:version` | Get one version |
| POST | `/api/prompts/:role` | Add a new version |
| PUT | `/api/prompts/:role/:version` | Overwrite an existing version |
| DELETE | `/api/prompts/:role/:version` | Delete a version |
| GET | `/api/models` | List selectable models |
| GET | `/api/key/status` | Whether a key is remembered (never returns the raw key) |
| POST | `/api/key` | Save or clear the remembered key |
| POST | `/api/run` | Execute a run end-to-end and log it |
| GET | `/api/logs` | List run log entries (paginated, most recent first) |
| GET | `/api/logs/:run_id` | Full detail for one run |

## 13. Security

- `config/local-secrets.json` is in `.gitignore` from project init.
- The API key never appears in a run log, console output, or error message.
- Server binds to `127.0.0.1` only — this holds a live API key and has no auth layer, so it must not be exposed on a network interface.

## 14. Acceptance checklist

- [ ] Add/edit/delete a role; changes reflect immediately in the prompt dropdown
- [ ] Add/edit/"save as new"/delete a prompt version within a role
- [ ] Selecting a post-data file shows post count and whether `account_info` is present, before running
- [ ] File 02 (sparse) triggers the low-post warning and still completes
- [ ] File 06 (broken image) completes, uses caption-only for that post, reports the failure
- [ ] File 04 (mixed voice) with `extraction v1` shows `mixed_voice: true` with no resolution; with `extraction v2` also shows a populated, supported `recommended_primary_voice`
- [ ] File 05 (content-inferred location) with `extraction v1` may accept weaker location evidence; with `extraction v2` correctly excludes the Miami outlier and requires signal-type diversity
- [ ] Model and temperature changes require no code change — only editing `config/models.json`
- [ ] API key persists across a server restart when "remember" was checked, and never appears in git-tracked files
- [ ] Every run appears in `Run logs/runs.jsonl`, viewable in Run History with full input/output detail
- [ ] Malformed model output (bad JSON) displays and logs rather than crashing

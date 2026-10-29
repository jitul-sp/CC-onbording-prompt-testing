const state = {
  postDataFiles: [],
  currentPostData: null,
  roles: [],
  currentRoleId: null,
  versions: [],
  currentVersion: null,
  historyPage: 1,
  lastEntry: null,
};

async function api(path, opts) {
  const res = await fetch(path, {
    ...opts,
    headers: { 'content-type': 'application/json', ...(opts && opts.headers) },
  });
  let body = null;
  try {
    body = await res.json();
  } catch {
    // no body
  }
  if (!res.ok) {
    const message = (body && body.error) || `Request failed (${res.status})`;
    const err = new Error(message);
    err.body = body;
    throw err;
  }
  return body;
}

function el(id) {
  return document.getElementById(id);
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// ---------- post data ----------

async function loadPostDataFiles() {
  state.postDataFiles = await api('/api/post-data');
  const sel = el('postDataSelect');
  sel.innerHTML = state.postDataFiles.map((f) => `<option value="${escapeHtml(f)}">${escapeHtml(f)}</option>`).join('');
  const fileFilter = el('historyFileFilter');
  fileFilter.innerHTML = '<option value="">All files</option>' + state.postDataFiles.map((f) => `<option value="${escapeHtml(f)}">${escapeHtml(f)}</option>`).join('');
  if (state.postDataFiles.length > 0) {
    sel.value = state.postDataFiles[0];
    await onPostDataChange();
  }
}

async function onPostDataChange() {
  const filename = el('postDataSelect').value;
  if (!filename) return;
  state.currentPostData = await api(`/api/post-data/${encodeURIComponent(filename)}`);
  const posts = state.currentPostData.posts || [];
  const hasAccountInfo = !!(state.currentPostData.account_info && Object.keys(state.currentPostData.account_info).length > 0);
  const source = state.currentPostData.source;
  const csvNote = source && source.format === 'csv' ? ` (CSV, one post per row - cross-posts are grouped by the extraction prompt)` : '';
  el('postDataMeta').textContent = `${posts.length} post(s) available${csvNote} - account info ${hasAccountInfo ? 'present' : 'not provided'}`;
  const accounts = state.currentPostData.accounts || [];
  el('accountField').hidden = accounts.length === 0;
  el('accountSelect').innerHTML = accounts
    .map((a) => {
      const label = a.brand_name || a.business_type
        ? [a.brand_name || 'unnamed', a.business_type, a.locality].filter(Boolean).join(' · ')
        : (a.top_hashtags.length ? a.top_hashtags.join(' ') : 'unlabelled');
      return `<option value="${escapeHtml(a.account_id)}">${escapeHtml(`${label} (${a.platform}, ${a.posts} posts, id ${a.account_id})`)}</option>`;
    })
    .join('') + `<option value="">All accounts (${posts.length} posts)</option>`;
  onAccountChange();
}

function selectedAccountPosts() {
  const posts = (state.currentPostData && state.currentPostData.posts) || [];
  const accountId = el('accountSelect').value;
  return accountId ? posts.filter((p) => p.account_id === accountId) : posts;
}

function onAccountChange() {
  // a typed name/website belongs to the account it was typed for
  el('brandNameInput').value = '';
  el('websiteInput').value = '';
  el('postLimitInput').max = String(selectedAccountPosts().length);
  updatePostCountWarning();
}

function selectedPostCount() {
  const available = selectedAccountPosts().length;
  const limit = parseInt(el('postLimitInput').value, 10);
  return Number.isInteger(limit) && limit > 0 ? Math.min(limit, available) : available;
}

function updatePostCountWarning() {
  const count = selectedPostCount();
  const warningEl = el('lowPostWarning');
  if (count === 0) {
    warningEl.hidden = false;
    warningEl.textContent = 'No posts in this file - add at least one post to run a prompt.';
    warningEl.classList.add('severe');
  } else if (count < 5) {
    warningEl.hidden = false;
    warningEl.classList.add('severe');
    warningEl.textContent = `Only ${count} post(s) - extraction confidence will be low.`;
  } else if (count < 10) {
    warningEl.hidden = false;
    warningEl.classList.remove('severe');
    warningEl.textContent = `${count} post(s) - below the recommended minimum of 10; results may be less reliable.`;
  } else {
    warningEl.hidden = true;
  }
}

// ---------- roles ----------

async function loadRoles() {
  state.roles = await api('/api/roles');
  const sel = el('roleSelect');
  sel.innerHTML = state.roles.map((r) => `<option value="${escapeHtml(r.id)}">${escapeHtml(r.label)}</option>`).join('');
  const roleFilter = el('historyRoleFilter');
  roleFilter.innerHTML = '<option value="">All roles</option>' + state.roles.map((r) => `<option value="${escapeHtml(r.id)}">${escapeHtml(r.label)}</option>`).join('');
  if (state.roles.length > 0) {
    sel.value = state.currentRoleId && state.roles.some((r) => r.id === state.currentRoleId) ? state.currentRoleId : state.roles[0].id;
    await onRoleChange();
  }
}

async function onRoleChange() {
  state.currentRoleId = el('roleSelect').value;
  await loadVersions(state.currentRoleId);
}

async function loadVersions(role) {
  state.versions = await api(`/api/prompts/${encodeURIComponent(role)}`);
  const sel = el('versionSelect');
  sel.innerHTML = state.versions.map((v) => `<option value="${v.version}">v${v.version} - ${escapeHtml(v.name)}</option>`).join('');
  if (state.versions.length > 0) {
    sel.value = String(state.versions[state.versions.length - 1].version);
    onVersionChange();
  } else {
    state.currentVersion = null;
    populateEditor(null);
  }
}

function onVersionChange() {
  const version = Number(el('versionSelect').value);
  state.currentVersion = state.versions.find((v) => v.version === version) || null;
  populateEditor(state.currentVersion);
}

function populateEditor(version) {
  el('promptName').value = version ? version.name : '';
  el('promptSystem').value = version ? version.system_prompt : '';
  el('promptUser').value = version ? version.user_template : '';
  el('promptNotes').value = version ? version.notes || '' : '';
}

async function addRole() {
  const id = prompt('New role id (lowercase, letters/digits/hyphen/underscore only - this is permanent):');
  if (!id) return;
  const label = prompt('Label:', id) || id;
  const description = prompt('Description:', '') || '';
  try {
    await api('/api/roles', { method: 'POST', body: JSON.stringify({ id, label, description }) });
    await loadRoles();
    el('roleSelect').value = id;
    await onRoleChange();
  } catch (err) {
    alert(err.message);
  }
}

async function editRole() {
  const role = state.roles.find((r) => r.id === state.currentRoleId);
  if (!role) return;
  const label = prompt('Label:', role.label);
  if (label === null) return;
  const description = prompt('Description:', role.description || '');
  if (description === null) return;
  await api(`/api/roles/${encodeURIComponent(role.id)}`, { method: 'PUT', body: JSON.stringify({ label, description }) });
  await loadRoles();
  el('roleSelect').value = role.id;
}

async function deleteRole() {
  const role = state.roles.find((r) => r.id === state.currentRoleId);
  if (!role) return;
  if (!confirm(`Delete role "${role.label}"? This only works if it has no versions, unless you confirm cascade delete.`)) return;
  try {
    await api(`/api/roles/${encodeURIComponent(role.id)}`, { method: 'DELETE' });
  } catch (err) {
    if (err.body && err.body.versionCount !== undefined) {
      if (confirm(`${err.message}\n\nDelete anyway (cascade)?`)) {
        await api(`/api/roles/${encodeURIComponent(role.id)}?cascade=true`, { method: 'DELETE' });
      } else {
        return;
      }
    } else {
      alert(err.message);
      return;
    }
  }
  state.currentRoleId = null;
  await loadRoles();
}

// ---------- versions ----------

function newVersion() {
  state.currentVersion = null;
  populateEditor(null);
}

async function saveVersion() {
  if (!state.currentVersion) {
    alert('No version selected to overwrite. Use "Save as new version" to create one.');
    return;
  }
  const body = {
    name: el('promptName').value,
    system_prompt: el('promptSystem').value,
    user_template: el('promptUser').value,
    notes: el('promptNotes').value,
  };
  await api(`/api/prompts/${encodeURIComponent(state.currentRoleId)}/${state.currentVersion.version}`, { method: 'PUT', body: JSON.stringify(body) });
  await loadVersions(state.currentRoleId);
  el('versionSelect').value = String(state.currentVersion.version);
  onVersionChange();
}

async function saveAsNew() {
  const body = {
    name: el('promptName').value || `${state.currentRoleId} new version`,
    system_prompt: el('promptSystem').value,
    user_template: el('promptUser').value,
    notes: el('promptNotes').value,
  };
  if (!body.system_prompt || !body.user_template) {
    alert('System prompt and user template are required.');
    return;
  }
  const created = await api(`/api/prompts/${encodeURIComponent(state.currentRoleId)}`, { method: 'POST', body: JSON.stringify(body) });
  await loadVersions(state.currentRoleId);
  el('versionSelect').value = String(created.version);
  onVersionChange();
}

async function deleteVersion() {
  if (!state.currentVersion) return;
  if (!confirm(`Delete v${state.currentVersion.version}?`)) return;
  await api(`/api/prompts/${encodeURIComponent(state.currentRoleId)}/${state.currentVersion.version}`, { method: 'DELETE' });
  await loadVersions(state.currentRoleId);
}

// ---------- models ----------

async function loadModels() {
  const models = await api('/api/models');
  el('modelSelect').innerHTML = models.map((m) => `<option value="${escapeHtml(m.id)}">${escapeHtml(m.label)}</option>`).join('');
}

// ---------- api key ----------

async function loadKeyStatus() {
  const status = await api('/api/key/status');
  el('keyStatus').textContent = status.active
    ? (status.remembered ? 'Key active (remembered on this machine)' : 'Key active (not persisted)')
    : 'No key set';
}

async function saveKey() {
  const apiKey = el('apiKeyInput').value.trim();
  if (!apiKey) {
    alert('Enter an API key first.');
    return;
  }
  const remember = el('rememberKey').checked;
  await api('/api/key', { method: 'POST', body: JSON.stringify({ apiKey, remember }) });
  el('apiKeyInput').value = '';
  await loadKeyStatus();
}

async function clearKey() {
  await api('/api/key', { method: 'POST', body: JSON.stringify({ apiKey: null }) });
  el('apiKeyInput').value = '';
  await loadKeyStatus();
}

// ---------- run ----------

async function runPrompt() {
  const runBtn = el('runBtn');
  const statusEl = el('runStatus');
  if (!state.currentVersion) {
    alert('Select a prompt version to run.');
    return;
  }
  runBtn.disabled = true;
  statusEl.textContent = 'Running...';
  try {
    const entry = await api('/api/run', {
      method: 'POST',
      body: JSON.stringify({
        post_data_file: el('postDataSelect').value,
        role: state.currentRoleId,
        version: state.currentVersion.version,
        model: el('modelSelect').value,
        effort: el('effortSelect').value,
        post_limit: el('postLimitInput').value === '' ? null : Number(el('postLimitInput').value),
        account_id: el('accountSelect').value || null,
        brand_name: el('brandNameInput').value.trim() || null,
        website: el('websiteInput').value.trim() || null,
        debug: el('debugCheckbox').checked,
      }),
    });
    renderOutput(entry);
    statusEl.textContent = '';
    await loadHistory();
  } catch (err) {
    statusEl.textContent = '';
    alert(err.message);
  } finally {
    runBtn.disabled = false;
  }
}

function renderOutput(entry) {
  state.lastEntry = entry;
  el('viewRunInputsBtn').hidden = !(entry.inputs && entry.inputs.length);
  el('outputEmpty').hidden = true;
  el('outputContent').hidden = false;

  const paragraphEl = el('outputParagraph');
  const jsonEl = el('outputJson');
  const errorEl = el('outputError');

  paragraphEl.hidden = true;
  jsonEl.hidden = true;
  errorEl.hidden = true;

  const colorsHtml = brandColorsHtml(entry.brand_colors) + photoMoodHtml(entry.photo_mood);
  el('outputColors').hidden = !colorsHtml;
  el('outputColors').innerHTML = colorsHtml;

  if (entry.prompt_role === 'compose' && entry.output_raw) {
    paragraphEl.hidden = false;
    paragraphEl.textContent = entry.output_raw;
  } else if (entry.output_parsed) {
    jsonEl.hidden = false;
    jsonEl.textContent = JSON.stringify(entry.output_parsed, null, 2);
  }

  if (entry.error) {
    errorEl.hidden = false;
    errorEl.textContent = entry.error;
  }

  el('outputLatency').textContent = entry.latency_ms ? `Latency: ${entry.latency_ms} ms` : '';
  const stages = entry.usage_by_stage
    ? Object.entries(entry.usage_by_stage).filter(([, u]) => u)
      .map(([name, u]) => `${name} ${u.input_tokens} in / ${u.output_tokens} out${u.thinking_tokens ? ` (${u.thinking_tokens} thinking)` : ''}`)
    : entry.usage ? [`${entry.usage.input_tokens} in / ${entry.usage.output_tokens} out`] : [];
  const cost = typeof entry.cost_usd === 'number' ? ` · est. cost $${entry.cost_usd.toFixed(4)}` : '';
  el('outputUsage').textContent = stages.length ? `Tokens: ${stages.join(' · ')}${cost}` : cost;

  const failuresEl = el('imageFailures');
  const notes = entry.image_notes || [];
  if (notes.length > 0) {
    failuresEl.hidden = false;
    failuresEl.innerHTML = `<strong>Image fetch failures (${notes.length}):</strong><ul>${notes.map((n) => `<li>${escapeHtml(n.post_id)}: ${escapeHtml(n.error)}</li>`).join('')}</ul>`;
  } else {
    failuresEl.hidden = true;
  }

  el('outputRaw').textContent = entry.output_raw || '';
  const stagesHtml = renderStages(entry);
  el('outputStages').hidden = !stagesHtml;
  el('outputStages').innerHTML = stagesHtml ? `<h3>Pipeline stages</h3>${stagesHtml}` : '';
}

// ---------- pipeline stages ----------

const isPlainObject = (v) => v && typeof v === 'object' && !Array.isArray(v);

function confidenceBadge(confidence) {
  if (!confidence) return '';
  const cls = confidence === 'high' ? 'good' : confidence === 'medium' ? 'mid' : 'bad';
  return `<span class="badge ${cls}">${escapeHtml(confidence)}</span>`;
}

function listHtml(items) {
  const list = (items || []).filter((i) => i !== null && i !== undefined && i !== '');
  return list.length ? `<ul class="tight">${list.map((i) => `<li>${escapeHtml(typeof i === 'string' ? i : JSON.stringify(i))}</li>`).join('')}</ul>` : '';
}

function swatches(colors) {
  return (colors || []).map((c) => {
    const hex = typeof c === 'string' ? c : c.color;
    const parts = typeof c === 'string' ? [] : [
      c.family,
      (c.used_for || c.roles || []).join('/'),
      typeof c.posts === 'number' ? `${c.posts} post${c.posts === 1 ? '' : 's'}` : '',
    ].filter(Boolean);
    const note = parts.length ? ` · ${parts.join(' · ')}` : '';
    return `<span class="swatch"><i style="background:${escapeHtml(hex)}"></i>${escapeHtml(hex)}${escapeHtml(note)}</span>`;
  }).join(' ');
}

const COLOR_BASIS_LABELS = {
  'website_css+designed_posts_corroborated': 'website and designed posts agree',
  designed_posts_preferred_recency: 'from designed posts (website differs)',
  website_css_preferred_freshness: 'from the website (designed posts differ)',
  website_css_only: 'from the website',
  designed_posts_only: 'from designed posts',
};

/** The palette handed to content generation alongside the paragraph (confirmed colors only). */
function brandColorsHtml(bc) {
  if (!bc) return '';
  if (bc.status === 'confirmed') {
    return `<h3>Brand colors</h3><div>${swatches(bc.colors)}</div>
      <p class="meta-line">${escapeHtml(bc.confidence)} confidence · ${escapeHtml(COLOR_BASIS_LABELS[bc.basis] || bc.basis || '')} · most consistently used first</p>`;
  }
  return `<h3>Brand colors</h3><p class="meta-line">Not confirmed: ${escapeHtml(bc.reason || 'not enough evidence')}. No colors are given rather than a guess.</p>`;
}

/** What the brand's photos look like - for generating or choosing images, never a brand palette. */
function photoMoodHtml(pm) {
  if (!pm) return '';
  if (pm.status !== 'confirmed') {
    return `<h3>Photo mood</h3><p class="meta-line">Not confirmed: ${escapeHtml(pm.reason || 'not enough evidence')}.</p>`;
  }
  const tones = Object.entries(pm.tones || {}).map(([k, v]) => `${escapeHtml(v)} ${escapeHtml(k === 'warmth' ? 'tones' : k)}`).join(', ');
  return `<h3>Photo mood</h3>
    ${pm.style ? `<p>${escapeHtml(pm.style)}</p>` : ''}
    ${tones ? `<p class="meta-line">Measured: ${tones}</p>` : ''}
    ${(pm.recurring_colors || []).length ? `<div>${swatches(pm.recurring_colors)}</div>` : ''}
    <p class="meta-line">From ${pm.photos_measured} photos · for imagery, not a brand palette</p>`;
}

function rawJson(label, value) {
  if (value === undefined || value === null) return '';
  return `<details class="raw-json"><summary>${escapeHtml(label)}</summary><pre>${escapeHtml(typeof value === 'string' ? value : JSON.stringify(value, null, 2))}</pre></details>`;
}

function usageLine(u) {
  if (!u) return '';
  return `${u.input_tokens} in / ${u.output_tokens} out${u.thinking_tokens ? ` (${u.thinking_tokens} thinking)` : ''}`;
}

const FIELD_KEYS = {
  'Brand name': 'brand_name', 'What it is & offers': 'business_profile', 'Content pillars': 'content_pillars', 'Voice & tone': 'voice_and_tone',
  Hashtags: 'hashtag_strategy', Location: 'location', Colors: 'color_palette',
};

/** One row per guideline field: value, confidence, and (optionally) whether it changed vs `before`. */
function guidelineTable(g, before) {
  if (!isPlainObject(g)) return '<p class="meta-line">(none)</p>';
  const strip = (f) => (isPlainObject(f) ? JSON.stringify({ ...f, evidence: undefined }) : JSON.stringify(f));
  const rows = [
    ['Brand name', g.brand_name, (f) => `${escapeHtml(f.value || '-')}${f.source ? ` <span class="meta-line">(${escapeHtml(f.source)}${(f.supporting_post_ids || []).length ? `; ${f.supporting_post_ids.length} post(s)` : ''})</span>` : ''}`],
    ['What it is & offers', g.business_profile, (f) => `${f.what_it_is ? `<strong>${escapeHtml(f.what_it_is)}</strong>` : '-'}${f.source ? ` <span class="meta-line">(${escapeHtml(f.source)})</span>` : ''}${(f.offerings || []).length ? `<div class="meta-line">Offers:</div>${listHtml(f.offerings)}` : ''}${f.audience ? `<div><span class="meta-line">For:</span> ${escapeHtml(f.audience)} ${confidenceBadge(f.audience_confidence)}</div>` : ''}`],
    ['Content pillars', g.content_pillars, (f) => listHtml(f.items)],
    ['Voice & tone', g.voice_and_tone, (f) => `${escapeHtml(f.description || '-')}${f.source ? ` <span class="meta-line">(${escapeHtml(f.source)}${f.low_sample ? ', low sample' : ''})</span>` : ''}`],
    ['Hashtags', g.hashtag_strategy, (f) => `${escapeHtml(f.pattern_description || '-')}${listHtml(f.frequently_used)}`],
    ['Location', g.location, (f) => `${escapeHtml(f.value || '-')}${f.source ? ` <span class="meta-line">(${escapeHtml(f.source)})</span>` : ''}`],
    ['Colors', g.color_palette, (f) => `${(f.hex_colors || []).length ? swatches(f.hex_colors) : '<span class="meta-line">none confirmed</span>'}${(f.unconfirmed_colors || []).length ? `<div class="meta-line">unconfirmed (not used): ${swatches(f.unconfirmed_colors)}</div>` : ''}`],
  ];
  return `<table class="stage-table"><tbody>${rows.map(([label, field, render]) => {
    const changed = before && field !== undefined && strip(field) !== strip(before[FIELD_KEYS[label]]);
    return `<tr><th>${label}${changed ? ' <span class="badge mid">changed</span>' : ''}</th><td>${isPlainObject(field) ? render(field) : '<span class="meta-line">-</span>'}</td><td>${isPlainObject(field) ? confidenceBadge(field.confidence) : ''}</td></tr>`;
  }).join('')}</tbody></table>`;
}

function extractionBody(out) {
  if (!isPlainObject(out)) return '<p class="meta-line">(no parsed output)</p>';
  const field = (label, f, value) => (isPlainObject(f)
    ? `<tr><th>${label}</th><td>${value(f)}${(f.evidence || []).length ? `<details class="evidence"><summary>evidence (${f.evidence.length})</summary>${listHtml(f.evidence)}</details>` : ''}</td><td>${confidenceBadge(f.confidence)}</td></tr>`
    : '');
  const loc = out.location_signal;
  const counts = {};
  for (const c of out.post_image_classifications || []) counts[c.image_type] = (counts[c.image_type] || 0) + 1;
  return `
    <div class="run-summary">
      <span><strong>Posts:</strong> ${escapeHtml(out.posts_received ?? '-')} received → ${escapeHtml(out.posts_analyzed ?? '-')} distinct</span>
      <span><strong>Cross-post groups:</strong> ${(out.cross_post_groups || []).length}</span>
      <span><strong>Language:</strong> ${escapeHtml(out.content_language || '-')}</span>
      <span><strong>Images:</strong> ${Object.entries(counts).map(([k, v]) => `${escapeHtml(k)} ${v}`).join(', ') || '-'}</span>
    </div>
    <table class="stage-table"><tbody>
      ${field('Brand name', out.brand_name, (f) => `${escapeHtml(f.value || '-')} <span class="meta-line">(${escapeHtml((f.signal_types || []).join(', '))}; ${(f.supporting_post_ids || []).length} post(s): ${escapeHtml((f.supporting_post_ids || []).join(', '))})</span>`)}
      ${field('What it is & offers', out.business_profile, (f) => `${f.what_it_is ? `<strong>${escapeHtml(f.what_it_is)}</strong>` : '-'}${f.source ? ` <span class="meta-line">(${escapeHtml(f.source)})</span>` : ''}${(f.offerings || []).length ? `<div class="meta-line">Offers:</div>${listHtml(f.offerings)}` : ''}${f.audience ? `<div><span class="meta-line">For:</span> ${escapeHtml(f.audience)} ${confidenceBadge(f.audience_confidence)}</div>` : ''}`)}
      ${field('Content pillars', out.content_pillars, (f) => listHtml(f.items))}
      ${field('Voice & tone', out.voice_and_tone, (f) => escapeHtml(f.description || '-'))}
      ${field('Hashtags', out.hashtag_strategy, (f) => `${escapeHtml(f.pattern_description || '-')}${listHtml(f.frequently_used)}`)}
      ${field('Location signal', loc, (f) => `${escapeHtml(f.guessed_locality || '-')} <span class="meta-line">(${escapeHtml(f.corroboration || '')}; supported by ${(f.supporting_post_ids || []).length} post(s): ${escapeHtml((f.supporting_post_ids || []).join(', '))})</span>${listHtml(f.signals)}`)}
      ${out.photo_style ? field('Photo style', out.photo_style, (f) => `${escapeHtml(f.description || '-')} <span class="meta-line">(${(f.supporting_post_ids || []).length} photo(s))</span>`) : ''}
    </tbody></table>
    ${out.confidence_notes ? `<p class="meta-line">${escapeHtml(out.confidence_notes)}</p>` : ''}`;
}

function websiteBody(out) {
  if (!isPlainObject(out)) return '<p class="meta-line">(no parsed output)</p>';
  const row = (label, f, value) => (isPlainObject(f) ? `<tr><th>${label}</th><td>${value(f)}</td><td>${confidenceBadge(f.confidence)}</td></tr>` : '');
  return `<table class="stage-table"><tbody>
    ${row('Brand name', out.brand_name, (f) => escapeHtml(f.value || '-'))}
    ${row('What it is & offers', out.business_profile_from_copy, (f) => `${escapeHtml(f.what_it_is || '-')}${listHtml(f.offerings)}${f.audience ? `<div><span class="meta-line">For:</span> ${escapeHtml(f.audience)}</div>` : ''}`)}
    ${row('Location', out.location_signal, (f) => `${escapeHtml(f.guessed_locality || '-')} <span class="meta-line">(${escapeHtml(f.provenance || '')})</span>`)}
    ${row('Voice (site copy)', out.voice_and_tone_from_copy, (f) => escapeHtml(f.description || '-'))}
  </tbody></table>`;
}

function stageBlock(n, title, kind, meta, body, { open = false } = {}) {
  return `
    <details class="stage"${open ? ' open' : ''}>
      <summary><span class="stage-num">${n}</span> <strong>${escapeHtml(title)}</strong> <span class="badge ${kind === 'LLM' ? 'llm' : 'code'}">${kind}</span> <span class="meta-line">${meta || ''}</span></summary>
      <div class="stage-body">${body}</div>
    </details>`;
}

/** Every stage a run went through, in order, ending with the stage that was run. */
function renderStages(entry) {
  // a standalone extraction run logs its output at the top level, not under pipeline
  const p = entry.pipeline || (entry.prompt_role === 'extraction' && entry.output_parsed
    ? { extraction: { version: entry.prompt_version, output_parsed: entry.output_parsed } } : null);
  const u = entry.usage_by_stage || (entry.usage ? { [entry.prompt_role]: entry.usage } : {});
  if (!p) return '';
  const blocks = [];
  let n = 0;

  if (p.extraction) {
    blocks.push(stageBlock(++n, `Extraction v${p.extraction.version}`, 'LLM', usageLine(u.extraction),
      `${extractionBody(p.extraction.output_parsed)}${rawJson('Raw JSON', p.extraction.output_parsed)}`));
  }

  const web = p.website_extraction;
  if (web) {
    blocks.push(stageBlock(++n, 'Website extraction', 'LLM', web.skipped ? `skipped - ${escapeHtml(web.reason)}` : web.fetch_ok === false ? 'website not reachable - no model call made' : usageLine(u.website_extraction),
      web.skipped ? `<p class="meta-line">Skipped: ${escapeHtml(web.reason)}</p>` : `${web.fetch_ok === false ? `<div class="error-box">Website fetch failed: ${escapeHtml(web.fetch_error || '')}</div>` : ''}${websiteBody(web.output_parsed)}${rawJson('Raw JSON', web.output_parsed)}`));
  }

  if (p.color_measurement) {
    const cm = p.color_measurement;
    blocks.push(stageBlock(++n, 'Color measurement', 'code', `${cm.designed_posts.posts_used} designed post(s) measured`,
      `<p><strong>Designed posts</strong> (${cm.designed_posts.posts_used} measured): ${swatches(cm.designed_posts.colors) || '<span class="meta-line">none</span>'}</p>
       ${(cm.designed_posts.neutrals || []).length ? `<p class="meta-line">Neutrals set aside (backgrounds/text, not brand colors): ${swatches(cm.designed_posts.neutrals)}</p>` : ''}
       ${(cm.designed_posts.not_design_colors || []).length ? `<p class="meta-line">Measured but not named as design colors by the model (photo inside a graphic, etc.): ${swatches(cm.designed_posts.not_design_colors)}</p>` : ''}
       ${(cm.designed_posts.third_party_post_ids || []).length ? `<p class="meta-line">Skipped - graphics branded for another business: ${escapeHtml(cm.designed_posts.third_party_post_ids.join(', '))}</p>` : ''}
       ${cm.photography.photos_measured ? `<p class="meta-line">Photo tones: ${Object.entries(cm.photography.tones || {}).map(([k, a]) => `${escapeHtml(k)} ${escapeHtml(a.value || '-')} (${Math.round((a.share || 0) * 100)}%)`).join(' · ')}</p>` : ''}
       <p><strong>Photos</strong> (${cm.photography.posts_used} measured, not used as brand colors): ${swatches(cm.photography.colors) || '<span class="meta-line">none</span>'}</p>`));
  }

  if (p.merged_guideline) {
    const conflicts = (p.merge_meta && p.merge_meta.conflicts) || [];
    blocks.push(stageBlock(++n, 'Merge into guideline', 'code', `${(p.merge_meta && p.merge_meta.posts_analyzed) || '-'} posts analyzed${conflicts.length ? ` · ${conflicts.length} conflict(s)` : ''}`,
      `${guidelineTable(p.merged_guideline)}${conflicts.length ? `<p><strong>Conflicts:</strong></p>${listHtml(conflicts)}` : ''}${rawJson('Raw JSON', p.merged_guideline)}`));
  }

  const val = p.validation || (entry.prompt_role === 'validation' ? { version: entry.prompt_version, output_parsed: entry.output_parsed } : null);
  if (val) {
    const out = val.output_parsed;
    const issues = (out && out.issues_found) || [];
    blocks.push(stageBlock(++n, `Validation v${val.version}`, 'LLM', `${usageLine(u.validation)}${out ? ` · ${issues.length} issue(s) corrected` : ' · invalid output'}`,
      out
        ? `${issues.length ? `<p><strong>Issues found and corrected:</strong></p>${listHtml(issues)}` : '<p>No issues found.</p>'}
           <p><strong>Corrected guideline</strong> <span class="meta-line">("changed" = differs from the merged guideline)</span></p>
           ${guidelineTable(out.corrected_guideline, p.merged_guideline)}${rawJson('Raw JSON', out)}`
        : rawJson('Raw output (not valid JSON)', val.output_raw || entry.output_raw)));
  }

  if (p.compose_brief) {
    const b = p.compose_brief.brief || {};
    const row = (label, value) => `<tr><th>${label}</th><td>${value}</td></tr>`;
    blocks.push(stageBlock(++n, 'Compose brief (confidence filter)', 'code', `detail level: ${escapeHtml(p.compose_brief.detail_level)}${p.compose_brief.reconstructed ? ' · rebuilt' : ''}`,
      `<p class="meta-line">Only this is sent to compose - anything low-confidence or missing below is withheld from the paragraph.</p>
       <table class="stage-table"><tbody>
        ${row('Brand name', b.brand_name ? escapeHtml(b.brand_name) : '<span class="badge bad">withheld</span>')}
        ${row('What it is & offers', b.business_profile ? `<strong>${escapeHtml(b.business_profile.what_it_is)}</strong>${listHtml(b.business_profile.offerings)}${b.business_profile.audience ? `<div><span class="meta-line">For:</span> ${escapeHtml(b.business_profile.audience)}</div>` : ''}` : '<span class="badge bad">withheld</span>')}
        ${row('Content pillars', b.content_pillars ? `${listHtml(b.content_pillars.items)} <span class="badge">${escapeHtml(b.content_pillars.use)}</span>` : '<span class="badge bad">withheld</span>')}
        ${row('Voice & tone', b.voice_and_tone ? `${escapeHtml(b.voice_and_tone.description)} <span class="badge">${escapeHtml(b.voice_and_tone.use)}</span>` : '<span class="badge bad">withheld</span>')}
        ${row('Hashtags', b.hashtag_strategy ? escapeHtml(b.hashtag_strategy.pattern_description || '') : '<span class="badge bad">withheld</span>')}
        ${row('Location', b.location || entry.resolved_location ? escapeHtml(b.location || entry.resolved_location) : '<span class="badge bad">withheld</span>')}
        ${row('Colors', '<span class="badge bad">always withheld</span>')}
       </tbody></table>
       ${p.compose_brief.reconstructed ? '<p class="meta-line">This run was logged before the brief was recorded - rebuilt from the validated guideline with the current rules.</p>' : ''}`));
  }

  const finalOutput = entry.prompt_role === 'compose'
    ? `<div class="paragraph-box">${escapeHtml(entry.output_raw || '(none)')}</div>`
    : '';
  if (entry.prompt_role === 'compose' && (entry.output_raw || entry.input_snapshot)) {
    blocks.push(stageBlock(++n, `Compose v${entry.prompt_version} → final paragraph`, 'LLM', usageLine(u.compose),
      `${finalOutput}${rawJson('Prompt sent to compose', entry.input_snapshot ? `SYSTEM:\n${entry.input_snapshot.system_prompt}\n\nUSER:\n${entry.input_snapshot.user_text}` : null)}`));
  }

  return `<div class="stages">${blocks.join('')}</div>`;
}

// ---------- history ----------

async function loadHistory() {
  const role = el('historyRoleFilter').value;
  const postDataFile = el('historyFileFilter').value;
  const params = new URLSearchParams();
  if (role) params.set('role', role);
  if (postDataFile) params.set('post_data_file', postDataFile);
  params.set('page', String(state.historyPage));
  params.set('pageSize', '25');

  const result = await api(`/api/logs?${params.toString()}`);
  const tbody = el('historyBody');
  tbody.innerHTML = result.items.map((item) => `
    <tr data-run-id="${escapeHtml(item.run_id)}">
      <td>${escapeHtml(new Date(item.timestamp).toLocaleString())}</td>
      <td>${escapeHtml(item.post_data_file)}</td>
      <td>${escapeHtml(item.prompt_role)} / v${item.prompt_version}</td>
      <td>${escapeHtml(item.model)}</td>
      <td>${escapeHtml(item.effort || (item.temperature !== undefined && item.temperature !== null ? `temp ${item.temperature}` : '-'))}</td>
      <td>${item.latency_ms} ms${typeof item.cost_usd === 'number' ? ` · $${item.cost_usd.toFixed(4)}` : ''}${item.error ? ' <span class="error-flag">error</span>' : ''}</td>
      <td><button class="view-detail-btn" data-run-id="${escapeHtml(item.run_id)}">View</button></td>
    </tr>
  `).join('') || '<tr><td colspan="7">No runs yet.</td></tr>';

  tbody.querySelectorAll('.view-detail-btn').forEach((btn) => {
    btn.addEventListener('click', () => showHistoryDetail(btn.dataset.runId));
  });
}

async function showHistoryDetail(runId) {
  try {
    showRunDialog(await api(`/api/logs/${encodeURIComponent(runId)}`));
  } catch (err) {
    alert(`Could not load run: ${err.message}`);
  }
}

function extractionOutputOf(entry) {
  if (entry.pipeline && entry.pipeline.extraction) return entry.pipeline.extraction.output_parsed || {};
  return entry.prompt_role === 'extraction' ? entry.output_parsed || {} : {};
}

const IMAGE_ROLES = ['extraction', 'validation', 'compose']; // every role whose run fetches post images

function renderInputCard(post, { failures, classifications, groupOf, imagesSent }) {
  const failure = failures[post.post_id];
  let imageStatus;
  if (!post.image_url) imageStatus = '<span class="badge muted">no image</span>';
  else if (failure) imageStatus = `<span class="badge bad">image not sent: ${escapeHtml(failure)}</span>`;
  else if (imagesSent) imageStatus = '<span class="badge good">image sent to model</span>';
  else imageStatus = '<span class="badge muted">image not used by this role</span>';

  const meta = [post.date, post.platform, post.media_type === 'video' ? 'video (thumbnail)' : null, post.account_id ? `account ${post.account_id}` : null]
    .filter(Boolean).map(escapeHtml).join(' · ');
  const classification = classifications[post.post_id];
  const group = groupOf[post.post_id];

  return `
    <div class="input-card">
      <div class="input-thumb">
        ${post.image_url
          ? `<a href="${escapeHtml(post.image_url)}" target="_blank" rel="noopener"><img src="${escapeHtml(post.image_url)}" loading="lazy" alt="${escapeHtml(post.post_id)}" /></a>`
          : '<div class="no-image">no image</div>'}
      </div>
      <div class="input-body">
        <div class="input-head"><strong>${escapeHtml(post.post_id)}</strong> <span class="meta-line">${meta}</span></div>
        <div class="badges">
          ${imageStatus}
          ${classification ? `<span class="badge">classified: ${escapeHtml(classification)}</span>` : ''}
          ${group ? `<span class="badge">cross-post group with ${escapeHtml(group)}</span>` : ''}
          ${post.tagged_place ? `<span class="badge">tagged: ${escapeHtml(post.tagged_place)}</span>` : ''}
        </div>
        <div class="input-caption">${escapeHtml(post.caption_text || '(no caption)')}</div>
      </div>
    </div>`;
}

function showRunDialog(entry) {
  const failures = Object.fromEntries((entry.image_notes || []).map((n) => [n.post_id, n.error]));
  const extraction = extractionOutputOf(entry);
  const classifications = Object.fromEntries((extraction.post_image_classifications || []).map((c) => {
    const extra = [
      c.owner === 'third_party' ? 'third-party' : '',
      (c.design_colors || []).map((d) => `${d.family}${d.role ? ` ${d.role}` : ''}`).join(', '),
    ].filter(Boolean).join(' · ');
    return [c.post_id, extra ? `${c.image_type} (${extra})` : c.image_type];
  }));
  const groupOf = {};
  for (const g of extraction.cross_post_groups || []) {
    const ids = g.post_ids || [];
    for (const id of ids) groupOf[id] = ids.filter((other) => other !== id).join(', ');
  }
  const inputs = entry.inputs || [];
  const imagesSent = IMAGE_ROLES.includes(entry.prompt_role);
  const cost = typeof entry.cost_usd === 'number' ? `$${entry.cost_usd.toFixed(4)}` : '-';

  el('runDialogTitle').textContent = `${entry.prompt_role} v${entry.prompt_version} · ${new Date(entry.timestamp).toLocaleString()}`;
  el('runDialogBody').innerHTML = `
    <div class="run-summary">
      <span><strong>File:</strong> ${escapeHtml(entry.post_data_file || '-')}</span>
      <span><strong>Account:</strong> ${escapeHtml(entry.account_id || 'all')}</span>
      ${entry.website_given ? `<span><strong>Website:</strong> ${escapeHtml(entry.website_given)}</span>` : ''}
      ${entry.brand_name_given ? `<span><strong>Brand name given:</strong> ${escapeHtml(entry.brand_name_given)}</span>` : ''}
      <span><strong>Model:</strong> ${escapeHtml(entry.model)} (${escapeHtml(entry.effort || '-')})</span>
      <span><strong>Posts:</strong> ${entry.posts_count}${entry.posts_available ? ` of ${entry.posts_available}` : ''}</span>
      ${imagesSent ? `<span><strong>Images:</strong> ${entry.images_fetched || 0} sent, ${entry.images_failed || 0} failed</span>` : ''}
      ${entry.detail_level ? `<span><strong>Detail:</strong> ${escapeHtml(entry.detail_level)}</span>` : ''}
      <span><strong>Cost:</strong> ${cost}</span>
    </div>
    ${entry.error ? `<div class="error-box">${escapeHtml(entry.error)}</div>` : ''}
    <h4>Output &amp; pipeline stages</h4>
    ${entry.prompt_role === 'compose' && entry.output_raw ? `<div class="paragraph-box">${escapeHtml(entry.output_raw)}</div>` : ''}
    ${entry.brand_colors ? `<div class="brand-colors">${brandColorsHtml(entry.brand_colors)}${photoMoodHtml(entry.photo_mood)}</div>` : ''}
    ${renderStages(entry) || `<pre>${escapeHtml(entry.output_raw || '(none)')}</pre>`}
    <h4>Inputs used (${inputs.length} post${inputs.length === 1 ? '' : 's'})</h4>
    ${entry.inputs_reconstructed ? '<p class="meta-line">This run was logged before inputs were recorded - rebuilt from the post data file with the same account and post limit.</p>' : ''}
    ${inputs.length
      ? `<div class="input-grid">${inputs.map((p) => renderInputCard(p, { failures, classifications, groupOf, imagesSent })).join('')}</div>`
      : '<p class="meta-line">No post inputs recorded for this run.</p>'}
    <details class="raw-output">
      <summary>Prompt sent to the final stage</summary>
      <p><strong>System prompt:</strong></p>
      <pre>${escapeHtml(entry.input_snapshot ? entry.input_snapshot.system_prompt : '(none)')}</pre>
      <p><strong>User text:</strong></p>
      <pre>${escapeHtml(entry.input_snapshot ? entry.input_snapshot.user_text : '(none)')}</pre>
    </details>
  `;
  el('runDialogBody').scrollTop = 0;
  el('runDialog').showModal();
}

// ---------- init ----------

function wireEvents() {
  el('postDataSelect').addEventListener('change', onPostDataChange);
  el('postLimitInput').addEventListener('input', updatePostCountWarning);
  el('accountSelect').addEventListener('change', onAccountChange);
  el('roleSelect').addEventListener('change', onRoleChange);
  el('versionSelect').addEventListener('change', onVersionChange);
  el('addRoleBtn').addEventListener('click', addRole);
  el('editRoleBtn').addEventListener('click', editRole);
  el('deleteRoleBtn').addEventListener('click', deleteRole);
  el('newVersionBtn').addEventListener('click', newVersion);
  el('saveVersionBtn').addEventListener('click', saveVersion);
  el('saveAsNewBtn').addEventListener('click', saveAsNew);
  el('deleteVersionBtn').addEventListener('click', deleteVersion);
  el('runBtn').addEventListener('click', runPrompt);
  el('saveKeyBtn').addEventListener('click', saveKey);
  el('clearKeyBtn').addEventListener('click', clearKey);
  el('historyRoleFilter').addEventListener('change', () => { state.historyPage = 1; loadHistory(); });
  el('historyFileFilter').addEventListener('change', () => { state.historyPage = 1; loadHistory(); });
  el('refreshHistoryBtn').addEventListener('click', loadHistory);
  el('viewRunInputsBtn').addEventListener('click', () => state.lastEntry && showRunDialog(state.lastEntry));
  el('runDialogClose').addEventListener('click', () => el('runDialog').close());
  el('runDialog').addEventListener('click', (e) => { if (e.target === el('runDialog')) el('runDialog').close(); });
}

async function init() {
  wireEvents();
  await Promise.all([loadPostDataFiles(), loadRoles(), loadModels(), loadKeyStatus()]);
  await loadHistory();
}

init();

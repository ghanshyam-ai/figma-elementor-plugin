import JSZip from 'jszip';
import {
  SECTION_PURPOSE_CATALOG,
  WIDGET_CATALOG,
} from '../src/catalog';
import type {
  AILayout,
  Asset,
  AssetManifestEntry,
  ElementorTemplate,
  Metadata,
  PluginToUIMessage,
  Screenshot,
  SectionPurpose,
  SelectionInfo,
  SuggestionRow,
  TaggedNodeSummary,
  UIToPluginMessage,
  ValidationReport,
  ValidationWarning,
  WidgetHint,
} from '../src/types';

// State held while we wait for the user to click "Download".
let lastBundle: {
  data: ElementorTemplate;
  tokens: unknown;
  metadata: Metadata;
  assets: Asset[];
  screenshots: Screenshot[];
  aiLayout: AILayout;
  assetManifest: AssetManifestEntry[];
  validation: ValidationReport;
  taggedSummary: TaggedNodeSummary[];
} | null = null;

// Current state used by the tag + suggestions panels.
let currentSelection: SelectionInfo | null = null;
let pendingSuggestions: SuggestionRow[] = [];

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const selectionEl = $('selection');
const extractBtn = $<HTMLButtonElement>('extract');
const downloadBtn = $<HTMLButtonElement>('download');
const reselectBtn = $<HTMLButtonElement>('reselect');
const closeLink = $('close');
const logEl = $('log');
const barEl = $('bar');
const statsEl = $('stats');
const tagWidgetEl = $<HTMLSelectElement>('tag-widget');
const tagPurposeEl = $<HTMLSelectElement>('tag-purpose');
const taggedListEl = $('tagged-list');
const taggedCountEl = $('tagged-count');
const warningsPanelEl = $<HTMLDetailsElement>('warnings-panel');
const warningsListEl = $('warnings-list');
const warningCountEl = $('warning-count');
const suggestionsPanelEl = $<HTMLDetailsElement>('suggestions-panel');
const suggestionsListEl = $('suggestions-list');
const suggestionCountEl = $('suggestion-count');
const suggestWidgetPill = $('suggest-widget');
const suggestPurposePill = $('suggest-purpose');
const suggestBtn = $<HTMLButtonElement>('suggest-tags');
const clearTagsBtn = $<HTMLButtonElement>('clear-tags');
const applySuggestionsBtn = $<HTMLButtonElement>('apply-suggestions');
const dismissSuggestionsBtn = $<HTMLButtonElement>('dismiss-suggestions');
const preflightBtn = $<HTMLButtonElement>('preflight');

// Populate the dropdowns from the shared catalog so the UI and the
// extractor's validation stay in lock-step automatically.
populateCatalogs();

extractBtn.addEventListener('click', () => {
  setBusy(true);
  logEl.innerHTML = '';
  setProgress(0);
  send({ type: 'extract' });
});

downloadBtn.addEventListener('click', async () => {
  if (!lastBundle) return;
  downloadBtn.disabled = true;
  try {
    await packageZip(lastBundle);
  } catch (e) {
    appendLog('error', `Failed to build ZIP: ${(e as Error).message}`);
  } finally {
    downloadBtn.disabled = false;
  }
});

reselectBtn.addEventListener('click', () => send({ type: 'reselect' }));
closeLink.addEventListener('click', (e) => {
  e.preventDefault();
  send({ type: 'close' });
});

// Tag panel — fires on change so the developer doesn't have to click a
// separate "Apply" button. Empty value clears the override.
tagWidgetEl.addEventListener('change', () => {
  const value = tagWidgetEl.value as WidgetHint | '';
  send({ type: 'tag-widget', widget: value || null });
});

tagPurposeEl.addEventListener('change', () => {
  const value = tagPurposeEl.value as SectionPurpose | '';
  send({ type: 'tag-section-purpose', purpose: value || null });
});

suggestBtn.addEventListener('click', () => {
  suggestBtn.disabled = true;
  appendLog('info', 'Generating widget tag suggestions…');
  send({ type: 'suggest-tags' });
});

clearTagsBtn.addEventListener('click', () => {
  if (!confirm('Clear every widget + section-purpose tag on this page? This cannot be undone.')) return;
  send({ type: 'clear-all-tags' });
});

applySuggestionsBtn.addEventListener('click', () => {
  const accepted = collectAcceptedSuggestions();
  if (accepted.length === 0) {
    appendLog('warn', 'No suggestions selected — nothing to apply.');
    return;
  }
  send({ type: 'apply-suggestions', rows: accepted });
  hideSuggestionsPanel();
});

dismissSuggestionsBtn.addEventListener('click', () => {
  hideSuggestionsPanel();
});

preflightBtn.addEventListener('click', () => {
  preflightBtn.disabled = true;
  send({ type: 'preflight' });
});

// Clicking the "auto:" pill on either tag dropdown copies the heuristic
// suggestion into the dropdown value (and stamps it on the node).
suggestWidgetPill.addEventListener('click', () => {
  const value = suggestWidgetPill.dataset.value;
  if (!value) return;
  tagWidgetEl.value = value;
  send({ type: 'tag-widget', widget: value as WidgetHint });
});

suggestPurposePill.addEventListener('click', () => {
  const value = suggestPurposePill.dataset.value;
  if (!value) return;
  tagPurposeEl.value = value;
  send({ type: 'tag-section-purpose', purpose: value as SectionPurpose });
});

window.addEventListener('message', (event: MessageEvent) => {
  const msg = event.data?.pluginMessage as PluginToUIMessage | undefined;
  if (!msg) return;
  switch (msg.type) {
    case 'init':
      currentSelection = msg.selection;
      renderSelection(msg.selection);
      break;
    case 'log':
      appendLog(msg.level, msg.message);
      break;
    case 'progress':
      setProgress(msg.value);
      break;
    case 'extracted':
      lastBundle = {
        data: msg.data,
        tokens: msg.tokens,
        metadata: msg.metadata,
        assets: msg.assets,
        screenshots: msg.screenshots,
        aiLayout: msg.aiLayout,
        assetManifest: msg.assetManifest,
        validation: msg.validation,
        taggedSummary: msg.taggedSummary,
      };
      const m = msg.metadata.counts;
      const warnCount = msg.validation.warnings.length;
      statsEl.innerHTML = `<strong>${m.nodes}</strong> nodes · <strong>${m.sections}</strong> sections · <strong>${m.widgets}</strong> widgets · <strong>${m.assets}</strong> assets · <strong>${warnCount}</strong> warnings`;
      renderWarnings(msg.validation.warnings);
      downloadBtn.disabled = false;
      setBusy(false);
      appendLog('info', 'Ready to download.');
      break;
    case 'preflight-result':
      preflightBtn.disabled = false;
      renderWarnings(msg.warnings);
      break;
    case 'suggestions':
      suggestBtn.disabled = false;
      renderSuggestions(msg.rows);
      break;
    case 'error':
      setBusy(false);
      suggestBtn.disabled = false;
      preflightBtn.disabled = false;
      appendLog('error', msg.message);
      break;
  }
});

function send(msg: UIToPluginMessage) {
  parent.postMessage({ pluginMessage: msg }, '*');
}

function setBusy(busy: boolean) {
  extractBtn.disabled = busy;
  if (busy) downloadBtn.disabled = true;
}

function setProgress(v: number) {
  barEl.style.width = `${Math.min(100, Math.max(0, v * 100))}%`;
}

function appendLog(level: 'info' | 'warn' | 'error', message: string) {
  const line = document.createElement('div');
  line.className = `line ${level}`;
  line.textContent = message;
  logEl.appendChild(line);
  logEl.scrollTop = logEl.scrollHeight;
}

function populateCatalogs(): void {
  // Widget dropdown — preserve the leading "no override" placeholder, then
  // append grouped options from the catalog.
  while (tagWidgetEl.options.length > 1) tagWidgetEl.remove(1);
  const containerGroup = document.createElement('optgroup');
  containerGroup.label = 'Containers / sections';
  const leafGroup = document.createElement('optgroup');
  leafGroup.label = 'Leaf widgets';
  for (const entry of WIDGET_CATALOG) {
    const opt = document.createElement('option');
    opt.value = entry.value;
    opt.textContent = entry.pro ? `${entry.label} (Pro)` : entry.label;
    (entry.group === 'container' ? containerGroup : leafGroup).appendChild(opt);
  }
  tagWidgetEl.appendChild(containerGroup);
  tagWidgetEl.appendChild(leafGroup);

  while (tagPurposeEl.options.length > 1) tagPurposeEl.remove(1);
  for (const entry of SECTION_PURPOSE_CATALOG) {
    const opt = document.createElement('option');
    opt.value = entry.value;
    opt.textContent = entry.label;
    tagPurposeEl.appendChild(opt);
  }
}

function renderSelection(sel: SelectionInfo): void {
  selectionEl.textContent = sel.label;
  // Tag controls require a non-empty selection. Multi-select is now
  // supported and stamps the same tag on every selected node.
  const enableControls = sel.hasSelection;
  tagWidgetEl.disabled = !enableControls;
  tagPurposeEl.disabled = !enableControls;
  // Multi-select: clear the dropdown values (mixed overrides can't reflect
  // in one select), single-select: mirror the existing override.
  if (sel.isSingle) {
    tagWidgetEl.value = sel.widgetHint ?? '';
    tagPurposeEl.value = sel.sectionPurpose ?? '';
  } else {
    tagWidgetEl.value = '';
    tagPurposeEl.value = '';
  }

  // "auto: …" pills — only meaningful on a single-node selection.
  const auto = sel.autoSuggestion;
  renderSuggestPill(suggestWidgetPill, auto?.widget, sel.widgetHint);
  renderSuggestPill(suggestPurposePill, auto?.purpose, sel.sectionPurpose);

  // Tagged list — reflect every override on the page so the developer can
  // jump back to them without having to re-find each node manually.
  const items = sel.taggedSummary;
  taggedCountEl.textContent = String(items.length);
  if (items.length === 0) {
    taggedListEl.innerHTML = '<li class="empty">No tagged nodes yet.</li>';
    return;
  }
  taggedListEl.innerHTML = '';
  for (const item of items) {
    const li = document.createElement('li');
    li.title = 'Click to select in Figma';
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = item.name;
    li.appendChild(name);
    if (item.widgetHint) {
      const tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent = item.widgetHint;
      li.appendChild(tag);
    }
    if (item.sectionPurpose) {
      const tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent = item.sectionPurpose;
      li.appendChild(tag);
    }
    li.addEventListener('click', () => send({ type: 'reveal-node', nodeId: item.id }));
    taggedListEl.appendChild(li);
  }
}

function renderSuggestPill(pillEl: HTMLElement, suggestion: string | undefined, override: string | undefined): void {
  // Hide when there's no suggestion or the suggestion is already the user's
  // override (no useful information to surface).
  if (!suggestion || suggestion === override) {
    pillEl.hidden = true;
    pillEl.removeAttribute('data-value');
    return;
  }
  pillEl.hidden = false;
  pillEl.textContent = suggestion;
  pillEl.dataset.value = suggestion;
  pillEl.title = 'Click to apply this auto-detected tag';
}

function renderWarnings(warnings: ValidationWarning[]): void {
  if (warnings.length === 0) {
    warningsPanelEl.hidden = true;
    warningsPanelEl.open = false;
    return;
  }
  warningsPanelEl.hidden = false;
  warningCountEl.textContent = String(warnings.length);
  warningsListEl.innerHTML = '';
  // Show the highest-severity items first so the developer fixes critical
  // signals (unnamed brand colors, footer baked as image) before noise.
  const levelOrder: Record<string, number> = { error: 0, warn: 1, info: 2 };
  const sorted = warnings.slice().sort((a, b) => levelOrder[a.level] - levelOrder[b.level]);
  // Auto-open the panel when there's a warn/error or a fix-before-export
  // hygiene signal — the user explicitly wanted these loud.
  const shouldOpen = sorted.some(
    (w) => w.level !== 'info' || w.code === 'unnamed-brand-colors',
  );
  warningsPanelEl.open = shouldOpen;
  for (const w of sorted.slice(0, 40)) {
    const li = document.createElement('li');
    li.className = w.level;
    const code = document.createElement('span');
    code.className = 'code';
    code.textContent = `[${w.code}] `;
    li.appendChild(code);
    li.appendChild(document.createTextNode(w.message));
    warningsListEl.appendChild(li);
  }
  if (sorted.length > 40) {
    const li = document.createElement('li');
    li.textContent = `…and ${sorted.length - 40} more (see validation.json in the ZIP).`;
    warningsListEl.appendChild(li);
  }
}

function renderSuggestions(rows: SuggestionRow[]): void {
  pendingSuggestions = rows;
  suggestionsListEl.innerHTML = '';
  if (rows.length === 0) {
    suggestionsPanelEl.hidden = true;
    suggestionsPanelEl.open = false;
    return;
  }
  suggestionsPanelEl.hidden = false;
  suggestionsPanelEl.open = true;
  // Sort: high-confidence new suggestions first; already-tagged at bottom.
  const sorted = rows.slice().sort((a, b) => {
    if (a.alreadyTagged !== b.alreadyTagged) return a.alreadyTagged ? 1 : -1;
    return (b.confidence ?? 0) - (a.confidence ?? 0);
  });
  suggestionCountEl.textContent = String(sorted.filter((r) => !r.alreadyTagged).length);
  for (let i = 0; i < sorted.length; i += 1) {
    const row = sorted[i];
    const li = document.createElement('li');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.className = 'check';
    cb.dataset.index = String(i);
    cb.checked = !row.alreadyTagged && row.confidence >= 0.7;
    if (row.alreadyTagged) cb.disabled = true;
    li.appendChild(cb);

    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = row.nodeName;
    name.title = row.reason || '';
    name.addEventListener('click', () => send({ type: 'reveal-node', nodeId: row.nodeId }));
    li.appendChild(name);

    if (row.widget) {
      const tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent = row.widget;
      li.appendChild(tag);
    }
    if (row.purpose) {
      const tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent = row.purpose;
      li.appendChild(tag);
    }
    const conf = document.createElement('span');
    conf.className = 'conf';
    conf.textContent = `${Math.round((row.confidence ?? 0) * 100)}%`;
    li.appendChild(conf);
    if (row.alreadyTagged) {
      const tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent = 'already tagged';
      li.appendChild(tag);
    }
    suggestionsListEl.appendChild(li);
  }
  // Store the sorted order so the apply step can map checkbox index back to row.
  pendingSuggestions = sorted;
}

function collectAcceptedSuggestions(): SuggestionRow[] {
  const out: SuggestionRow[] = [];
  const checkboxes = suggestionsListEl.querySelectorAll<HTMLInputElement>('input.check');
  checkboxes.forEach((cb) => {
    if (!cb.checked || cb.disabled) return;
    const idx = Number(cb.dataset.index);
    const row = pendingSuggestions[idx];
    if (row) out.push(row);
  });
  return out;
}

function hideSuggestionsPanel(): void {
  suggestionsPanelEl.hidden = true;
  suggestionsPanelEl.open = false;
  pendingSuggestions = [];
}

async function packageZip(bundle: NonNullable<typeof lastBundle>) {
  appendLog('info', 'Building ZIP...');
  const zip = new JSZip();
  const root = zip.folder('export');
  if (!root) throw new Error('Failed to create folder in ZIP');

  root.file('data.json', JSON.stringify(bundle.data, null, 2));
  root.file('global.json', JSON.stringify(bundle.tokens, null, 2));
  root.file('ai-layout.json', JSON.stringify(bundle.aiLayout, null, 2));
  root.file('assets.json', JSON.stringify(bundle.assetManifest, null, 2));
  root.file('validation.json', JSON.stringify(bundle.validation, null, 2));
  root.file('metadata.json', JSON.stringify(bundle.metadata, null, 2));
  // tags.json — every user-authored override on the page at extraction
  // time. Lets reviewers audit which tags were authored manually versus
  // produced by the heuristics, and acts as a portable tag dump.
  root.file('tags.json', JSON.stringify({
    exportedAt: bundle.metadata.exportedAt,
    source: bundle.metadata.source,
    tags: bundle.taggedSummary,
  }, null, 2));

  const screenshotsFolder = root.folder('screenshots');
  if (screenshotsFolder) {
    for (const s of bundle.screenshots) {
      screenshotsFolder.file(s.filename, s.bytes);
    }
  }

  const imagesFolder = root.folder('assets')?.folder('images');
  if (imagesFolder) {
    for (const a of bundle.assets) {
      imagesFolder.file(a.filename, a.bytes);
    }
  }

  // README inside the ZIP so downstream agents know what they're looking at.
  root.file('README.md', readmeText(bundle.metadata));

  const blob = await zip.generateAsync(
    { type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } },
    (m) => setProgress(0.95 + 0.05 * (m.percent / 100)),
  );

  const fileName = `${slug(bundle.metadata.source.fileName)}-${slug(bundle.metadata.source.pageName)}.zip`;
  triggerDownload(blob, fileName);
  appendLog('info', `Saved ${fileName} (${formatSize(blob.size)})`);
}

function slug(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'export';
}

function triggerDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function readmeText(meta: Metadata): string {
  return [
    `# ${meta.source.fileName} – ${meta.source.pageName}`,
    '',
    `Exported by ${meta.generator} v${meta.version} at ${meta.exportedAt}.`,
    '',
    '## Files',
    '- `ai-layout.json` – compact, AI-friendly summary (page type + sections + content roll-ups)',
    '- `global.json` – design tokens (colors, typography, spacing, radii, Figma styles, variables)',
    '- `assets.json` – asset manifest with type, format and alt text',
    '- `tags.json` – developer-authored widget + section-purpose overrides',
    '- `validation.json` – warnings (unnamed layers, absolute layout, mixed fonts, large rasters, ...)',
    '- `data.json` – Elementor template (containers + widgets) — preview/debug',
    '- `metadata.json` – source + counts',
    '- `screenshots/` – PNG render of each selected frame',
    '- `assets/images/` – exported image fills, icons (SVG when possible) and rasterised graphics',
    '',
    '## Recommended consumption',
    'For AI agents, prefer `ai-layout.json` + `global.json` + `assets.json` + screenshots over the raw tree.',
    'Use `validation.json` to decide which sections need a manual visual fallback.',
    '',
    '## Counts',
    `- Nodes: ${meta.counts.nodes}`,
    `- Sections: ${meta.counts.sections}`,
    `- Widgets: ${meta.counts.widgets}`,
    `- Assets: ${meta.counts.assets}`,
    `- Screenshots: ${meta.counts.screenshots}`,
    '',
  ].join('\n');
}

// Quiet the unused-variable warning — currentSelection is read indirectly
// through DOM events triggered by selection updates.
void currentSelection;

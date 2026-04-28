import JSZip from 'jszip';
import type {
  Asset,
  ElementorTemplate,
  ExtractedNode,
  Metadata,
  PluginToUIMessage,
  Screenshot,
  UIToPluginMessage,
} from '../src/types';

// State held while we wait for the user to click "Download".
let lastBundle: {
  data: ElementorTemplate;
  raw: ExtractedNode[];
  tokens: unknown;
  metadata: Metadata;
  assets: Asset[];
  screenshots: Screenshot[];
} | null = null;

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const selectionEl = $('selection');
const extractBtn = $<HTMLButtonElement>('extract');
const downloadBtn = $<HTMLButtonElement>('download');
const reselectBtn = $<HTMLButtonElement>('reselect');
const closeLink = $('close');
const logEl = $('log');
const barEl = $('bar');
const statsEl = $('stats');

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

window.addEventListener('message', (event: MessageEvent) => {
  const msg = event.data?.pluginMessage as PluginToUIMessage | undefined;
  if (!msg) return;
  switch (msg.type) {
    case 'init':
      selectionEl.textContent = msg.selectionLabel;
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
        raw: msg.raw,
        tokens: msg.tokens,
        metadata: msg.metadata,
        assets: msg.assets,
        screenshots: msg.screenshots,
      };
      const m = msg.metadata.counts;
      statsEl.innerHTML = `<strong>${m.nodes}</strong> nodes · <strong>${m.sections}</strong> sections · <strong>${m.widgets}</strong> widgets · <strong>${m.assets}</strong> assets`;
      downloadBtn.disabled = false;
      setBusy(false);
      appendLog('info', 'Ready to download.');
      break;
    case 'error':
      setBusy(false);
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

async function packageZip(bundle: NonNullable<typeof lastBundle>) {
  appendLog('info', 'Building ZIP...');
  const zip = new JSZip();
  const root = zip.folder('export');
  if (!root) throw new Error('Failed to create folder in ZIP');

  root.file('data.json', JSON.stringify(bundle.data, null, 2));
  root.file('global.json', JSON.stringify(bundle.tokens, null, 2));
  root.file('raw.json', JSON.stringify(bundle.raw, null, 2));
  root.file('metadata.json', JSON.stringify(bundle.metadata, null, 2));

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
    '## Layout',
    '- `data.json` – Elementor template (containers + widgets)',
    '- `global.json` – design tokens (colors, typography, spacing, radii)',
    '- `raw.json` – full extracted Figma node tree',
    '- `metadata.json` – source + counts',
    '- `screenshots/` – PNG render of each selected frame',
    '- `assets/images/` – exported image fills',
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

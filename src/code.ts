// Plugin sandbox entrypoint. Talks to Figma's document API and the UI iframe.
//
// Pipeline:
//   1. UI clicks "Extract"
//   2. We resolve the selection (or whole page if nothing selected)
//   3. Walk + extract nodes (extractor.ts)
//   4. Build design tokens (tokens.ts)
//   5. Map to Elementor JSON (mapper.ts)
//   6. Build AI-friendly layout, asset manifest, validation report
//   7. Export image assets + screenshots (exporter.ts)
//   8. postMessage everything to the UI which assembles the ZIP

import { collectRasterNodes, captureScreenshots, exportAssets } from './exporter';
import { ImageRegistry, countNodes, extractTree } from './extractor';
import { tallyTemplate, toElementorTemplate } from './mapper';
import { buildTokens } from './tokens';
import { buildAILayout, buildAssetManifest, buildValidationReport } from './aiLayout';
import type {
  Metadata,
  PluginToUIMessage,
  UIToPluginMessage,
} from './types';

const PLUGIN_NAME = 'Elementor Exporter';
const PLUGIN_VERSION = '0.2.0';

figma.showUI(__html__, { width: 360, height: 520, themeColors: true });

post({ type: 'init', selectionLabel: describeSelection() });

figma.on('selectionchange', () => {
  post({ type: 'init', selectionLabel: describeSelection() });
});

figma.ui.onmessage = async (msg: UIToPluginMessage) => {
  try {
    if (msg.type === 'extract') {
      await runExtraction();
    } else if (msg.type === 'reselect') {
      post({ type: 'init', selectionLabel: describeSelection() });
    } else if (msg.type === 'close') {
      figma.closePlugin();
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    post({ type: 'error', message });
    post({ type: 'log', level: 'error', message });
  }
};

function post(message: PluginToUIMessage) {
  figma.ui.postMessage(message);
}

function log(level: 'info' | 'warn' | 'error', message: string) {
  post({ type: 'log', level, message });
}

function describeSelection(): string {
  const sel = figma.currentPage.selection;
  if (sel.length === 0) return `Whole page: ${figma.currentPage.name}`;
  if (sel.length === 1) return `1 node: ${sel[0].name}`;
  return `${sel.length} nodes`;
}

type ResolvedRoots = {
  roots: SceneNode[];
  pageTitle: string;
  // Set when the user's selection was a single wrapper frame whose children
  // we promoted to siblings. Lets the AI layout / metadata note the original
  // wrapper name (which would otherwise be lost as the page title).
  flattenedFromRootName: string | null;
  // Original wrapper node, when flattening occurred. Held so we can capture
  // a full-page screenshot from it before it disappears from the export.
  flattenedFromRoot: SceneNode | null;
};

function resolveRoots(): ResolvedRoots {
  const sel = figma.currentPage.selection;
  let initial: SceneNode[];
  if (sel.length > 0) {
    initial = [...sel];
  } else {
    initial = figma.currentPage.children.filter(
      (n): n is SceneNode => n.type === 'FRAME' || n.type === 'COMPONENT' || n.type === 'GROUP' || n.type === 'INSTANCE',
    );
  }
  if (initial.length !== 1) {
    return { roots: initial, pageTitle: figma.currentPage.name, flattenedFromRootName: null, flattenedFromRoot: null };
  }
  const candidate = initial[0];
  const flat = flattenIfArtificialRoot(candidate);
  if (flat) {
    return { roots: flat, pageTitle: candidate.name, flattenedFromRootName: candidate.name, flattenedFromRoot: candidate };
  }
  return { roots: initial, pageTitle: candidate.name, flattenedFromRootName: null, flattenedFromRoot: null };
}

// A single selected frame whose children look like sibling page sections
// (≥2 frame-typed kids that each span ≥70% of the wrapper width) is treated
// as an artificial page wrapper. We promote its children to roots so they
// become independent top-level sections in the export instead of being
// nested inside one outer container — which collapses sectionPurpose
// assignment, breaks routing, and bloats fingerprints.
function flattenIfArtificialRoot(root: SceneNode): SceneNode[] | null {
  if (!('children' in root)) return null;
  const t = root.type;
  if (t !== 'FRAME' && t !== 'COMPONENT' && t !== 'INSTANCE' && t !== 'GROUP') return null;
  if (!('width' in root) || root.width <= 0) return null;
  const kids = root.children.filter(
    (c) =>
      (c.type === 'FRAME' || c.type === 'COMPONENT' || c.type === 'INSTANCE' || c.type === 'GROUP') &&
      c.visible !== false,
  );
  if (kids.length < 2) return null;
  const wide = kids.filter((c) => 'width' in c && (c as SceneNode & { width: number }).width >= root.width * 0.7);
  if (wide.length < Math.max(2, Math.ceil(kids.length * 0.6))) return null;
  return [...kids];
}

async function runExtraction() {
  const resolved = resolveRoots();
  const { roots, pageTitle, flattenedFromRootName, flattenedFromRoot } = resolved;
  if (roots.length === 0) {
    throw new Error('No frames found. Select a frame or open a page with frames.');
  }

  if (flattenedFromRootName) {
    log('info', `Flattened wrapper "${flattenedFromRootName}" into ${roots.length} sibling sections.`);
  }
  log('info', `Extracting ${roots.length} root node(s)...`);
  post({ type: 'progress', phase: 'walk', value: 0.05 });

  const registry = new ImageRegistry();
  const trees = [];
  const rasterCandidates: { nodeId: string; assetId: string; format: 'svg' | 'png' | 'jpg' | 'webp'; assetType: 'image' | 'icon' | 'logo' | 'background' | 'decoration' }[] = [];
  for (let i = 0; i < roots.length; i += 1) {
    const result = await extractTree(roots[i], registry);
    trees.push(result.tree);
    for (const c of result.rasterCandidates) rasterCandidates.push(c);
    post({ type: 'progress', phase: 'walk', value: 0.05 + 0.35 * ((i + 1) / roots.length) });
  }

  const nodeCount = trees.reduce((acc, t) => acc + countNodes(t), 0);
  log('info', `Walked ${nodeCount} nodes.`);

  log('info', 'Building design tokens...');
  const tokens = await buildTokens(trees);
  post({ type: 'progress', phase: 'tokens', value: 0.45 });

  // Build the AI layout *before* mapping so the section-purpose / content-
  // priority annotations it stamps onto trees are visible to mapper.ts
  // (which copies them onto Elementor settings as _figma_section_purpose).
  log('info', 'Building AI layout...');
  // Prefer the wrapper's name as the page title even when we flattened it
  // away — that's what the designer named the page, not the first section.
  const title = flattenedFromRootName ?? (roots.length === 1 ? roots[0].name : pageTitle);
  const aiLayout = buildAILayout(trees, title, flattenedFromRootName);
  post({ type: 'progress', phase: 'ai-layout', value: 0.5 });

  log('info', 'Mapping to Elementor JSON...');
  const template = toElementorTemplate(trees, tokens, title);
  const tally = tallyTemplate(template);
  post({ type: 'progress', phase: 'map', value: 0.6 });

  log('info', `Exporting ${registry.entries().length} image fill(s) + ${rasterCandidates.length} vector(s)...`);
  const rasterNodes = await collectRasterNodes(rasterCandidates);
  const assets = await exportAssets(rasterNodes, registry);
  post({ type: 'progress', phase: 'assets', value: 0.8 });

  log('info', 'Building asset manifest + validation report...');
  const assetManifest = buildAssetManifest(trees, assets);
  const validation = buildValidationReport(trees);
  post({ type: 'progress', phase: 'manifest', value: 0.88 });

  log('info', `Capturing screenshots...`);
  const screenshots = await captureScreenshots(roots, trees, flattenedFromRoot);
  post({ type: 'progress', phase: 'screenshots', value: 0.95 });

  const metadata: Metadata = {
    generator: PLUGIN_NAME,
    version: PLUGIN_VERSION,
    exportedAt: new Date().toISOString(),
    source: {
      fileName: figma.root.name,
      pageName: figma.currentPage.name,
      rootIds: roots.map((r) => r.id),
      rootNames: roots.map((r) => r.name),
    },
    counts: {
      nodes: nodeCount,
      assets: assets.length,
      screenshots: screenshots.length,
      sections: tally.sections,
      widgets: tally.widgets,
    },
  };

  log('info', `Done — ${assets.length} asset(s), ${screenshots.length} screenshot(s), ${validation.warnings.length} warning(s).`);
  post({ type: 'progress', phase: 'done', value: 1 });
  post({
    type: 'extracted',
    data: template,
    raw: trees,
    tokens,
    metadata,
    assets,
    screenshots,
    aiLayout,
    assetManifest,
    validation,
  });
}

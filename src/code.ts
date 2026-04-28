// Plugin sandbox entrypoint. Talks to Figma's document API and the UI iframe.
//
// Pipeline:
//   1. UI clicks "Extract"
//   2. We resolve the selection (or whole page if nothing selected)
//   3. Walk + extract nodes (extractor.ts)
//   4. Build design tokens (tokens.ts)
//   5. Map to Elementor JSON (mapper.ts)
//   6. Export image assets + screenshots (exporter.ts)
//   7. postMessage everything to the UI which assembles the ZIP

import { collectRasterNodes, captureScreenshots, exportAssets } from './exporter';
import { ImageRegistry, countNodes, extractTree } from './extractor';
import { tallyTemplate, toElementorTemplate } from './mapper';
import { buildTokens } from './tokens';
import type {
  Metadata,
  PluginToUIMessage,
  UIToPluginMessage,
} from './types';

const PLUGIN_NAME = 'Elementor Exporter';
const PLUGIN_VERSION = '0.1.0';

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

function resolveRoots(): SceneNode[] {
  const sel = figma.currentPage.selection;
  if (sel.length > 0) return [...sel];
  // Fall back to top-level frames on the page (skip tiny detached nodes).
  return figma.currentPage.children.filter(
    (n): n is SceneNode => n.type === 'FRAME' || n.type === 'COMPONENT' || n.type === 'GROUP' || n.type === 'INSTANCE',
  );
}

async function runExtraction() {
  const roots = resolveRoots();
  if (roots.length === 0) {
    throw new Error('No frames found. Select a frame or open a page with frames.');
  }

  log('info', `Extracting ${roots.length} root node(s)...`);
  post({ type: 'progress', phase: 'walk', value: 0.05 });

  const registry = new ImageRegistry();
  const trees = [];
  for (let i = 0; i < roots.length; i += 1) {
    const tree = await extractTree(roots[i], registry);
    trees.push(tree);
    post({ type: 'progress', phase: 'walk', value: 0.05 + 0.35 * ((i + 1) / roots.length) });
  }

  const nodeCount = trees.reduce((acc, t) => acc + countNodes(t), 0);
  log('info', `Walked ${nodeCount} nodes.`);

  log('info', 'Building design tokens...');
  const tokens = buildTokens(trees);
  post({ type: 'progress', phase: 'tokens', value: 0.45 });

  log('info', 'Mapping to Elementor JSON...');
  const title = roots.length === 1 ? roots[0].name : figma.currentPage.name;
  const template = toElementorTemplate(trees, tokens, title);
  const tally = tallyTemplate(template);
  post({ type: 'progress', phase: 'map', value: 0.55 });

  log('info', `Exporting ${registry.entries().length} image fill(s)...`);
  const rasterNodes = await collectRasterNodes(trees);
  const assets = await exportAssets(rasterNodes, registry);
  post({ type: 'progress', phase: 'assets', value: 0.8 });

  log('info', `Capturing ${roots.length} screenshot(s)...`);
  const screenshots = await captureScreenshots(roots);
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

  log('info', `Done — ${assets.length} asset(s), ${screenshots.length} screenshot(s).`);
  post({ type: 'progress', phase: 'done', value: 1 });
  post({
    type: 'extracted',
    data: template,
    raw: trees,
    tokens,
    metadata,
    assets,
    screenshots,
  });
}

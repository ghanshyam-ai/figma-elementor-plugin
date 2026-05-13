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
import {
  ImageRegistry,
  PLUGIN_DATA_KEY_PURPOSE,
  PLUGIN_DATA_KEY_WIDGET,
  countNodes,
  extractTree,
} from './extractor';
import { tallyTemplate, toElementorTemplate } from './mapper';
import { brandColorHygieneWarnings, buildTokens, readPaintStylesOnly } from './tokens';
import { buildAILayout, buildAssetManifest, buildValidationReport } from './aiLayout';
import type {
  AutoSuggestion,
  ExtractedNode,
  Metadata,
  PluginToUIMessage,
  SectionPurpose,
  SelectionInfo,
  SuggestionRow,
  TaggedNodeSummary,
  UIToPluginMessage,
  ValidationWarning,
  WidgetHint,
} from './types';

const PLUGIN_NAME = 'Elementor Exporter';
const PLUGIN_VERSION = '0.2.0';

figma.showUI(__html__, { width: 380, height: 700, themeColors: true });

void sendSelectionInfo();

figma.on('selectionchange', () => {
  // Wrap in void so async failures still surface via the message handler's
  // outer try/catch — Figma's selectionchange handler can't be async itself.
  void sendSelectionInfo();
});

async function sendSelectionInfo(): Promise<void> {
  try {
    post({ type: 'init', selection: await describeSelection() });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    post({ type: 'log', level: 'error', message: `selection update failed: ${message}` });
  }
}

figma.ui.onmessage = async (msg: UIToPluginMessage) => {
  try {
    if (msg.type === 'extract') {
      await runExtraction();
    } else if (msg.type === 'reselect') {
      await sendSelectionInfo();
    } else if (msg.type === 'close') {
      figma.closePlugin();
    } else if (msg.type === 'tag-widget') {
      applyTagToSelection(PLUGIN_DATA_KEY_WIDGET, msg.widget);
      await sendSelectionInfo();
    } else if (msg.type === 'tag-section-purpose') {
      applyTagToSelection(PLUGIN_DATA_KEY_PURPOSE, msg.purpose);
      await sendSelectionInfo();
    } else if (msg.type === 'reveal-node') {
      revealNode(msg.nodeId);
    } else if (msg.type === 'preflight') {
      await runPreflight();
    } else if (msg.type === 'suggest-tags') {
      await runSuggestTags();
    } else if (msg.type === 'apply-suggestions') {
      await applySuggestions(msg.rows);
      await sendSelectionInfo();
    } else if (msg.type === 'clear-all-tags') {
      clearAllTags();
      await sendSelectionInfo();
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

function readPluginData(node: SceneNode, key: string): string {
  try {
    return node.getPluginData(key);
  } catch {
    return '';
  }
}

async function describeSelection(): Promise<SelectionInfo> {
  const sel = figma.currentPage.selection;
  const isSingle = sel.length === 1;
  const node = isSingle ? sel[0] : undefined;
  let label: string;
  if (sel.length === 0) label = `Whole page: ${figma.currentPage.name}`;
  else if (sel.length === 1) label = `1 node: ${sel[0].name}`;
  else label = `${sel.length} nodes selected`;

  const widgetHint = node ? readPluginData(node, PLUGIN_DATA_KEY_WIDGET) : '';
  const purpose = node ? readPluginData(node, PLUGIN_DATA_KEY_PURPOSE) : '';

  // Run heuristics only on the selected node so the UI can show a
  // "would-be-tagged-as" preview alongside the override dropdowns. Skipped
  // on multi-select to keep selectionchange responsive.
  let autoSuggestion: AutoSuggestion | undefined;
  if (node) {
    autoSuggestion = await suggestForNode(node);
  }

  return {
    label,
    nodeId: node?.id,
    nodeName: node?.name,
    selectionCount: sel.length,
    isSingle,
    hasSelection: sel.length > 0,
    widgetHint: (widgetHint || undefined) as WidgetHint | undefined,
    sectionPurpose: (purpose || undefined) as SectionPurpose | undefined,
    autoSuggestion,
    taggedSummary: listTaggedNodes(),
  };
}

// Run the extraction heuristics on a single Figma node and return the
// resulting widget / purpose suggestions. Cached per-node id so rapid
// selection changes don't re-walk the same subtree.
const suggestionCache = new Map<string, AutoSuggestion>();

async function suggestForNode(node: SceneNode): Promise<AutoSuggestion | undefined> {
  const cached = suggestionCache.get(node.id);
  if (cached) return cached;
  try {
    const registry = new ImageRegistry();
    const result = await extractTree(node, registry);
    // Build the AI layout against just this subtree so sectionPurpose gets
    // stamped using the full detector (same code path the export uses).
    const aiTree = result.tree;
    const aiLayout = buildAILayout([aiTree], aiTree.name);
    void aiLayout;
    const suggestion: AutoSuggestion = {
      widget: aiTree.widgetHint ?? mapPreferredToHint(aiTree.preferredWidget),
      purpose: aiTree.sectionPurpose,
      confidence: aiTree.confidence,
      reason: aiTree.roleReason,
    };
    if (!suggestion.widget && !suggestion.purpose) return undefined;
    suggestionCache.set(node.id, suggestion);
    return suggestion;
  } catch {
    return undefined;
  }
}

// Best-effort mapping from PreferredWidget (broader vocabulary) to
// WidgetHint (the subset the UI tagging panel recognises). Container-like
// preferred widgets (container, spacer, divider) don't surface — those
// aren't useful as "would tag as" hints in the UI.
function mapPreferredToHint(p?: string): WidgetHint | undefined {
  if (!p) return undefined;
  const valid: ReadonlyArray<WidgetHint> = [
    'counter', 'tabs', 'accordion', 'image-carousel', 'testimonial-carousel',
    'slides', 'icon-list', 'icon-box', 'price-table', 'price-list', 'progress',
    'star-rating', 'social-icons', 'nav-menu', 'form', 'posts', 'video',
    'image-box', 'button', 'image', 'heading', 'text-editor', 'icon',
  ];
  return (valid as readonly string[]).indexOf(p) !== -1 ? (p as WidgetHint) : undefined;
}

// Invalidated whenever a tag changes — the suggestion *itself* doesn't
// depend on pluginData, but stale entries linger after a developer
// re-runs the plugin on an edited file.
function invalidateSuggestionCache(): void {
  suggestionCache.clear();
}

// Walk the whole page collecting every node that carries a tagging
// pluginData value. Used by the UI to render a "tagged" list so the
// developer can review / clear overrides without re-selecting each node.
function listTaggedNodes(): TaggedNodeSummary[] {
  const out: TaggedNodeSummary[] = [];
  function walk(n: BaseNode) {
    if (n.type !== 'PAGE' && 'getPluginData' in n) {
      const w = readPluginData(n as SceneNode, PLUGIN_DATA_KEY_WIDGET);
      const p = readPluginData(n as SceneNode, PLUGIN_DATA_KEY_PURPOSE);
      if (w || p) {
        out.push({
          id: n.id,
          name: n.name,
          widgetHint: (w || undefined) as WidgetHint | undefined,
          sectionPurpose: (p || undefined) as SectionPurpose | undefined,
        });
      }
    }
    if ('children' in n) {
      for (const c of (n as { children: readonly BaseNode[] }).children) walk(c);
    }
  }
  walk(figma.currentPage);
  return out;
}

// Stamp the chosen widget/purpose on each selected node. `null` clears the
// override. We don't validate against the WidgetHint / SectionPurpose
// vocabulary here — extractor.applyPluginDataOverrides does, so a malformed
// value just gets ignored at extraction time.
function applyTagToSelection(key: string, value: string | null): void {
  const sel = figma.currentPage.selection;
  if (sel.length === 0) return;
  for (const node of sel) {
    if ('setPluginData' in node) {
      node.setPluginData(key, value ?? '');
    }
  }
  invalidateSuggestionCache();
  const label = key === PLUGIN_DATA_KEY_WIDGET ? 'widget' : 'section purpose';
  if (value) {
    log('info', `Tagged ${sel.length} node(s) as ${label}: ${value}`);
  } else {
    log('info', `Cleared ${label} tag on ${sel.length} node(s).`);
  }
}

// --- Preflight check ----------------------------------------------------
// Read only paint styles + run hygiene checks. No tree walk, no asset
// export. Returns in <1 second on any file so the developer can iterate
// on style names without re-running the full pipeline.
async function runPreflight(): Promise<void> {
  log('info', 'Running preflight check (paint styles)...');
  const tokens = await readPaintStylesOnly();
  const warnings: ValidationWarning[] = brandColorHygieneWarnings(tokens);
  const total = warnings.length;
  if (total === 0) {
    log('info', 'Preflight clean: every brand-intent paint style is named.');
  } else {
    log('warn', `Preflight surfaced ${total} hygiene warning(s).`);
  }
  post({ type: 'preflight-result', warnings });
}

// --- Auto-tag suggestion sweep -----------------------------------------
// Walk every top-level frame on the current page, extract via the same
// pipeline the export uses, and surface a list of nodes the heuristic
// would tag — with a confidence score so the developer can sort/filter.
async function runSuggestTags(): Promise<void> {
  log('info', 'Sweeping page for auto-tag suggestions...');
  const roots = (figma.currentPage.children.filter(
    (n) => n.type === 'FRAME' || n.type === 'COMPONENT' || n.type === 'INSTANCE' || n.type === 'GROUP',
  )) as SceneNode[];
  if (roots.length === 0) {
    log('info', 'No top-level frames on the current page.');
    post({ type: 'suggestions', rows: [] });
    return;
  }
  const rows: SuggestionRow[] = [];
  const registry = new ImageRegistry();
  for (const root of roots) {
    try {
      const result = await extractTree(root, registry);
      const aiTree = result.tree;
      buildAILayout([aiTree], aiTree.name);
      collectSuggestions(aiTree, rows);
    } catch (e) {
      log('warn', `Failed to analyze root "${root.name}": ${(e as Error).message}`);
    }
  }
  log('info', `Generated ${rows.length} suggestion(s).`);
  post({ type: 'suggestions', rows });
}

// Walk an extracted tree and collect any node where the heuristic produced
// a widgetHint or sectionPurpose that *differs* from any existing user
// override. Already-tagged nodes are marked with `alreadyTagged` so the UI
// can de-emphasize them.
function collectSuggestions(node: ExtractedNode, out: SuggestionRow[]): void {
  function visit(n: ExtractedNode) {
    const widget = n.widgetHint ?? mapPreferredToHint(n.preferredWidget);
    const purpose = n.sectionPurpose;
    if (widget || purpose) {
      const isUser = n.widgetHintSource === 'user' || n.sectionPurposeSource === 'user';
      // Skip generic 'container' / 'unknown' role nodes — those rarely
      // benefit from a manual tag and would clog the suggestion list.
      const role = n.semanticRole;
      const interesting = !!widget && widget !== 'image' && widget !== 'text-editor' && widget !== 'heading'
        || !!purpose;
      if (interesting) {
        out.push({
          nodeId: n.id,
          nodeName: n.name,
          widget,
          purpose,
          confidence: n.confidence ?? 0,
          reason: n.roleReason ?? '',
          alreadyTagged: isUser,
        });
        void role;
      }
    }
    for (const c of n.children) visit(c);
  }
  visit(node);
}

// Bulk-apply a list of accepted suggestions. The UI filters out the rows
// the developer un-checked before sending the list, so every row here
// should be applied as-is.
//
// Uses `getNodeByIdAsync` because the manifest declares
// `documentAccess: dynamic-page` — the synchronous `getNodeById` is not
// available in that mode. Older plugin runtimes that still expose the
// sync API are handled via the same fallback used elsewhere in this file.
async function applySuggestions(rows: SuggestionRow[]): Promise<void> {
  const api = figma as unknown as {
    getNodeByIdAsync?: (id: string) => Promise<BaseNode | null>;
    getNodeById?: (id: string) => BaseNode | null;
  };
  let widgetCount = 0;
  let purposeCount = 0;
  for (const row of rows) {
    const node = api.getNodeByIdAsync
      ? await api.getNodeByIdAsync(row.nodeId)
      : (api.getNodeById ? api.getNodeById(row.nodeId) : null);
    if (!node || node.type === 'PAGE' || node.type === 'DOCUMENT') continue;
    if ('setPluginData' in node) {
      if (row.widget) {
        node.setPluginData(PLUGIN_DATA_KEY_WIDGET, row.widget);
        widgetCount += 1;
      }
      if (row.purpose) {
        node.setPluginData(PLUGIN_DATA_KEY_PURPOSE, row.purpose);
        purposeCount += 1;
      }
    }
  }
  invalidateSuggestionCache();
  log('info', `Applied ${widgetCount} widget tag(s) and ${purposeCount} purpose tag(s).`);
}

// Clear every user-tagged override on the current page in one pass. Used
// when the developer wants to start fresh after a heuristic improvement.
function clearAllTags(): void {
  let cleared = 0;
  function walk(n: BaseNode) {
    if (n.type !== 'PAGE' && 'setPluginData' in n) {
      const hadWidget = (n as SceneNode).getPluginData(PLUGIN_DATA_KEY_WIDGET);
      const hadPurpose = (n as SceneNode).getPluginData(PLUGIN_DATA_KEY_PURPOSE);
      if (hadWidget) { (n as SceneNode).setPluginData(PLUGIN_DATA_KEY_WIDGET, ''); cleared += 1; }
      if (hadPurpose) { (n as SceneNode).setPluginData(PLUGIN_DATA_KEY_PURPOSE, ''); cleared += 1; }
    }
    if ('children' in n) {
      for (const c of (n as { children: readonly BaseNode[] }).children) walk(c);
    }
  }
  walk(figma.currentPage);
  invalidateSuggestionCache();
  log('info', `Cleared ${cleared} tag(s) on the current page.`);
}

// Jump the Figma viewport to the tagged node when the user clicks its row
// in the "Tagged nodes" list. We also re-select so the tag controls react.
function revealNode(nodeId: string): void {
  // Async API guards against missing nodes (deleted between UI fetch and
  // click). Falls back silently when not available in older runtimes.
  const api = figma as unknown as {
    getNodeByIdAsync?: (id: string) => Promise<BaseNode | null>;
    getNodeById?: (id: string) => BaseNode | null;
  };
  const lookup = api.getNodeByIdAsync
    ? api.getNodeByIdAsync(nodeId)
    : Promise.resolve(api.getNodeById ? api.getNodeById(nodeId) : null);
  lookup
    .then((node) => {
      if (!node || node.type === 'PAGE' || node.type === 'DOCUMENT') return;
      const scene = node as SceneNode;
      figma.currentPage.selection = [scene];
      figma.viewport.scrollAndZoomIntoView([scene]);
    })
    .catch(() => { /* node removed or inaccessible */ });
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
  const validation = buildValidationReport(trees, tokens);
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
    tokens,
    metadata,
    assets,
    screenshots,
    aiLayout,
    assetManifest,
    validation,
    taggedSummary: listTaggedNodes(),
  });
}

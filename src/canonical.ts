import type { CanonicalGraph, CanonicalNode } from './types';
import type { ImageRegistry } from './extractor';
import { readTextRuns } from './extractor';
import {
  isEffectivelyVisible,
  readComponentMeta,
  readMask,
  readNodeVariables,
  readTransforms,
} from './figmaEvidence';

// Builds canonical-graph.json: a flat id-keyed map of every node under the
// export roots, hidden nodes and (with skipInvisibleInstanceChildren=false)
// hidden instance children included. Nothing here is interpreted — role
// guessing, widget hints and Elementor mapping live downstream.

const LAYOUT_KEYS = [
  'layoutMode', 'primaryAxisAlignItems', 'counterAxisAlignItems',
  'primaryAxisSizingMode', 'counterAxisSizingMode',
  'itemSpacing', 'counterAxisSpacing', 'layoutWrap',
  'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
  'layoutSizingHorizontal', 'layoutSizingVertical',
  'layoutAlign', 'layoutGrow', 'layoutPositioning',
  'constraints', 'minWidth', 'maxWidth', 'minHeight', 'maxHeight',
  'strokesIncludedInLayout', 'itemReverseZIndex', 'clipsContent',
] as const;

export type CanonicalOptions = {
  // assetId lookup for IMAGE paints (hash → id) and final file names.
  registry?: ImageRegistry;
  assetFiles?: ReadonlyMap<string, string>;
  maxDepth?: number;
};

export async function buildCanonicalGraph(
  roots: readonly SceneNode[],
  opts: CanonicalOptions = {},
): Promise<CanonicalGraph> {
  const nodes: Record<string, CanonicalNode> = {};
  const maxDepth = opts.maxDepth ?? 128;

  async function visit(node: SceneNode, parentId: string | null, depth: number): Promise<void> {
    const childNodes: SceneNode[] =
      'children' in node && depth < maxDepth ? (Array.from(node.children) as SceneNode[]) : [];
    const c: CanonicalNode = {
      id: node.id,
      name: node.name,
      type: node.type,
      parentId,
      childIds: childNodes.map((k) => k.id),
      visible: node.visible,
      effectiveVisible: isEffectivelyVisible(node),
      geometry: geometryOf(node),
      transforms: readTransforms(node),
      layout: layoutOf(node),
      fills: paintsOf('fills' in node ? node.fills : undefined, opts),
      strokes: strokesOf(node, opts),
      effects: cloneJson('effects' in node ? safeArray(node.effects) : []),
      mask: readMask(node),
    };
    if ('cornerRadius' in node) c.cornerRadius = cornerRadiusOf(node);
    if ('opacity' in node) c.opacity = node.opacity;
    if ('blendMode' in node) c.blendMode = node.blendMode;
    if (node.type === 'TEXT') c.text = textOf(node);
    const comp = await readComponentMeta(node);
    if (comp) c.component = comp;
    const vars = readNodeVariables(node);
    if (vars) c.variables = vars;
    const proto = prototypeOf(node);
    if (proto) c.prototype = proto;
    nodes[c.id] = c;
    for (const k of childNodes) await visit(k, node.id, depth + 1);
  }

  for (const r of roots) await visit(r, r.parent && 'id' in r.parent ? r.parent.id : null, 0);

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    rootIds: roots.map((r) => r.id),
    nodeCount: Object.keys(nodes).length,
    nodes,
  };
}

function geometryOf(node: SceneNode): CanonicalNode['geometry'] {
  const g: CanonicalNode['geometry'] = {};
  if ('x' in node) g.x = node.x;
  if ('y' in node) g.y = node.y;
  if ('width' in node) g.width = node.width;
  if ('height' in node) g.height = node.height;
  if ('rotation' in node) g.rotation = node.rotation;
  if ('absoluteBoundingBox' in node && node.absoluteBoundingBox) g.absoluteBoundingBox = { ...node.absoluteBoundingBox };
  if ('absoluteRenderBounds' in node && node.absoluteRenderBounds) g.absoluteRenderBounds = { ...node.absoluteRenderBounds };
  return g;
}

function layoutOf(node: SceneNode): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const n = node as unknown as Record<string, unknown>;
  for (const k of LAYOUT_KEYS) {
    if (k in n && n[k] !== undefined && n[k] !== figma.mixed) out[k] = cloneJson(n[k]);
  }
  return out;
}

function cornerRadiusOf(node: SceneNode): unknown {
  const n = node as unknown as Record<string, unknown>;
  if (n.cornerRadius === figma.mixed) {
    return {
      topLeft: n.topLeftRadius, topRight: n.topRightRadius,
      bottomRight: n.bottomRightRadius, bottomLeft: n.bottomLeftRadius,
    };
  }
  return n.cornerRadius;
}

function paintsOf(paints: unknown, opts: CanonicalOptions): unknown[] {
  if (!Array.isArray(paints)) return [];
  return paints.map((p) => {
    const out = cloneJson(p) as Record<string, unknown>;
    if (out && out.type === 'IMAGE' && typeof out.imageHash === 'string' && opts.registry) {
      const assetId = opts.registry.lookup(out.imageHash);
      if (assetId) {
        out.assetId = assetId;
        const file = opts.assetFiles?.get(assetId);
        if (file) out.assetFile = file;
      }
    }
    return out;
  });
}

function strokesOf(node: SceneNode, opts: CanonicalOptions): CanonicalNode['strokes'] {
  const n = node as unknown as Record<string, unknown>;
  const out: CanonicalNode['strokes'] = { paints: paintsOf(n.strokes, opts) };
  if ('strokeWeight' in n && n.strokeWeight !== figma.mixed) out.weight = n.strokeWeight;
  else if ('strokeTopWeight' in n) {
    out.weight = {
      top: n.strokeTopWeight, right: n.strokeRightWeight,
      bottom: n.strokeBottomWeight, left: n.strokeLeftWeight,
    };
  }
  if (typeof n.strokeAlign === 'string') out.align = n.strokeAlign;
  if (Array.isArray(n.dashPattern) && n.dashPattern.length > 0) out.dashPattern = [...n.dashPattern];
  if (n.strokeCap !== undefined && n.strokeCap !== figma.mixed) out.cap = n.strokeCap;
  if (n.strokeJoin !== undefined && n.strokeJoin !== figma.mixed) out.join = n.strokeJoin;
  return out;
}

function textOf(node: TextNode): CanonicalNode['text'] {
  const t: NonNullable<CanonicalNode['text']> = { characters: node.characters };
  if (node.fontName !== figma.mixed) t.fontName = cloneJson(node.fontName);
  if (node.fontSize !== figma.mixed) t.fontSize = node.fontSize;
  const segments = readTextRuns(node);
  if (segments) t.segments = segments;
  return t;
}

function prototypeOf(node: SceneNode): unknown[] | undefined {
  const reactions = (node as { reactions?: readonly unknown[] }).reactions;
  if (!reactions || reactions.length === 0) return undefined;
  return cloneJson([...reactions]);
}

function safeArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function cloneJson<T>(v: T): T {
  try {
    return JSON.parse(JSON.stringify(v)) as T;
  } catch {
    return v;
  }
}

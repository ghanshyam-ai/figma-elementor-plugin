import type {
  ExtractedNode,
  Fill,
  LayoutInfo,
  Padding,
  Stroke,
  TextStyle,
} from './types';

// --- Color helpers -------------------------------------------------------

function toHex(c: number): string {
  const v = Math.round(Math.max(0, Math.min(1, c)) * 255);
  return v.toString(16).padStart(2, '0');
}

export function rgbToHex(rgb: RGB, opacity = 1): string {
  const hex = `#${toHex(rgb.r)}${toHex(rgb.g)}${toHex(rgb.b)}`;
  if (opacity >= 1) return hex.toUpperCase();
  return `${hex}${toHex(opacity)}`.toUpperCase();
}

// --- Fill conversion -----------------------------------------------------

// Tracks all unique image hashes encountered during extraction so the
// exporter can dump them once. Reset per extraction run.
export class ImageRegistry {
  private map = new Map<string, string>(); // imageHash -> assetId

  register(hash: string): string {
    let id = this.map.get(hash);
    if (!id) {
      id = `img_${this.map.size + 1}`;
      this.map.set(hash, id);
    }
    return id;
  }

  entries(): { assetId: string; hash: string }[] {
    return Array.from(this.map, ([hash, assetId]) => ({ hash, assetId }));
  }
}

function convertFills(
  fills: readonly Paint[] | typeof figma.mixed | undefined,
  registry: ImageRegistry,
): Fill[] {
  if (!fills || fills === figma.mixed) return [];
  const out: Fill[] = [];
  for (const f of fills) {
    if (!f.visible && f.visible !== undefined) continue;
    const opacity = f.opacity ?? 1;
    if (f.type === 'SOLID') {
      out.push({ type: 'SOLID', color: rgbToHex(f.color), opacity });
    } else if (
      f.type === 'GRADIENT_LINEAR' ||
      f.type === 'GRADIENT_RADIAL' ||
      f.type === 'GRADIENT_ANGULAR' ||
      f.type === 'GRADIENT_DIAMOND'
    ) {
      out.push({
        type: f.type,
        opacity,
        stops: f.gradientStops.map((s) => ({
          position: s.position,
          color: rgbToHex({ r: s.color.r, g: s.color.g, b: s.color.b }, s.color.a),
        })),
      });
    } else if (f.type === 'IMAGE' && f.imageHash) {
      out.push({
        type: 'IMAGE',
        opacity,
        assetId: registry.register(f.imageHash),
        scaleMode: f.scaleMode,
      });
    }
  }
  return out;
}

function convertStrokes(node: SceneNode): Stroke[] {
  if (!('strokes' in node)) return [];
  const strokes = node.strokes;
  if (!Array.isArray(strokes)) return [];
  const weight = ('strokeWeight' in node && typeof node.strokeWeight === 'number')
    ? node.strokeWeight
    : 1;
  const align = ('strokeAlign' in node ? node.strokeAlign : 'CENTER') as Stroke['align'];
  const out: Stroke[] = [];
  for (const s of strokes) {
    if (s.visible === false) continue;
    if (s.type === 'SOLID') {
      out.push({
        color: rgbToHex(s.color),
        opacity: s.opacity ?? 1,
        weight,
        align,
      });
    }
  }
  return out;
}

// --- Layout --------------------------------------------------------------

function readPadding(node: SceneNode): Padding | undefined {
  if (!('paddingTop' in node)) return undefined;
  return {
    top: node.paddingTop ?? 0,
    right: node.paddingRight ?? 0,
    bottom: node.paddingBottom ?? 0,
    left: node.paddingLeft ?? 0,
  };
}

function readLayout(node: SceneNode): LayoutInfo {
  if (!('layoutMode' in node) || node.layoutMode === 'NONE') {
    return { mode: 'NONE' };
  }
  // Treat GRID as NONE for now — Elementor maps cleanly to flex, not grid.
  if (node.layoutMode === 'GRID') {
    return { mode: 'NONE' };
  }
  const layout: LayoutInfo = {
    mode: node.layoutMode,
    primaryAlign: node.primaryAxisAlignItems,
    counterAlign: node.counterAxisAlignItems,
    itemSpacing: node.itemSpacing,
    padding: readPadding(node),
  };
  if ('layoutSizingHorizontal' in node) {
    layout.sizingHorizontal = node.layoutSizingHorizontal as LayoutInfo['sizingHorizontal'];
  }
  if ('layoutSizingVertical' in node) {
    layout.sizingVertical = node.layoutSizingVertical as LayoutInfo['sizingVertical'];
  }
  if ('layoutWrap' in node) {
    layout.wrap = node.layoutWrap === 'WRAP';
  }
  return layout;
}

// --- Text ----------------------------------------------------------------

function maybeMixed<T>(v: T | typeof figma.mixed): T | null {
  return v === figma.mixed ? null : (v as T);
}

function fontWeightFromStyle(style: string | null): number | null {
  if (!style) return null;
  const s = style.toLowerCase();
  if (s.includes('thin')) return 100;
  if (s.includes('extralight') || s.includes('ultralight')) return 200;
  if (s.includes('light')) return 300;
  if (s.includes('regular') || s === 'normal') return 400;
  if (s.includes('medium')) return 500;
  if (s.includes('semibold') || s.includes('demibold')) return 600;
  if (s.includes('extrabold') || s.includes('ultrabold')) return 800;
  if (s.includes('black') || s.includes('heavy')) return 900;
  if (s.includes('bold')) return 700;
  return 400;
}

function readText(node: TextNode): TextStyle {
  const fontName = maybeMixed(node.fontName) as FontName | null;
  const rawFills = node.fills as readonly Paint[] | typeof figma.mixed;
  const fills: readonly Paint[] = Array.isArray(rawFills) ? rawFills : [];
  const firstSolid = fills.find((f) => f.type === 'SOLID' && f.visible !== false) as
    | SolidPaint
    | undefined;
  const lh = maybeMixed(node.lineHeight);
  const ls = maybeMixed(node.letterSpacing);
  return {
    characters: node.characters,
    fontFamily: fontName?.family ?? null,
    fontStyle: fontName?.style ?? null,
    fontWeight: fontWeightFromStyle(fontName?.style ?? null),
    fontSize: maybeMixed(node.fontSize) as number | null,
    lineHeight:
      lh && typeof lh === 'object' && 'unit' in lh
        ? lh.unit === 'AUTO'
          ? 'AUTO'
          : { value: (lh as { value: number }).value, unit: lh.unit }
        : null,
    letterSpacing:
      ls && typeof ls === 'object' && 'unit' in ls
        ? { value: ls.value, unit: ls.unit }
        : null,
    align: maybeMixed(node.textAlignHorizontal) as TextStyle['align'],
    verticalAlign: maybeMixed(node.textAlignVertical) as TextStyle['verticalAlign'],
    textCase: maybeMixed(node.textCase) as string | null,
    textDecoration: maybeMixed(node.textDecoration) as string | null,
    color: firstSolid ? rgbToHex(firstSolid.color, firstSolid.opacity ?? 1) : null,
  };
}

// --- Role classification -------------------------------------------------

const BUTTON_NAME = /\b(button|btn|cta)\b/i;

function classifyRole(node: SceneNode, fills: Fill[]): ExtractedNode['role'] {
  if (node.type === 'TEXT') return 'text';

  if (node.type === 'FRAME' || node.type === 'GROUP' ||
      node.type === 'COMPONENT' || node.type === 'INSTANCE' ||
      node.type === 'COMPONENT_SET') {
    if (BUTTON_NAME.test(node.name)) return 'button';

    // image-only: a frame whose only fill is an image and has no children
    const onlyImage =
      fills.length === 1 && fills[0].type === 'IMAGE' &&
      'children' in node && node.children.length === 0;
    if (onlyImage) return 'image';

    // section: a top-level frame, OR any frame whose width covers most of its parent
    if (node.type === 'FRAME' &&
        (!node.parent || node.parent.type === 'PAGE')) return 'section';

    return 'container';
  }

  if (node.type === 'RECTANGLE' || node.type === 'ELLIPSE') {
    if (fills.some((f) => f.type === 'IMAGE')) return 'image';
    return 'shape';
  }

  if (node.type === 'VECTOR' || node.type === 'STAR' ||
      node.type === 'POLYGON' || node.type === 'LINE' ||
      node.type === 'BOOLEAN_OPERATION') return 'shape';

  return 'unknown';
}

// --- Main extraction -----------------------------------------------------

const SKIPPABLE: ReadonlySet<string> = new Set(['SLICE', 'STICKY', 'CONNECTOR']);

export type ExtractOptions = {
  includeHidden?: boolean;
  // Maximum recursion depth as a guardrail for very deep trees.
  maxDepth?: number;
};

export async function extractTree(
  root: SceneNode,
  registry: ImageRegistry,
  opts: ExtractOptions = {},
): Promise<ExtractedNode> {
  const includeHidden = opts.includeHidden ?? false;
  const maxDepth = opts.maxDepth ?? 64;
  return walk(root, registry, includeHidden, maxDepth, 0);
}

async function walk(
  node: SceneNode,
  registry: ImageRegistry,
  includeHidden: boolean,
  maxDepth: number,
  depth: number,
): Promise<ExtractedNode> {
  // Resolve children for component instances and pages where needed.
  if ('getMainComponentAsync' in node && node.type === 'INSTANCE') {
    // Touch the main component to ensure properties are loaded; ignored on failure.
    try { await node.getMainComponentAsync(); } catch { /* noop */ }
  }

  const fills = convertFills(
    'fills' in node ? (node.fills as readonly Paint[]) : undefined,
    registry,
  );
  const strokes = convertStrokes(node);
  const layout = readLayout(node);
  const role = classifyRole(node, fills);

  const result: ExtractedNode = {
    id: node.id,
    name: node.name,
    type: node.type,
    visible: node.visible,
    role,
    x: 'x' in node ? node.x : 0,
    y: 'y' in node ? node.y : 0,
    width: 'width' in node ? node.width : 0,
    height: 'height' in node ? node.height : 0,
    rotation: 'rotation' in node ? node.rotation : undefined,
    opacity: 'opacity' in node ? node.opacity : undefined,
    cornerRadius: readCornerRadius(node),
    fills,
    strokes,
    layout,
    children: [],
  };

  if (node.type === 'TEXT') {
    result.text = readText(node);
  }

  // If this node should be exported as a flat image (decorative shape with
  // an image fill, or vector graphic), tag it with the asset id so the
  // mapper can emit an <image> widget pointing at it.
  if (role === 'image') {
    const imgFill = fills.find((f) => f.type === 'IMAGE');
    if (imgFill && imgFill.type === 'IMAGE') {
      result.assetId = imgFill.assetId;
    } else {
      // No image fill, but classified as image -> we'll PNG-render this node.
      result.assetId = `node_${node.id.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
    }
  }

  if ('children' in node && depth < maxDepth) {
    for (const child of node.children) {
      if (SKIPPABLE.has(child.type)) continue;
      if (!child.visible && !includeHidden) continue;
      result.children.push(
        await walk(child, registry, includeHidden, maxDepth, depth + 1),
      );
    }
  }

  return result;
}

function readCornerRadius(node: SceneNode): ExtractedNode['cornerRadius'] {
  if (!('cornerRadius' in node)) return undefined;
  const cr = node.cornerRadius;
  if (typeof cr === 'number') return cr;
  if (cr === figma.mixed && 'topLeftRadius' in node) {
    return {
      tl: node.topLeftRadius,
      tr: node.topRightRadius,
      br: node.bottomRightRadius,
      bl: node.bottomLeftRadius,
    };
  }
  return undefined;
}

// Count nodes in a tree (utility for metadata).
export function countNodes(tree: ExtractedNode): number {
  let n = 1;
  for (const c of tree.children) n += countNodes(c);
  return n;
}

import type {
  AssetFormat,
  AssetType,
  Bounds,
  BreakpointHints,
  ComputedStyle,
  ConstraintAxis,
  Effect,
  ExtractedNode,
  Fill,
  HeadingLevel,
  Importance,
  InputMetadata,
  InteractionStates,
  LayoutInfo,
  LayoutPattern,
  Padding,
  PreferredWidget,
  ResponsiveHints,
  SemanticRole,
  StateStyle,
  Stroke,
  TextRun,
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

// CSS-style angle from Figma's 2x3 gradient transform. Figma's identity
// transform places the gradient horizontally (left → right), which CSS
// expresses as 90deg. The matrix's first row encodes the rotation; we
// extract atan2(b, a) and rebase to CSS's "0deg = upward" convention.
function gradientCssAngle(transform: number[][] | undefined): number | undefined {
  if (!transform || transform.length < 1 || transform[0].length < 2) return undefined;
  const a = transform[0][0];
  const b = transform[0][1];
  const radians = Math.atan2(b, a);
  const cssDeg = 90 - radians * (180 / Math.PI);
  const normalized = ((cssDeg % 360) + 360) % 360;
  return Math.round(normalized * 100) / 100;
}

// --- Fill conversion -----------------------------------------------------

// Tracks all unique image hashes encountered during extraction so the
// exporter can dump them once. Reset per extraction run.
//
// Asset ids are content-addressed (`img_<hash>`) so re-running the export
// against an unchanged Figma file produces stable filenames — the agent's
// asset-uploader can then skip media-library re-uploads.
export class ImageRegistry {
  private map = new Map<string, string>(); // imageHash -> assetId
  private usedIds = new Set<string>(); // reserve asset ids to detect prefix collisions

  register(hash: string): string {
    let id = this.map.get(hash);
    if (!id) {
      const safe = hash.replace(/[^a-zA-Z0-9_-]/g, '');
      const trimmed = safe.length > 32 ? safe.slice(0, 32) : safe;
      let candidate = `img_${trimmed}`;
      // Two distinct image hashes could share the first 32 chars and
      // overwrite each other in the ZIP. Mix a short fingerprint of the
      // full hash in when the truncated prefix is already taken.
      if (this.usedIds.has(candidate)) {
        const suffix = djb2Short(hash);
        candidate = `img_${trimmed.slice(0, 28)}_${suffix}`;
        let n = 2;
        while (this.usedIds.has(candidate)) {
          candidate = `img_${trimmed.slice(0, 28)}_${suffix}-${n}`;
          n += 1;
        }
      }
      this.usedIds.add(candidate);
      id = candidate;
      this.map.set(hash, id);
    }
    return id;
  }

  entries(): { assetId: string; hash: string }[] {
    return Array.from(this.map, ([hash, assetId]) => ({ hash, assetId }));
  }
}

function djb2Short(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i += 1) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36).slice(0, 6);
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
      const transform = (f as { gradientTransform?: ReadonlyArray<ReadonlyArray<number>> }).gradientTransform;
      const transformOut = transform ? transform.map((row) => Array.from(row)) : undefined;
      out.push({
        type: f.type,
        opacity,
        stops: f.gradientStops.map((s) => ({
          position: s.position,
          color: rgbToHex({ r: s.color.r, g: s.color.g, b: s.color.b }, s.color.a),
        })),
        transform: transformOut,
        angle: f.type === 'GRADIENT_LINEAR' ? gradientCssAngle(transformOut) : undefined,
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

// --- Effects (drop/inner shadow, blur, background blur) -----------------

function convertEffects(node: SceneNode): Effect[] {
  if (!('effects' in node)) return [];
  const effects = (node as { effects: readonly Effect_Native[] }).effects;
  if (!Array.isArray(effects)) return [];
  const out: Effect[] = [];
  for (const e of effects) {
    if (e.visible === false) continue;
    if (e.type === 'DROP_SHADOW' || e.type === 'INNER_SHADOW') {
      const c = e.color;
      out.push({
        type: e.type,
        color: rgbToHex({ r: c.r, g: c.g, b: c.b }, c.a),
        offsetX: e.offset?.x ?? 0,
        offsetY: e.offset?.y ?? 0,
        radius: e.radius ?? 0,
        spread: (e as { spread?: number }).spread ?? 0,
      });
    } else if (e.type === 'LAYER_BLUR' || e.type === 'BACKGROUND_BLUR') {
      out.push({ type: e.type, radius: e.radius ?? 0 });
    }
  }
  return out;
}

// Minimal effect shape we read from Figma's API.
type Effect_Native = {
  type: string;
  visible?: boolean;
  color?: { r: number; g: number; b: number; a: number };
  offset?: { x: number; y: number };
  radius?: number;
  spread?: number;
};

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
  // Constraints + per-child positioning live on the node regardless of
  // whether *this* node uses auto-layout — they describe how the node sits
  // inside its parent, so capture them first.
  const layout: LayoutInfo = (() => {
    if (!('layoutMode' in node) || node.layoutMode === 'NONE') {
      return { mode: 'NONE' as const };
    }
    if (node.layoutMode === 'GRID') {
      return { mode: 'GRID' as const };
    }
    const l: LayoutInfo = {
      mode: node.layoutMode,
      primaryAlign: node.primaryAxisAlignItems,
      counterAlign: node.counterAxisAlignItems,
      itemSpacing: node.itemSpacing,
      padding: readPadding(node),
    };
    if ('layoutSizingHorizontal' in node) {
      l.sizingHorizontal = node.layoutSizingHorizontal as LayoutInfo['sizingHorizontal'];
    }
    if ('layoutSizingVertical' in node) {
      l.sizingVertical = node.layoutSizingVertical as LayoutInfo['sizingVertical'];
    }
    if ('layoutWrap' in node) {
      l.wrap = node.layoutWrap === 'WRAP';
    }
    return l;
  })();

  if ('constraints' in node && node.constraints) {
    layout.constraints = {
      horizontal: node.constraints.horizontal as ConstraintAxis,
      vertical: node.constraints.vertical as ConstraintAxis,
    };
  }
  if ('layoutPositioning' in node) {
    const lp = (node as { layoutPositioning?: 'AUTO' | 'ABSOLUTE' }).layoutPositioning;
    if (lp) layout.layoutPositioning = lp;
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
  const runs = readTextRuns(node);
  const out: TextStyle = {
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
  if (runs && runs.length > 1) out.runs = runs;
  return out;
}

// Per-segment styling (bold keywords, colored links, inline size jumps).
// Returns undefined when the API isn't available; returns the segments
// array even if there's only one — caller decides whether to surface it.
function readTextRuns(node: TextNode): TextRun[] | undefined {
  if (typeof node.getStyledTextSegments !== 'function') return undefined;
  let segs: ReadonlyArray<{
    start: number;
    end: number;
    characters: string;
    fontName: FontName;
    fontSize: number;
    fills: readonly Paint[];
    textDecoration?: string;
    textCase?: string;
    hyperlink?: { type: 'URL' | 'NODE'; value: string } | null;
  }>;
  try {
    segs = node.getStyledTextSegments(
      ['fontName', 'fontSize', 'fills', 'textDecoration', 'textCase', 'hyperlink'],
    ) as typeof segs;
  } catch {
    return undefined;
  }
  if (!segs || segs.length === 0) return undefined;
  return segs.map((s) => {
    const solid = s.fills.find((f) => f.type === 'SOLID' && f.visible !== false) as
      | SolidPaint
      | undefined;
    const run: TextRun = {
      start: s.start,
      end: s.end,
      text: s.characters,
    };
    if (s.fontName) {
      run.fontFamily = s.fontName.family;
      run.fontWeight = fontWeightFromStyle(s.fontName.style);
    }
    if (typeof s.fontSize === 'number') run.fontSize = s.fontSize;
    if (solid) run.color = rgbToHex(solid.color, solid.opacity ?? 1);
    if (s.textDecoration) run.textDecoration = s.textDecoration;
    if (s.textCase) run.textCase = s.textCase;
    if (s.hyperlink) run.link = { type: s.hyperlink.type, value: s.hyperlink.value };
    return run;
  });
}

// --- Role classification -------------------------------------------------

const RX = {
  button: /\b(button|btn|cta)\b/i,
  hero: /\b(hero|banner|jumbotron)\b/i,
  navbar: /\b(navbar|nav-bar|nav|navigation|topbar|header)\b/i,
  footer: /\bfooter\b/i,
  card: /\bcard\b/i,
  pricingCard: /\b(pricing|plan|tier)\b/i,
  testimonial: /\b(testimonial|quote|review)\b/i,
  form: /\bform\b/i,
  input: /\b(input|textbox|textfield|text-field|search|email-field)\b/i,
  // `\b` is a word boundary, which doesn't trip between `ic` and `-` the
  // way the previous pattern suggested. The new form matches whole-word
  // "icon"/"symbol" and explicit "ic-" / "ic_" prefixes at the start of
  // a token without bleeding into unrelated names like "pacific" or
  // "pricing-row".
  icon: /(?:^|[\s_/-])(icon|symbol|ic[-_][a-z0-9])/i,
  logo: /\blogo\b/i,
  menu: /\b(menu|dropdown)\b/i,
  accordion: /\b(accordion|collapse|expand)\b/i,
  accordionItem: /\b(accordion[-_ ]?item|collapse[-_ ]?item|disclosure)\b/i,
  tabs: /\b(tabs?|tab[-_ ]?list|tab[-_ ]?bar|tab[-_ ]?group)\b/i,
  tabItem: /\b(tab[-_ ]?item|tab[-_ ]?panel|tab[-_ ]?button)\b/i,
  slider: /\b(slider|carousel|swiper)\b/i,
  background: /\b(bg|background|backdrop|overlay)\b/i,
  grid: /\b(grid|cards|list|gallery)\b/i,
  decoration: /\b(decoration|decor|glow|blur|noise|blob|sparkle|gradient|ornament|shine|mesh|flare)\b/i,
  faq: /\b(faq|q&a|questions?)\b/i,
  cta: /\b(cta|call[-_ ]?to[-_ ]?action|get[-_ ]?started|sign[-_ ]?up)\b/i,
  socialProof: /\b(social[-_ ]?proof|trusted[-_ ]?by|partners?|clients?|brands?|press|featured[-_ ]?in)\b/i,
  trust: /\b(secure|guarantee|trust|certified|verified|badge)\b/i,
  leadCapture: /\b(newsletter|subscribe|lead|signup|sign[-_ ]?up|contact[-_ ]?us|capture)\b/i,
  comparison: /\b(compare|comparison|vs\.?)\b/i,
  gallery: /\b(gallery|portfolio|showcase|images)\b/i,
};

const SHAPE_TYPES = new Set([
  'VECTOR', 'STAR', 'POLYGON', 'LINE', 'BOOLEAN_OPERATION',
]);

const GENERIC_LAYER_NAME_RX = /^(Frame|Group|Rectangle|Ellipse|Vector|Component|Instance|Path|Image) ?\d*$/i;
function isGenericLayerName(name: string): boolean {
  return GENERIC_LAYER_NAME_RX.test(name.trim());
}

const FRAME_TYPES = new Set([
  'FRAME', 'GROUP', 'COMPONENT', 'INSTANCE', 'COMPONENT_SET',
]);

// A frame/group that holds many vector children but no semantic structure
// (no auto-layout, no text, no nested frames). These are SVG illustrations
// imported as path soup — without flattening, each path explodes into its
// own image widget. The threshold is intentionally conservative so we
// don't fold real icon sets that the user wants individually exported.
const VECTOR_CLUSTER_MIN_CHILDREN = 8;
const VECTOR_CLUSTER_VECTOR_RATIO = 0.85;

function isVectorCluster(node: SceneNode, rawChildren: SceneNode[]): boolean {
  if (!FRAME_TYPES.has(node.type)) return false;
  if ('layoutMode' in node && node.layoutMode !== 'NONE') return false;
  if (rawChildren.length < VECTOR_CLUSTER_MIN_CHILDREN) return false;
  let vectors = 0;
  for (const c of rawChildren) {
    if (SHAPE_TYPES.has(c.type)) vectors += 1;
    else if (c.type === 'TEXT') return false; // illustrations don't contain text
    else if (FRAME_TYPES.has(c.type)) return false; // nested structure → not a cluster
  }
  return vectors / rawChildren.length >= VECTOR_CLUSTER_VECTOR_RATIO;
}

// Structural button detection — returns confidence boost when shape matches.
function looksLikeButton(node: SceneNode, fills: Fill[], children: SceneNode[]): {
  is: boolean; confidence: number; reason: string;
} {
  if (!FRAME_TYPES.has(node.type) && node.type !== 'RECTANGLE') {
    return { is: false, confidence: 0, reason: '' };
  }
  // a button is small-ish and clickable
  const w = 'width' in node ? node.width : 0;
  const h = 'height' in node ? node.height : 0;
  if (w < 48 || w > 480) return { is: false, confidence: 0, reason: '' };
  if (h < 24 || h > 96) return { is: false, confidence: 0, reason: '' };

  const hasBg = fills.some((f) => f.type === 'SOLID' || f.type.startsWith('GRADIENT'));
  const hasStroke = 'strokes' in node && Array.isArray(node.strokes) && node.strokes.length > 0;
  const cr = 'cornerRadius' in node ? node.cornerRadius : 0;
  const radius = typeof cr === 'number' ? cr : 0;
  const hasRadius = radius > 0;

  const textChildren = children.filter((c) => c.type === 'TEXT');
  const onlyTextOrIconChildren =
    children.length > 0 &&
    children.every((c) => c.type === 'TEXT' || SHAPE_TYPES.has(c.type) || c.type === 'RECTANGLE');

  // require: rounded frame + at least one text child + (bg or stroke) + only text/icon kids
  if (textChildren.length >= 1 && (hasBg || hasStroke) && hasRadius && onlyTextOrIconChildren) {
    let confidence = 0.7;
    if (hasBg) confidence += 0.1;
    if (hasRadius) confidence += 0.05;
    if (textChildren.length === 1 && children.length <= 2) confidence += 0.1;
    return {
      is: true,
      confidence: Math.min(0.95, confidence),
      reason: 'rounded frame with text child, background fill and clickable size',
    };
  }
  return { is: false, confidence: 0, reason: '' };
}

function looksLikeIcon(node: SceneNode): boolean {
  if (!('width' in node)) return false;
  const w = node.width;
  const h = node.height;
  if (w > 64 || h > 64) return false;
  // square-ish, small, and either a vector or a frame containing only vectors
  const aspect = Math.max(w, h) / Math.max(1, Math.min(w, h));
  if (aspect > 1.5) return false;
  if (SHAPE_TYPES.has(node.type)) return true;
  if (FRAME_TYPES.has(node.type) && 'children' in node) {
    return node.children.length > 0 &&
      node.children.every((c) => SHAPE_TYPES.has(c.type) || c.type === 'RECTANGLE');
  }
  return false;
}

// --- Input metadata -----------------------------------------------------

const INPUT_TYPE_RX: { rx: RegExp; type: NonNullable<InputMetadata['inputType']> }[] = [
  { rx: /\b(email|e-?mail)\b/i, type: 'email' },
  { rx: /\b(password|passcode|pwd)\b/i, type: 'password' },
  { rx: /\b(phone|tel|mobile)\b/i, type: 'tel' },
  { rx: /\b(search|query)\b/i, type: 'search' },
  { rx: /\b(number|quantity|qty|amount)\b/i, type: 'number' },
  { rx: /\b(url|website|link)\b/i, type: 'url' },
  { rx: /\b(textarea|message|comment|description|bio)\b/i, type: 'textarea' },
  { rx: /\b(checkbox|check[-_ ]?box)\b/i, type: 'checkbox' },
  { rx: /\b(radio|radio[-_ ]?button)\b/i, type: 'radio' },
  { rx: /\b(select|dropdown|combobox)\b/i, type: 'select' },
];

function inferInputType(name: string): NonNullable<InputMetadata['inputType']> {
  for (const { rx, type } of INPUT_TYPE_RX) {
    if (rx.test(name)) return type;
  }
  return 'text';
}

// First text child of an input frame is treated as the placeholder.
function firstInnerText(node: ExtractedNode): string | undefined {
  for (const c of node.children) {
    if (c.text && c.text.characters) return c.text.characters.trim() || undefined;
    const inner = firstInnerText(c);
    if (inner) return inner;
  }
  return undefined;
}

function buildInputMetadata(node: ExtractedNode): InputMetadata {
  const name = node.name;
  const lower = name.toLowerCase();
  const meta: InputMetadata = {};
  meta.inputType = inferInputType(lower);
  // The input frame's height is also a signal — tall frames are textareas.
  if (meta.inputType === 'text' && node.height >= 80) meta.inputType = 'textarea';
  const placeholder = firstInnerText(node);
  if (placeholder) meta.placeholder = placeholder;
  // "Email *" / "Email (required)" naming convention.
  if (/[*]\s*$|\(required\)|\brequired\b/i.test(name)) meta.required = true;
  return meta;
}

// Walk a form's children and pair labels (text siblings preceding an input)
// with the input that follows. Helper text takes the text node immediately
// after the input, when present and short enough to look like helper copy.
function assignInputLabels(form: ExtractedNode): void {
  const items = form.children;
  for (let i = 0; i < items.length; i += 1) {
    const cur = items[i];
    if (cur.semanticRole !== 'input') continue;
    if (!cur.inputMetadata) cur.inputMetadata = {};
    const meta = cur.inputMetadata;
    if (!meta.label) {
      const prev = items[i - 1];
      if (prev && prev.text && prev.text.characters && prev.text.characters.length <= 80) {
        meta.label = prev.text.characters.trim();
      }
    }
    if (!meta.helperText) {
      const next = items[i + 1];
      if (next && next.text && next.text.characters) {
        const s = next.text.characters.trim();
        // Helper text: short enough, not heading-sized.
        const fs = next.text.fontSize ?? 0;
        if (s && s.length <= 120 && fs <= 14) meta.helperText = s;
      }
    }
  }
}

function looksLikeInput(node: SceneNode, fills: Fill[]): boolean {
  if (!FRAME_TYPES.has(node.type) && node.type !== 'RECTANGLE') return false;
  if (!('width' in node)) return false;
  const w = node.width;
  const h = node.height;
  // input fields are typically wide and short
  if (h < 32 || h > 72) return false;
  if (w < 120) return false;
  const cr = 'cornerRadius' in node ? node.cornerRadius : 0;
  const radius = typeof cr === 'number' ? cr : 0;
  const hasStroke = 'strokes' in node && Array.isArray(node.strokes) && node.strokes.length > 0;
  const hasLightBg = fills.some(
    (f) => f.type === 'SOLID' && (f.color === '#FFFFFF' || f.color === '#F5F5F5' || f.color === '#FAFAFA'),
  );
  return (hasStroke || hasLightBg) && radius >= 0;
}

type RoleResult = { role: SemanticRole; confidence: number; reason: string };

function classifySemantic(
  node: SceneNode,
  fills: Fill[],
  rawChildren: SceneNode[],
  depth: number,
): RoleResult {
  const name = node.name.toLowerCase();

  if (node.type === 'TEXT') {
    return { role: 'text', confidence: 1, reason: 'TEXT node' };
  }

  // Vectors / shapes
  if (SHAPE_TYPES.has(node.type)) {
    if (looksLikeIcon(node)) {
      return { role: 'icon', confidence: 0.8, reason: 'small square vector graphic' };
    }
    return { role: 'shape', confidence: 0.9, reason: `vector ${node.type}` };
  }

  // Rectangles / ellipses
  if (node.type === 'RECTANGLE' || node.type === 'ELLIPSE') {
    if (fills.some((f) => f.type === 'IMAGE')) {
      if (RX.background.test(name)) {
        return { role: 'background-shape', confidence: 0.85, reason: 'image fill named as background' };
      }
      return { role: 'image', confidence: 0.9, reason: 'rectangle/ellipse with image fill' };
    }
    if (RX.background.test(name)) {
      return { role: 'background-shape', confidence: 0.8, reason: 'shape named as background' };
    }
    return { role: 'shape', confidence: 0.7, reason: 'rectangle/ellipse without image fill' };
  }

  // Frames / groups / components
  if (FRAME_TYPES.has(node.type)) {
    // Name-driven hits first (high signal)
    if (RX.navbar.test(name)) return { role: 'navbar', confidence: 0.9, reason: 'name matches navbar' };
    if (RX.footer.test(name)) return { role: 'footer', confidence: 0.9, reason: 'name matches footer' };
    if (RX.hero.test(name)) return { role: 'hero', confidence: 0.85, reason: 'name matches hero' };
    if (RX.pricingCard.test(name)) return { role: 'pricing-card', confidence: 0.8, reason: 'name matches pricing' };
    if (RX.testimonial.test(name)) return { role: 'testimonial', confidence: 0.8, reason: 'name matches testimonial' };
    if (RX.tabs.test(name) || RX.tabItem.test(name)) return { role: 'tabs', confidence: 0.85, reason: 'name matches tab/tabs' };
    if (RX.accordion.test(name) || RX.accordionItem.test(name)) return { role: 'accordion', confidence: 0.8, reason: 'name matches accordion' };
    if (RX.slider.test(name)) return { role: 'slider', confidence: 0.8, reason: 'name matches slider/carousel' };
    if (RX.menu.test(name)) return { role: 'menu', confidence: 0.75, reason: 'name matches menu/dropdown' };
    if (RX.form.test(name)) return { role: 'form', confidence: 0.8, reason: 'name matches form' };
    if (RX.logo.test(name)) return { role: 'logo', confidence: 0.85, reason: 'name matches logo' };

    // Structural button detection
    const btn = looksLikeButton(node, fills, rawChildren);
    if (btn.is || RX.button.test(name)) {
      const reason = btn.is
        ? btn.reason + (RX.button.test(name) ? ' + name match' : '')
        : 'name matches button/btn/cta';
      const conf = RX.button.test(name) ? Math.max(0.85, btn.confidence) : btn.confidence;
      return { role: 'button', confidence: conf, reason };
    }

    if (RX.input.test(name) || looksLikeInput(node, fills)) {
      return { role: 'input', confidence: RX.input.test(name) ? 0.9 : 0.55, reason: 'wide short rounded frame' };
    }

    if (looksLikeIcon(node) || RX.icon.test(name)) {
      return { role: 'icon', confidence: 0.75, reason: 'small square frame with vector children' };
    }

    // image-only frame
    const onlyImage =
      fills.length === 1 && fills[0].type === 'IMAGE' &&
      'children' in node && node.children.length === 0;
    if (onlyImage) {
      return { role: 'image', confidence: 0.95, reason: 'frame with single image fill, no children' };
    }

    // grid container — auto-layout horizontal with multiple uniform children
    if ('layoutMode' in node) {
      const isGridName = RX.grid.test(name);
      const lm = node.layoutMode;
      const childCount = rawChildren.length;
      if (isGridName && childCount >= 2) {
        return { role: 'grid', confidence: 0.85, reason: 'name matches grid + multiple children' };
      }
      if ((lm === 'HORIZONTAL' || lm === 'GRID') && childCount >= 3) {
        // uniform sized children imply a grid
        const sizes = rawChildren.filter((c) => 'width' in c).map((c) => (c as SceneNode & { width: number }).width);
        if (sizes.length >= 3) {
          const min = Math.min(...sizes);
          const max = Math.max(...sizes);
          if (min > 0 && max / min < 1.15) {
            return { role: 'grid', confidence: 0.7, reason: 'uniform children in horizontal layout' };
          }
        }
      }
    }

    // card detection: medium frame with rounded corners, fill, and mixed children
    if ('cornerRadius' in node && 'width' in node) {
      const radius = typeof node.cornerRadius === 'number' ? node.cornerRadius : 0;
      const w = node.width;
      const h = node.height;
      const hasBg = fills.some((f) => f.type === 'SOLID' || f.type.startsWith('GRADIENT') || f.type === 'IMAGE');
      const hasShadow = 'effects' in node && Array.isArray(node.effects) &&
        node.effects.some((e: { type: string; visible?: boolean }) => e.visible !== false && e.type === 'DROP_SHADOW');
      if (
        RX.card.test(name) ||
        (radius >= 8 && hasBg && (hasShadow || rawChildren.length >= 2) && w >= 200 && w <= 600 && h >= 120 && depth >= 1)
      ) {
        const conf = RX.card.test(name) ? 0.9 : 0.55;
        const reason = RX.card.test(name) ? 'name matches card' : 'rounded frame with shadow/bg + children (shape-only match)';
        return { role: 'card', confidence: conf, reason };
      }
    }

    // top-level frame -> section, but only when the frame is large enough or
    // structurally rich enough to actually be a page section. Tiny stray
    // frames sitting on the page (icons, badges, mock devices) shouldn't
    // count — they inflate the section tally and dilute sectionPurpose
    // assignments across what should have been ~10–20 real sections.
    if (node.type === 'FRAME' && (!node.parent || node.parent.type === 'PAGE')) {
      const w = 'width' in node ? node.width : 0;
      const h = 'height' in node ? node.height : 0;
      const sectionLike = w >= 800 || h >= 400 || rawChildren.length >= 3;
      if (sectionLike) {
        return { role: 'section', confidence: 0.85, reason: 'top-level frame on page' };
      }
      // Fall through to container fallback at 0.35 — downstream consumers
      // can decide whether to promote these themselves.
    }

    // Container fallback — *no* name or structural signal matched. Confidence
    // is intentionally below the 0.5 validation threshold so downstream
    // consumers know this is a guess, not a classification. Don't raise this
    // value without adding real evidence to the decision.
    return { role: 'container', confidence: 0.35, reason: 'fallback: no name or structural match' };
  }

  return { role: 'unknown', confidence: 0.3, reason: `unhandled node type ${node.type}` };
}

// Map the rich semantic role back to the legacy role used by the Elementor mapper.
function legacyRole(s: SemanticRole): ExtractedNode['role'] {
  switch (s) {
    case 'text': return 'text';
    case 'image': return 'image';
    case 'button': return 'button';
    case 'icon': return 'image';
    case 'logo': return 'image';
    case 'shape':
    case 'background-shape': return 'shape';
    case 'hero':
    case 'navbar':
    case 'footer':
    case 'card':
    case 'pricing-card':
    case 'testimonial':
    case 'form':
    case 'menu':
    case 'accordion':
    case 'tabs':
    case 'slider':
    case 'grid':
    case 'section': return 'section';
    case 'input':
    case 'container': return 'container';
    default: return 'unknown';
  }
}

// --- Computed style ------------------------------------------------------

function computeStyle(node: ExtractedNode): ComputedStyle {
  const style: ComputedStyle = {};
  const layout = node.layout;
  if (layout.mode === 'HORIZONTAL' || layout.mode === 'VERTICAL') {
    style.display = 'flex';
    style.flexDirection = layout.mode === 'HORIZONTAL' ? 'row' : 'column';
    if (layout.itemSpacing && layout.itemSpacing > 0) style.gap = Math.round(layout.itemSpacing);
  } else if (layout.mode === 'GRID') {
    style.display = 'flex';
  } else {
    style.display = 'block';
  }
  if (layout.padding) {
    const p = layout.padding;
    style.padding = `${Math.round(p.top)}px ${Math.round(p.right)}px ${Math.round(p.bottom)}px ${Math.round(p.left)}px`;
  }
  // background
  const solid = node.fills.find((f) => f.type === 'SOLID');
  const grad = node.fills.find((f) => f.type.startsWith('GRADIENT'));
  const img = node.fills.find((f) => f.type === 'IMAGE');
  if (solid && solid.type === 'SOLID') style.background = solid.color;
  else if (grad) style.background = 'gradient';
  else if (img) style.background = 'image';
  // border
  if (node.strokes.length > 0) {
    const s = node.strokes[0];
    style.border = `${Math.round(s.weight)}px solid ${s.color}`;
  }
  // radius
  if (typeof node.cornerRadius === 'number' && node.cornerRadius > 0) {
    style.borderRadius = Math.round(node.cornerRadius);
  } else if (node.cornerRadius && typeof node.cornerRadius === 'object') {
    const c = node.cornerRadius;
    style.borderRadius = `${Math.round(c.tl)}px ${Math.round(c.tr)}px ${Math.round(c.br)}px ${Math.round(c.bl)}px`;
  }
  // shadow
  if (node.effects && node.effects.length > 0) {
    const shadows = node.effects
      .filter((e) => e.type === 'DROP_SHADOW' || e.type === 'INNER_SHADOW')
      .map((e) => {
        const s = e as { offsetX: number; offsetY: number; radius: number; spread: number; color: string; type: string };
        const inner = s.type === 'INNER_SHADOW' ? 'inset ' : '';
        return `${inner}${Math.round(s.offsetX)}px ${Math.round(s.offsetY)}px ${Math.round(s.radius)}px ${Math.round(s.spread)}px ${s.color}`;
      });
    if (shadows.length) style.boxShadow = shadows.join(', ');
  }
  // typography
  if (node.text) {
    const t = node.text;
    if (t.fontSize) {
      const lh =
        t.lineHeight && t.lineHeight !== 'AUTO' && t.lineHeight.unit === 'PIXELS'
          ? `/${Math.round(t.lineHeight.value)}px`
          : '';
      const family = t.fontFamily ?? 'sans-serif';
      style.font = `${t.fontWeight ?? 400} ${Math.round(t.fontSize)}px${lh} ${family}`;
    }
    if (t.color) style.color = t.color;
    if (t.align) style.textAlign = t.align.toLowerCase();
  }
  // size
  style.width = Math.round(node.width);
  style.height = Math.round(node.height);
  if (typeof node.opacity === 'number' && node.opacity < 1) style.opacity = round2(node.opacity);
  return style;
}

function round2(v: number) { return Math.round(v * 100) / 100; }

// --- Asset typing --------------------------------------------------------

function classifyAsset(node: SceneNode, role: SemanticRole, fills: Fill[]): {
  assetType: AssetType;
  originalFormat: AssetFormat;
  suggestedExportFormat: AssetFormat;
  isDecorative: boolean;
} {
  const hasImage = fills.some((f) => f.type === 'IMAGE');
  const isVector = SHAPE_TYPES.has(node.type) ||
    (FRAME_TYPES.has(node.type) && 'children' in node &&
      node.children.length > 0 &&
      node.children.every((c) => SHAPE_TYPES.has(c.type) || c.type === 'RECTANGLE'));

  let assetType: AssetType = 'image';
  if (role === 'logo') assetType = 'logo';
  else if (role === 'icon') assetType = 'icon';
  else if (role === 'background-shape') assetType = 'background';
  else if (isVector && !hasImage) assetType = 'icon';

  const originalFormat: AssetFormat = hasImage ? 'png' : 'svg';
  // SVG preferred for icons/logos/background-shape vectors
  let suggestedExportFormat: AssetFormat = originalFormat;
  if ((assetType === 'icon' || assetType === 'logo') && !hasImage) suggestedExportFormat = 'svg';
  if (assetType === 'image' && hasImage) suggestedExportFormat = originalFormat;

  const isDecorative = (assetType as string) === 'background' ||
    (assetType as string) === 'decoration' ||
    (assetType === 'icon' && role !== 'icon' /* icon-shaped but anonymous */);

  return { assetType, originalFormat, suggestedExportFormat, isDecorative };
}

// --- Style ID readers ----------------------------------------------------

function readStyleIds(node: SceneNode): {
  fillStyleId?: string;
  strokeStyleId?: string;
  textStyleId?: string;
  effectStyleId?: string;
} {
  const out: ReturnType<typeof readStyleIds> = {};
  const n = node as unknown as Record<string, unknown>;
  if (typeof n.fillStyleId === 'string' && n.fillStyleId) out.fillStyleId = n.fillStyleId as string;
  if (typeof n.strokeStyleId === 'string' && n.strokeStyleId) out.strokeStyleId = n.strokeStyleId as string;
  if (typeof n.textStyleId === 'string' && n.textStyleId) out.textStyleId = n.textStyleId as string;
  if (typeof n.effectStyleId === 'string' && n.effectStyleId) out.effectStyleId = n.effectStyleId as string;
  return out;
}

// --- Heading level / a11y / preferred widget ----------------------------

export function headingLevelForSize(size: number | null | undefined): HeadingLevel | undefined {
  if (!size) return undefined;
  if (size >= 48) return 'h1';
  if (size >= 36) return 'h2';
  if (size >= 28) return 'h3';
  if (size >= 22) return 'h4';
  if (size >= 18) return 'h5';
  return 'h6';
}

function isHeadingText(t: TextStyle | undefined): boolean {
  if (!t || !t.fontSize) return false;
  if (t.fontSize >= 24) return true;
  if (t.fontSize >= 18 && (t.fontWeight ?? 400) >= 600) return true;
  return false;
}

function ariaRoleFor(role: SemanticRole, isHeading: boolean): string | undefined {
  switch (role) {
    case 'navbar': return 'navigation';
    case 'menu': return 'menu';
    case 'footer': return 'contentinfo';
    case 'button': return 'button';
    case 'input': return 'textbox';
    case 'form': return 'form';
    case 'image': return 'img';
    case 'logo': return 'img';
    case 'icon': return 'img';
    case 'slider': return 'region';
    case 'accordion': return 'region';
    case 'hero':
    case 'section': return 'region';
    case 'text': return isHeading ? 'heading' : undefined;
    default: return undefined;
  }
}

function preferredWidgetFor(
  role: SemanticRole,
  isHeading: boolean,
  hasImageFill: boolean,
  childCount: number,
): PreferredWidget | undefined {
  switch (role) {
    case 'text': return isHeading ? 'heading' : 'text-editor';
    case 'button': return 'button';
    case 'image': return 'image';
    case 'icon': return 'icon';
    case 'logo': return 'image-box';
    case 'shape': return 'spacer';
    case 'background-shape': return 'spacer';
    case 'navbar': return 'nav-menu';
    case 'menu': return 'nav-menu';
    case 'footer': return 'container';
    case 'hero': return 'container';
    case 'section': return 'container';
    case 'container': return 'container';
    case 'card': return 'container';
    case 'pricing-card': return 'price-list';
    case 'testimonial': return childCount >= 3 ? 'testimonial-carousel' : 'testimonial';
    case 'form': return 'form';
    case 'input': return 'form';
    case 'accordion': return 'accordion';
    case 'tabs': return 'tabs';
    case 'slider': return hasImageFill || childCount >= 2 ? 'image-carousel' : 'slides';
    case 'grid': return 'container';
    default: return undefined;
  }
}

// --- Decorative + importance --------------------------------------------

function detectDecorative(
  node: SceneNode,
  role: SemanticRole,
  fills: Fill[],
  effects: Effect[],
  childCount: number,
): boolean {
  const name = node.name.toLowerCase();
  // explicit name signal
  if (RX.decoration.test(name)) return true;
  // background blur layer with no children = decorative backdrop
  const hasBlur = effects.some((e) => e.type === 'LAYER_BLUR' || e.type === 'BACKGROUND_BLUR');
  if (hasBlur && childCount === 0) return true;
  // very transparent shapes with no text content
  const opacity = 'opacity' in node ? (node as SceneNode & { opacity: number }).opacity : 1;
  if (typeof opacity === 'number' && opacity < 0.3 && (role === 'shape' || role === 'background-shape')) {
    return true;
  }
  // image-fill backgrounds explicitly named bg/backdrop/overlay
  if (role === 'background-shape') return true;
  // shape-only node behind content (no fills + no strokes is too aggressive,
  // but a shape with only gradient and no name signal is often decorative)
  if (role === 'shape' && fills.length === 1 && fills[0].type.startsWith('GRADIENT') && childCount === 0) {
    return true;
  }
  return false;
}

function computeImportance(
  role: SemanticRole,
  isDecorative: boolean,
  isHeading: boolean,
): Importance {
  if (isDecorative) return 'low';
  if (role === 'hero' || role === 'navbar' || role === 'footer') return 'high';
  if (role === 'button' || isHeading) return 'high';
  if (role === 'pricing-card' || role === 'form' || role === 'testimonial') return 'high';
  if (role === 'icon' || role === 'shape' || role === 'background-shape') return 'low';
  if (role === 'logo') return 'medium';
  if (role === 'card' || role === 'grid' || role === 'section') return 'medium';
  return 'medium';
}

// --- Layout pattern ------------------------------------------------------

function detectLayoutPattern(node: ExtractedNode): LayoutPattern | undefined {
  // Prefer the inferred layout when Figma's layoutMode is NONE — otherwise
  // every absolute-positioned-but-clean stack reports 'absolute' and the
  // downstream layout pattern becomes useless.
  const layout = node.inferredLayout && node.layout.mode === 'NONE' ? node.inferredLayout : node.layout;
  const childCount = node.children.length;
  if (layout.mode === 'NONE') {
    if (childCount === 0) return undefined;
    return 'absolute';
  }
  if (layout.mode === 'VERTICAL') {
    if (childCount <= 1) return '1-column';
    return 'stack';
  }
  if (layout.mode === 'HORIZONTAL' || layout.mode === 'GRID') {
    if (childCount <= 1) return '1-column';
    // Equal-height: all children same height; same-width-and-height suggests cards.
    const heights = node.children.map((c) => Math.round(c.height));
    const widths = node.children.map((c) => Math.round(c.width));
    const hMin = Math.min(...heights);
    const hMax = Math.max(...heights);
    const wMin = Math.min(...widths);
    const wMax = Math.max(...widths);
    const equalHeights = hMin > 0 && hMax / hMin < 1.05;
    const equalWidths = wMin > 0 && wMax / wMin < 1.05;
    // Masonry: similar widths, varying heights, vertical-ish layout with wrap
    if (layout.wrap && equalWidths && !equalHeights && hMax / Math.max(1, hMin) > 1.3) {
      return 'masonry';
    }
    if (equalHeights && equalWidths) {
      if (childCount === 2) return '2-column-grid';
      if (childCount === 3) return '3-column-grid';
      if (childCount === 4) return '4-column-grid';
      return 'n-column-grid';
    }
    if (equalHeights) return 'equal-height-cards';
    if (childCount === 2) return '2-column-grid';
    if (childCount === 3) return '3-column-grid';
    if (childCount === 4) return '4-column-grid';
    return 'asymmetric';
  }
  return undefined;
}

// --- Structural pattern detection ---------------------------------------

// Promote container roles + preferredWidget when child *structure* (not just
// the parent's name) reveals the intent. Runs after children are populated
// so we can lean on their fingerprints, roles, and instance groups.
function refineSemanticAndWidget(node: ExtractedNode): void {
  // Slider with multiple frame slides → 'slides' carousel, not a generic
  // image-carousel. preferredWidgetFor handles 'slides' fallback already, but
  // explicit children-with-frames tip the choice toward 'slides'.
  if (node.semanticRole === 'slider' && node.children.length >= 2) {
    const slideLikeChildren = node.children.filter(
      (c) => c.semanticRole === 'container' || c.semanticRole === 'card' || c.semanticRole === 'section',
    ).length;
    if (slideLikeChildren >= 2) node.preferredWidget = 'slides';
  }

  // Accordion: ≥2 sibling rows sharing a structural fingerprint, each a
  // container with one heading-sized text. Catches "FAQ" sections whose
  // name didn't match the accordion regex but whose body clearly is one.
  if (node.semanticRole === 'container' || node.semanticRole === 'section' || node.semanticRole === 'card') {
    if (looksLikeAccordion(node)) {
      node.semanticRole = 'accordion';
      node.preferredWidget = 'accordion';
      node.confidence = Math.max(node.confidence ?? 0, 0.7);
      node.roleReason = 'sibling rows with shared structure + heading per row';
    }
  }

  // Icon list: vertical/horizontal stack of (icon + text) rows. Promote
  // preferredWidget without changing the semantic role — there's no
  // 'icon-list' semantic role and the role 'container' is still accurate.
  if (
    !node.preferredWidget || node.preferredWidget === 'container'
  ) {
    if (looksLikeIconList(node)) {
      node.preferredWidget = 'icon-list';
    }
  }
}

function looksLikeAccordion(node: ExtractedNode): boolean {
  if (node.children.length < 2) return false;
  const groups = new Map<string, ExtractedNode[]>();
  for (const c of node.children) {
    if (!c.componentFingerprint) continue;
    const r = c.semanticRole;
    if (r !== 'container' && r !== 'card' && r !== 'section') continue;
    const arr = groups.get(c.componentFingerprint) ?? [];
    arr.push(c);
    groups.set(c.componentFingerprint, arr);
  }
  for (const arr of groups.values()) {
    if (arr.length < 2) continue;
    if (arr.every((row) => hasOneHeadingTextDescendant(row))) return true;
  }
  return false;
}

function hasOneHeadingTextDescendant(node: ExtractedNode): boolean {
  let count = 0;
  function walkLocal(n: ExtractedNode) {
    if (n.text && (n.text.fontSize ?? 0) >= 16 && (n.text.fontWeight ?? 400) >= 500) {
      count += 1;
    }
    for (const c of n.children) walkLocal(c);
  }
  walkLocal(node);
  return count >= 1;
}

function looksLikeIconList(node: ExtractedNode): boolean {
  if (node.children.length < 3) return false;
  if (node.layout.mode !== 'VERTICAL' && node.layout.mode !== 'HORIZONTAL') {
    // Fall back to inferred axis if Figma's layoutMode is NONE — see
    // inferAutoLayout below; we still check structural shape regardless.
    if (!node.inferredLayout || (node.inferredLayout.mode !== 'VERTICAL' && node.inferredLayout.mode !== 'HORIZONTAL')) {
      return false;
    }
  }
  let matching = 0;
  for (const c of node.children) {
    const counts = countDescendantsByRole(c);
    const hasIcon = counts.icon >= 1 || (counts.shape >= 1 && counts.text >= 1 && counts.text <= 3);
    if (hasIcon && counts.text >= 1 && counts.text <= 3 && counts.button === 0) {
      matching += 1;
    }
  }
  return matching >= Math.ceil(node.children.length * 0.7);
}

function countDescendantsByRole(node: ExtractedNode): {
  icon: number; text: number; button: number; shape: number; image: number;
} {
  const c = { icon: 0, text: 0, button: 0, shape: 0, image: 0 };
  function visit(n: ExtractedNode) {
    switch (n.semanticRole) {
      case 'icon': c.icon += 1; break;
      case 'text': c.text += 1; break;
      case 'button': c.button += 1; break;
      case 'shape': c.shape += 1; break;
      case 'image': c.image += 1; break;
      default: break;
    }
    for (const child of n.children) visit(child);
  }
  for (const child of node.children) visit(child);
  return c;
}

// --- Auto-layout inference ----------------------------------------------

// When a container has layoutMode=NONE but its children stack cleanly along
// a single axis (no overlaps, ordered by y or x), synthesise a LayoutInfo
// the mapper can use to emit flex settings instead of falling back to
// absolute positioning. This matches what most Elementor importers do
// silently and removes a whole class of "absolute-layout" warnings.
function inferAutoLayout(node: ExtractedNode): LayoutInfo | undefined {
  if (node.layout.mode !== 'NONE') return undefined;
  const visible = node.children.filter((c) => c.visible !== false);
  if (visible.length < 2) return undefined;

  const byY = visible.slice().sort((a, b) => a.y - b.y);
  const yGaps: number[] = [];
  let yClean = true;
  for (let i = 1; i < byY.length; i += 1) {
    const prev = byY[i - 1];
    const cur = byY[i];
    const gap = cur.y - (prev.y + prev.height);
    if (gap < -2) { yClean = false; break; }
    yGaps.push(Math.max(0, gap));
  }
  const byX = visible.slice().sort((a, b) => a.x - b.x);
  const xGaps: number[] = [];
  let xClean = true;
  for (let i = 1; i < byX.length; i += 1) {
    const prev = byX[i - 1];
    const cur = byX[i];
    const gap = cur.x - (prev.x + prev.width);
    if (gap < -2) { xClean = false; break; }
    xGaps.push(Math.max(0, gap));
  }

  if (yClean && !xClean) return makeInferredLayout('VERTICAL', yGaps, byY, node);
  if (xClean && !yClean) return makeInferredLayout('HORIZONTAL', xGaps, byX, node);
  if (yClean && xClean) {
    // Both axes are non-overlapping. Pick the one whose children span more
    // of the container — that's the dominant flow direction.
    const ySpan = byY[byY.length - 1].y + byY[byY.length - 1].height - byY[0].y;
    const xSpan = byX[byX.length - 1].x + byX[byX.length - 1].width - byX[0].x;
    const yRatio = ySpan / Math.max(1, node.height);
    const xRatio = xSpan / Math.max(1, node.width);
    return yRatio >= xRatio
      ? makeInferredLayout('VERTICAL', yGaps, byY, node)
      : makeInferredLayout('HORIZONTAL', xGaps, byX, node);
  }
  return undefined;
}

function makeInferredLayout(
  mode: 'HORIZONTAL' | 'VERTICAL',
  gaps: number[],
  sorted: ExtractedNode[],
  parent: ExtractedNode,
): LayoutInfo {
  const itemSpacing = gaps.length ? Math.round(median(gaps)) : 0;
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  return {
    mode,
    itemSpacing,
    padding: {
      top: Math.max(0, Math.round(first.y)),
      left: Math.max(0, Math.round(first.x)),
      bottom: Math.max(0, Math.round(parent.height - (last.y + last.height))),
      right: Math.max(0, Math.round(parent.width - (last.x + last.width))),
    },
  };
}

function median(arr: number[]): number {
  if (arr.length === 0) return 0;
  const s = arr.slice().sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// --- Component fingerprint ----------------------------------------------

// Recursive structural hash. Identical fingerprints across nodes mean the
// shapes are interchangeable and Claude can fold them into one template.
// Deliberately ignores text content, exact sizes, and colors so two pricing
// cards with different titles still match.
function computeFingerprint(node: ExtractedNode): string {
  const sizeBucket = bucketSize(node.width, node.height);
  const fillSig = fillSignature(node.fills);
  const radiusSig = radiusBucket(node.cornerRadius);
  const childSig = node.children.map((c) => c.componentFingerprint ?? '?').join(',');
  const parts = [
    node.semanticRole ?? node.role,
    node.layout.mode,
    sizeBucket,
    fillSig,
    radiusSig,
    node.children.length,
    `[${childSig}]`,
  ];
  return parts.join('|');
}

function bucketSize(w: number, h: number): string {
  // Bucket dimensions to nearest 32px — small differences shouldn't break a match.
  const bw = Math.round(w / 32) * 32;
  const bh = Math.round(h / 32) * 32;
  return `${bw}x${bh}`;
}

function fillSignature(fills: Fill[]): string {
  if (fills.length === 0) return 'none';
  return fills.map((f) => f.type).join('+');
}

function radiusBucket(cr: ExtractedNode['cornerRadius']): string {
  if (cr === undefined) return '0';
  if (typeof cr === 'number') {
    if (cr === 0) return '0';
    if (cr < 6) return 'sm';
    if (cr < 16) return 'md';
    if (cr < 32) return 'lg';
    return 'xl';
  }
  return 'mixed';
}

// --- Interaction states -------------------------------------------------

type StateName = keyof InteractionStates;

const STATE_PROP_KEYS = /^(state|status|interaction)$/i;

function canonicalStateName(value: string | undefined): StateName | null {
  if (!value) return null;
  const t = value.toLowerCase();
  if (t.indexOf('hover') !== -1) return 'hover';
  if (t.indexOf('focus') !== -1) return 'focus';
  if (t.indexOf('active') !== -1 || t.indexOf('press') !== -1) return 'active';
  if (t.indexOf('disable') !== -1) return 'disabled';
  return null;
}

function snapshotComponentStyle(comp: SceneNode): StateStyle {
  const out: StateStyle = {};
  const fillsRaw = ('fills' in comp ? (comp as { fills: readonly Paint[] | typeof figma.mixed }).fills : undefined);
  const fills: readonly Paint[] = Array.isArray(fillsRaw) ? fillsRaw : [];
  const solid = fills.find((f) => f.type === 'SOLID' && f.visible !== false) as SolidPaint | undefined;
  if (solid) out.background = rgbToHex(solid.color, solid.opacity ?? 1);

  const strokesRaw = ('strokes' in comp ? (comp as { strokes: readonly Paint[] }).strokes : undefined);
  const strokes: readonly Paint[] = Array.isArray(strokesRaw) ? strokesRaw : [];
  const stroke = strokes.find((s) => s.type === 'SOLID' && s.visible !== false) as SolidPaint | undefined;
  if (stroke) {
    out.borderColor = rgbToHex(stroke.color, stroke.opacity ?? 1);
    if ('strokeWeight' in comp && typeof (comp as { strokeWeight?: number }).strokeWeight === 'number') {
      out.borderWidth = (comp as { strokeWeight: number }).strokeWeight;
    }
  }
  if ('cornerRadius' in comp) {
    const cr = (comp as { cornerRadius: number | typeof figma.mixed }).cornerRadius;
    if (typeof cr === 'number' && cr > 0) out.borderRadius = cr;
  }
  if ('opacity' in comp) {
    const op = (comp as { opacity?: number }).opacity;
    if (typeof op === 'number' && op < 1) out.opacity = Math.round(op * 100) / 100;
  }
  if ('effects' in comp) {
    const effects = (comp as { effects?: readonly Effect_Native[] }).effects;
    if (Array.isArray(effects)) {
      const shadow = effects.find((e) => e.visible !== false && (e.type === 'DROP_SHADOW' || e.type === 'INNER_SHADOW'));
      if (shadow && shadow.color) {
        const inner = shadow.type === 'INNER_SHADOW' ? 'inset ' : '';
        out.boxShadow =
          `${inner}${Math.round(shadow.offset?.x ?? 0)}px ${Math.round(shadow.offset?.y ?? 0)}px ` +
          `${Math.round(shadow.radius ?? 0)}px ${rgbToHex({ r: shadow.color.r, g: shadow.color.g, b: shadow.color.b }, shadow.color.a)}`;
      }
    }
  }
  const textColor = findFirstTextColor(comp);
  if (textColor) out.color = textColor;
  return out;
}

function findFirstTextColor(node: SceneNode): string | null {
  if (node.type === 'TEXT') {
    const fills = (node as TextNode).fills as readonly Paint[] | typeof figma.mixed;
    if (Array.isArray(fills)) {
      const s = fills.find((f) => f.type === 'SOLID' && f.visible !== false) as SolidPaint | undefined;
      if (s) return rgbToHex(s.color, s.opacity ?? 1);
    }
    return null;
  }
  if ('children' in node) {
    for (const c of (node as SceneNode & { children: readonly SceneNode[] }).children) {
      const r = findFirstTextColor(c);
      if (r) return r;
    }
  }
  return null;
}

// Walk Figma component variants to capture state-driven style deltas
// (hover/focus/active/disabled). Only runs for INSTANCE/COMPONENT nodes
// whose enclosing COMPONENT_SET exposes a State/Status property.
async function extractInteractionStates(node: SceneNode): Promise<InteractionStates | undefined> {
  let mainComponent: ComponentNode | null = null;
  if (node.type === 'INSTANCE') {
    if ('getMainComponentAsync' in node) {
      try {
        mainComponent = await (node as InstanceNode).getMainComponentAsync();
      } catch {
        mainComponent = null;
      }
    }
  } else if (node.type === 'COMPONENT') {
    mainComponent = node as ComponentNode;
  } else {
    return undefined;
  }
  if (!mainComponent || !mainComponent.parent) return undefined;
  if (mainComponent.parent.type !== 'COMPONENT_SET') return undefined;

  const set = mainComponent.parent as ComponentSetNode;
  const baseProps = (mainComponent as { variantProperties?: Record<string, string> }).variantProperties ?? {};
  const propKeys = Object.keys(baseProps);
  if (propKeys.length === 0) return undefined;
  const stateKey = propKeys.find((k) => STATE_PROP_KEYS.test(k));
  if (!stateKey) return undefined;

  const states: InteractionStates = {};
  for (const sib of set.children) {
    if (sib.type !== 'COMPONENT' || sib.id === mainComponent.id) continue;
    const props = (sib as { variantProperties?: Record<string, string> }).variantProperties ?? {};
    const sameBase = propKeys.every((k) => k === stateKey || baseProps[k] === props[k]);
    if (!sameBase) continue;
    const stateName = canonicalStateName(props[stateKey]);
    if (!stateName) continue;
    if (states[stateName]) continue; // first match wins
    states[stateName] = snapshotComponentStyle(sib as SceneNode);
  }
  return Object.keys(states).length > 0 ? states : undefined;
}

// --- Main extraction -----------------------------------------------------

const SKIPPABLE: ReadonlySet<string> = new Set(['SLICE', 'STICKY', 'CONNECTOR']);

export type ExtractOptions = {
  includeHidden?: boolean;
  // Maximum recursion depth as a guardrail for very deep trees.
  maxDepth?: number;
};

export type ExtractResult = {
  tree: ExtractedNode;
  rasterCandidates: { nodeId: string; assetId: string; format: AssetFormat; assetType: AssetType }[];
};

export async function extractTree(
  root: SceneNode,
  registry: ImageRegistry,
  opts: ExtractOptions = {},
): Promise<ExtractResult> {
  const includeHidden = opts.includeHidden ?? false;
  const maxDepth = opts.maxDepth ?? 64;
  const rasterCandidates: ExtractResult['rasterCandidates'] = [];
  const rootBounds: Bounds | null = 'absoluteBoundingBox' in root && root.absoluteBoundingBox
    ? { x: root.absoluteBoundingBox.x, y: root.absoluteBoundingBox.y, width: root.absoluteBoundingBox.width, height: root.absoluteBoundingBox.height }
    : null;
  const tree = await walk(root, registry, includeHidden, maxDepth, 0, null, 0, 1, rootBounds, rasterCandidates);
  assignInstanceGroups(tree);
  return { tree, rasterCandidates };
}

// Walk siblings and stamp identical fingerprints with a shared group id so
// downstream consumers can collapse repeated cards/testimonials into one
// reusable Elementor template.
export function assignInstanceGroups(root: ExtractedNode): void {
  let groupCounter = 0;
  function visit(node: ExtractedNode) {
    const buckets = new Map<string, ExtractedNode[]>();
    for (const c of node.children) {
      const fp = c.componentFingerprint;
      if (!fp) continue;
      // Skip leaf primitives — only group structural siblings.
      if (c.semanticRole === 'text' || c.semanticRole === 'icon' || c.semanticRole === 'shape') continue;
      const arr = buckets.get(fp);
      if (arr) arr.push(c);
      else buckets.set(fp, [c]);
    }
    for (const arr of buckets.values()) {
      if (arr.length < 2) continue;
      groupCounter += 1;
      const role = arr[0].semanticRole ?? arr[0].role ?? 'group';
      const groupId = `${role}-group-${groupCounter}`;
      for (const c of arr) c.instanceGroup = groupId;
    }
    for (const c of node.children) visit(c);
  }
  visit(root);
}

async function walk(
  node: SceneNode,
  registry: ImageRegistry,
  includeHidden: boolean,
  maxDepth: number,
  depth: number,
  parentId: string | null,
  index: number,
  siblingCount: number,
  rootBounds: Bounds | null,
  rasterCandidates: ExtractResult['rasterCandidates'],
): Promise<ExtractedNode> {
  let componentId: string | undefined;
  let interactionStates: InteractionStates | undefined;
  if (node.type === 'COMPONENT') {
    componentId = node.id;
  } else if (node.type === 'INSTANCE' && 'getMainComponentAsync' in node) {
    try {
      const mc = await node.getMainComponentAsync();
      if (mc) componentId = mc.id;
    } catch { /* noop */ }
  }
  if (node.type === 'INSTANCE' || node.type === 'COMPONENT') {
    interactionStates = await extractInteractionStates(node);
  }

  const fills = convertFills(
    'fills' in node ? (node.fills as readonly Paint[]) : undefined,
    registry,
  );
  const strokes = convertStrokes(node);
  const effects = convertEffects(node);
  const layout = readLayout(node);
  const rawChildren: SceneNode[] = ('children' in node ? Array.from(node.children) : []) as SceneNode[];

  // Vector-cluster collapse: when a frame holds dozens of vector paths
  // (an SVG illustration imported as path soup), classify the whole frame
  // as one decorative image and skip walking the inner paths — otherwise
  // each path emits its own image widget and bloats data.json with junk.
  const vectorCluster = isVectorCluster(node, rawChildren);
  const semantic = vectorCluster
    ? { role: 'background-shape' as SemanticRole, confidence: 0.7, reason: `vector cluster (${rawChildren.length} paths) flattened as decorative asset` }
    : classifySemantic(node, fills, rawChildren, depth);
  const role = legacyRole(semantic.role);
  const styleIds = readStyleIds(node);

  const absBox = ('absoluteBoundingBox' in node && node.absoluteBoundingBox) ? node.absoluteBoundingBox : null;
  const absoluteBounds: Bounds | undefined = absBox
    ? { x: absBox.x, y: absBox.y, width: absBox.width, height: absBox.height }
    : undefined;
  const relativeBounds: Bounds | undefined = absoluteBounds && rootBounds
    ? {
        x: absoluteBounds.x - rootBounds.x,
        y: absoluteBounds.y - rootBounds.y,
        width: absoluteBounds.width,
        height: absoluteBounds.height,
      }
    : undefined;

  const result: ExtractedNode = {
    id: node.id,
    name: node.name,
    type: node.type,
    visible: node.visible,
    role,
    semanticRole: semantic.role,
    confidence: round2(semantic.confidence),
    roleReason: semantic.reason,
    parentId,
    depth,
    index,
    siblingCount,
    x: 'x' in node ? node.x : 0,
    y: 'y' in node ? node.y : 0,
    width: 'width' in node ? node.width : 0,
    height: 'height' in node ? node.height : 0,
    absoluteBounds,
    relativeBounds,
    rotation: 'rotation' in node ? node.rotation : undefined,
    opacity: 'opacity' in node ? node.opacity : undefined,
    cornerRadius: readCornerRadius(node),
    fills,
    strokes,
    effects: effects.length > 0 ? effects : undefined,
    layout,
    componentId,
    states: interactionStates,
    children: [],
    ...styleIds,
  };

  if (node.type === 'TEXT') {
    result.text = readText(node);
  }

  // Asset assignment for image-like nodes
  const isImageLike =
    role === 'image' ||
    semantic.role === 'icon' || semantic.role === 'logo' || semantic.role === 'background-shape';
  if (isImageLike) {
    const assetMeta = classifyAsset(node, semantic.role, fills);
    result.assetType = assetMeta.assetType;
    result.originalFormat = assetMeta.originalFormat;
    result.suggestedExportFormat = assetMeta.suggestedExportFormat;
    result.isDecorative = assetMeta.isDecorative;
    // Only carry the layer name as alt text when it looks meaningful —
    // generic Figma defaults ("Frame 1234", "Vector", "Rectangle 7") are
    // worse than nothing for a11y/SEO. The downstream agent can fill alt
    // from the screenshot when this is empty.
    result.altText = isGenericLayerName(node.name) ? '' : node.name;

    const imgFill = fills.find((f) => f.type === 'IMAGE');
    if (imgFill && imgFill.type === 'IMAGE') {
      result.assetId = imgFill.assetId;
    } else {
      const safe = node.id.replace(/[^a-zA-Z0-9_-]/g, '_');
      const prefix = assetMeta.assetType === 'icon' ? 'icon' :
                     assetMeta.assetType === 'logo' ? 'logo' :
                     assetMeta.assetType === 'background' ? 'bg' : 'node';
      result.assetId = `${prefix}_${safe}`;
      rasterCandidates.push({
        nodeId: node.id,
        assetId: result.assetId,
        format: assetMeta.suggestedExportFormat,
        assetType: assetMeta.assetType,
      });
    }
  }

  // Walk children — but only if this node is not itself an icon/logo/image
  // (those will be flattened into a single asset, not exported as nested DOM).
  // Vector clusters are also flattened: the inner paths become noise once
  // the cluster is exported as one rasterised asset.
  const flatten = vectorCluster || (isImageLike && (semantic.role === 'icon' || semantic.role === 'logo'));
  if (!flatten && 'children' in node && depth < maxDepth) {
    const visibleChildren = rawChildren.filter(
      (c) => !SKIPPABLE.has(c.type) && (c.visible || includeHidden),
    );
    for (let i = 0; i < visibleChildren.length; i += 1) {
      const child = visibleChildren[i];
      result.children.push(
        await walk(
          child, registry, includeHidden, maxDepth, depth + 1,
          node.id, i, visibleChildren.length, rootBounds, rasterCandidates,
        ),
      );
    }
  }

  // Compute style after children + effects + layout are populated
  result.style = computeStyle(result);

  // Detect form: a frame containing inputs
  if (semantic.role === 'container' || semantic.role === 'section') {
    const inputCount = result.children.filter((c) => c.semanticRole === 'input').length;
    if (inputCount >= 2 && !RX.form.test(node.name.toLowerCase())) {
      result.semanticRole = 'form';
      result.confidence = 0.7;
      result.roleReason = `container with ${inputCount} input children`;
    }
  }

  // Per-input shape (placeholder/inputType/required) and form-level
  // label/helperText pairing.
  if (result.semanticRole === 'input') {
    result.inputMetadata = buildInputMetadata(result);
  }
  if (result.semanticRole === 'form' || RX.form.test(node.name.toLowerCase())) {
    assignInputLabels(result);
  }

  // --- Decorative + importance (broader than the asset-only path above) --
  const finalRole = result.semanticRole ?? semantic.role;
  const broadDecorative = detectDecorative(node, finalRole, fills, effects, rawChildren.length);
  if (result.isDecorative === undefined) {
    result.isDecorative = broadDecorative;
  } else if (broadDecorative) {
    result.isDecorative = true;
  }
  const headingFlag = node.type === 'TEXT' && isHeadingText(result.text);
  result.importance = computeImportance(finalRole, !!result.isDecorative, headingFlag);

  // --- a11y bundle ------------------------------------------------------
  if (node.type === 'TEXT' && headingFlag) {
    result.headingLevel = headingLevelForSize(result.text?.fontSize ?? null);
  }
  const aria = ariaRoleFor(finalRole, headingFlag);
  if (aria) result.ariaRole = aria;

  // --- Preferred Elementor widget ---------------------------------------
  const hasImageFill = fills.some((f) => f.type === 'IMAGE');
  const widget = preferredWidgetFor(finalRole, headingFlag, hasImageFill, result.children.length);
  if (widget) result.preferredWidget = widget;

  // --- Auto-layout inference (must precede pattern + refine, both read it)
  const inferred = inferAutoLayout(result);
  if (inferred) result.inferredLayout = inferred;

  // --- Structural pattern detection (accordion / icon-list / slides) -----
  // Runs after preferredWidget so it can override the generic 'container'.
  refineSemanticAndWidget(result);

  // --- Layout pattern (canonical name) ----------------------------------
  const pattern = detectLayoutPattern(result);
  if (pattern) result.layoutPattern = pattern;

  // --- Breakpoint hints -------------------------------------------------
  const bp: BreakpointHints = {};
  if (result.layout.mode === 'HORIZONTAL' && result.children.length >= 2 && !result.isDecorative) {
    bp.mobileCollapse = true;
  }
  if (result.isDecorative && (result.width < 120 || finalRole === 'background-shape' || finalRole === 'shape')) {
    bp.hideOnMobile = true;
  }
  if (siblingCount > 1) bp.stackOrder = index;
  if (Object.keys(bp).length > 0) result.breakpoints = bp;

  // --- Component fingerprint (after children populated) ------------------
  result.componentFingerprint = computeFingerprint(result);

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

// --- Responsive hints ----------------------------------------------------

export function inferResponsive(node: ExtractedNode): ResponsiveHints | undefined {
  const layout = node.inferredLayout && node.layout.mode === 'NONE' ? node.inferredLayout : node.layout;
  if (layout.mode === 'NONE') return undefined;
  const childCount = node.children.length;
  const hints: ResponsiveHints = {};
  if (layout.mode === 'HORIZONTAL') {
    if (childCount === 2) hints.desktop = '2-column';
    else if (childCount === 3) hints.desktop = '3-column';
    else if (childCount === 4) hints.desktop = '4-column';
    else if (childCount > 4) hints.desktop = `${childCount}-column`;
    hints.tablet = childCount > 3 ? '2-column' : hints.desktop;
    hints.mobile = 'stack';
  } else if (layout.mode === 'VERTICAL') {
    hints.desktop = 'single-column';
    hints.tablet = 'single-column';
    hints.mobile = 'stack';
  } else if (layout.mode === 'GRID') {
    hints.desktop = childCount >= 3 ? '3-column' : `${Math.max(1, childCount)}-column`;
    hints.tablet = '2-column';
    hints.mobile = 'stack';
  }
  if (node.width > 0) hints.containerWidth = Math.round(node.width);
  if (layout.padding) hints.sectionPadding = layout.padding;
  if (node.semanticRole === 'section' || node.semanticRole === 'hero') {
    hints.maxWidth = Math.min(1440, Math.round(node.width));
  }
  return hints;
}

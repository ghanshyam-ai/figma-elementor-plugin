import type {
  DesignTokens,
  Effect,
  ElementorElement,
  ElementorTemplate,
  ExtractedNode,
  Fill,
  Padding,
  TextStyle,
} from './types';

// Reverse-lookup: hex color → semantic token path ("color.primary"). Built
// once per export so widget settings can carry both the resolved value and
// the original token path the agent can reuse when re-styling.
type TokenLookup = {
  color: Map<string, string>;
  fontSize: Map<number, string>;
  fontFamily: Map<string, string>;
};

function buildTokenLookup(tokens: DesignTokens): TokenLookup {
  const color = new Map<string, string>();
  const fontSize = new Map<number, string>();
  const fontFamily = new Map<string, string>();
  for (const c of tokens.colors) {
    if (c.value && !color.has(c.value.toUpperCase())) {
      color.set(c.value.toUpperCase(), `color.${c.name}`);
    }
  }
  for (const t of tokens.typography) {
    if (t.fontSize && !fontSize.has(t.fontSize)) fontSize.set(t.fontSize, `font.${t.name}.size`);
    if (t.fontFamily && !fontFamily.has(t.fontFamily)) fontFamily.set(t.fontFamily, `font.${t.name}.family`);
  }
  // Augment with semantic map keys (PAINT styles, color variables) when present.
  if (tokens.semantic) {
    for (const [key, value] of Object.entries(tokens.semantic)) {
      if (typeof value === 'string' && key.startsWith('color.')) {
        const upper = value.toUpperCase();
        if (!color.has(upper)) color.set(upper, key);
      }
    }
  }
  return { color, fontSize, fontFamily };
}

function lookupColorToken(lookup: TokenLookup | undefined, color: string | undefined): string | undefined {
  if (!lookup || !color) return undefined;
  return lookup.color.get(color.toUpperCase());
}

// Map an ExtractedNode tree to an Elementor JSON template.
//
// Container settings use Elementor's un-prefixed keys (padding, margin,
// border_radius, flex_*). Widget Advanced-tab settings use underscore-
// prefixed keys (_padding, _margin, _border_radius, _element_width,
// _position, _offset_x, _offset_y) — Elementor silently drops mismatched
// keys, so this distinction matters.

let idCounter = 0;
function nextId(): string {
  idCounter += 1;
  return `el${idCounter.toString(36).padStart(5, '0')}`;
}

export function toElementorTemplate(
  roots: ExtractedNode[],
  tokens: DesignTokens,
  title: string,
): ElementorTemplate {
  idCounter = 0;
  const lookup = buildTokenLookup(tokens);
  const content: ElementorElement[] = [];
  for (const root of roots) {
    const el = mapNode(root, tokens, lookup, /*top*/ true, /*parentLayout*/ undefined);
    if (el) content.push(el);
  }
  return {
    version: '0.4',
    title,
    type: 'page',
    content,
    page_settings: {},
  };
}

function mapNode(
  node: ExtractedNode,
  tokens: DesignTokens,
  lookup: TokenLookup,
  top: boolean,
  parentLayoutMode: ExtractedNode['layout']['mode'] | undefined,
): ElementorElement | null {
  if (!node.visible) return null;

  let el: ElementorElement | null;
  switch (node.role) {
    case 'text':
      el = mapText(node, lookup);
      break;
    case 'image':
      el = mapImage(node);
      break;
    case 'button':
      el = mapButton(node, lookup);
      break;
    case 'shape':
      el = mapShape(node, lookup);
      break;
    case 'section':
    case 'container':
    case 'unknown':
    default:
      el = mapContainer(node, tokens, lookup, top);
      break;
  }

  // Only fall back to absolute positioning when the parent really has no
  // layout — neither Figma's nor our inferred one.
  if (el && parentLayoutMode === 'NONE' && !top) {
    applyAbsolutePosition(el, node);
  }
  if (el) stampFigmaMetadata(el, node);
  return el;
}

// Stamp every Elementor settings block with the originating Figma node id +
// name, plus AI annotations when available. Lets downstream agents do
// `find_section(_figma_id=...)` and per-widget tweaks without parallel-
// walking ai-layout.json against data.json.
function stampFigmaMetadata(el: ElementorElement, node: ExtractedNode): void {
  const s = el.settings as Record<string, unknown>;
  s._figma_id = node.id;
  s._figma_name = node.name;
  if (node.semanticRole) s._ai_role = node.semanticRole;
  if (typeof node.confidence === 'number') s._ai_confidence = node.confidence;
  // Section purpose travels on container *and* widget settings — a logo
  // strip wraps each image in a widget, and the purpose is still useful
  // information for the agent there.
  if (node.sectionPurpose) {
    s._figma_section_purpose = node.sectionPurpose;
    if (node.sectionPurposeSource) s._figma_section_purpose_source = node.sectionPurposeSource;
  }
  if (node.preferredWidget && el.elType === 'widget') {
    s._ai_preferred_widget = node.preferredWidget;
  }
  // Authoritative widget hint (user-tagged or counter/logo-strip auto-tag).
  if (node.widgetHint) {
    s._widget_hint = node.widgetHint;
    if (node.widgetHintSource) s._widget_hint_source = node.widgetHintSource;
  }
  // Counter source values — parsed value + suffix + label so the agent can
  // wire an Elementor counter widget directly instead of regex-parsing the
  // heading at render time.
  if (node.counterHint) {
    s._figma_counter = {
      raw: node.counterHint.raw,
      value: node.counterHint.value,
      prefix: node.counterHint.prefix,
      suffix: node.counterHint.suffix,
      label: node.counterHint.label,
    };
  }
  if (node.contentPriority) s._ai_priority = node.contentPriority;
  // The full structural fingerprint is recursive (a parent embeds every
  // descendant's sig), which makes it kilobyte-class on deep trees and
  // useless to repeat on every container. Pre-grouped data lives in
  // aiLayout.componentTemplates; per-node routing only needs the group id.
  if (node.instanceGroup) s._figma_instance_group = node.instanceGroup;
}

// --- Container -----------------------------------------------------------

function mapContainer(
  node: ExtractedNode,
  tokens: DesignTokens,
  lookup: TokenLookup,
  top: boolean,
): ElementorElement {
  // When Figma's layoutMode is NONE but extractor inferred a clean stack,
  // use the inferred values for direction / spacing / padding; children
  // still report their original geometry (so absolute fallback would also
  // work) but the parent now flows them via flex.
  const usingInferred = node.layout.mode === 'NONE' && !!node.inferredLayout;
  const effectiveLayout = usingInferred ? (node.inferredLayout as NonNullable<typeof node.inferredLayout>) : node.layout;
  const layoutMode = effectiveLayout.mode;
  const isFlex = layoutMode === 'HORIZONTAL' || layoutMode === 'VERTICAL';

  const children: ElementorElement[] = [];
  for (const c of node.children) {
    const child = mapNode(c, tokens, lookup, false, layoutMode);
    if (child) children.push(child);
  }

  const shadow = boxShadowSettings(node.effects);
  const bgColor = solidColor(node.fills);
  const bgImage = imageBackground(node.fills);
  const gradient = gradientBackground(node.fills);
  // Border from the frame's stroke (mapShape/mapButton already do this; a
  // bordered card/section/input frame becomes a container, so it needs the
  // same treatment or it loses its outline on import).
  const stroke = node.strokes[0];
  const settings: Record<string, unknown> = {
    background_background: backgroundType(node.fills),
    background_color: elementorColor(bgColor),
    background_image: bgImage,
    border_radius: borderRadiusSetting(node.cornerRadius),
    box_shadow_box_shadow_type: shadow ? 'yes' : undefined,
    box_shadow_box_shadow: shadow,
    border_border: stroke ? 'solid' : undefined,
    border_width: stroke ? uniformPx(stroke.weight) : undefined,
    border_color: stroke ? elementorColor(stroke.color) : undefined,
  };
  if (gradient) Object.assign(settings, gradient);
  // Background-blur cannot be expressed via Elementor controls. Stamp the
  // effect on settings so the agent can wire a custom-CSS rule with
  // backdrop-filter at publish time.
  const backdropBlur = backdropFilterValue(node.effects);
  if (backdropBlur) settings._figma_backdrop_filter = backdropBlur;
  const bgToken = lookupColorToken(lookup, bgColor);
  if (bgToken) attachToken(settings, 'background_color', bgToken);

  if (top) {
    // Top-level container: default to full-width content so the imported
    // page is responsive. The original Figma frame width is preserved on
    // _figma_frame_width for downstream tooling that wants to recreate the
    // designer's exact canvas. min_height is only emitted when a background
    // image needs the section to actually be that tall — otherwise the
    // section grows to fit its children, which is what Elementor users want.
    settings.content_width = 'full';
    settings._figma_frame_width = sizePx(node.width);
    if (bgImage) settings.min_height = sizePx(node.height);
  } else {
    settings.width = containerWidthSetting(node);
    const mh = containerMinHeight(node);
    if (mh) settings.min_height = mh;
  }

  if (isFlex) {
    settings.flex_direction = layoutMode === 'HORIZONTAL' ? 'row' : 'column';
    if (effectiveLayout.itemSpacing) {
      settings.flex_gap = sizePx(effectiveLayout.itemSpacing);
    }
    settings.flex_justify_content = alignToFlex(effectiveLayout.primaryAlign);
    settings.flex_align_items = alignToFlex(effectiveLayout.counterAlign);
    settings.flex_wrap = effectiveLayout.wrap ? 'wrap' : 'nowrap';
    settings.padding = paddingSetting(effectiveLayout.padding);
    if (usingInferred) {
      // Tell the agent the auto-layout came from us, not Figma — they may
      // want to verify against the screenshot before publishing.
      settings._figma_layout_inferred = true;
    }
  } else {
    // No auto layout — children will be absolutely positioned.
    // Container itself holds explicit width/height; no flex props.
  }

  return {
    id: nextId(),
    elType: 'container',
    isInner: !top,
    settings: clean(settings),
    elements: children,
  };
}

// --- Text widget ---------------------------------------------------------

function mapText(node: ExtractedNode, lookup: TokenLookup): ElementorElement {
  const t = node.text!;
  const heading = isHeading(t);
  const tag = headingTag(t.fontSize ?? 16);
  const colorKey = heading ? 'title_color' : 'text_color';

  const settings: Record<string, unknown> = heading
    ? {
        title: t.characters,
        header_size: tag,
        align: alignToText(t.align),
        title_color: elementorColor(t.color ?? undefined),
        typography_typography: 'custom',
        typography_font_family: t.fontFamily ?? undefined,
        typography_font_size: t.fontSize ? sizePx(t.fontSize) : undefined,
        typography_font_weight: t.fontWeight ?? undefined,
        typography_line_height: lineHeightSetting(t),
        typography_letter_spacing: letterSpacingSetting(t),
        typography_text_transform: textCaseToCss(t.textCase),
        typography_text_decoration: textDecorationCss(t.textDecoration),
      }
    : {
        editor: textEditorHtml(t),
        align: alignToText(t.align),
        text_color: elementorColor(t.color ?? undefined),
        typography_typography: 'custom',
        typography_font_family: t.fontFamily ?? undefined,
        typography_font_size: t.fontSize ? sizePx(t.fontSize) : undefined,
        typography_font_weight: t.fontWeight ?? undefined,
        typography_line_height: lineHeightSetting(t),
        typography_letter_spacing: letterSpacingSetting(t),
      };

  const colorToken = lookupColorToken(lookup, t.color ?? undefined);
  if (colorToken) attachToken(settings, colorKey, colorToken);
  if (t.fontFamily) {
    const famToken = lookup.fontFamily.get(t.fontFamily);
    if (famToken) attachToken(settings, 'typography_font_family', famToken);
  }
  if (t.fontSize) {
    const sizeToken = lookup.fontSize.get(t.fontSize);
    if (sizeToken) attachToken(settings, 'typography_font_size', sizeToken);
  }

  return {
    id: nextId(),
    elType: 'widget',
    widgetType: heading ? 'heading' : 'text-editor',
    settings: clean(settings),
    elements: [],
  };
}

// --- Image widget --------------------------------------------------------

function mapImage(node: ExtractedNode): ElementorElement {
  const ext = node.suggestedExportFormat ?? 'png';
  const filename = node.assetId ? `${node.assetId}.${ext}` : `${node.id}.png`;
  return {
    id: nextId(),
    elType: 'widget',
    widgetType: 'image',
    settings: clean({
      image: {
        url: `assets/images/${filename}`,
        // Empty id signals an external/unmanaged image — Elementor will use
        // the URL directly instead of looking up a WP attachment.
        id: '',
        alt: imageAlt(node),
        source: 'url',
        // _placeholder + _figma_asset_id are explicit "needs rewrite"
        // signals: the downstream agent uploads the asset to WP media,
        // sets `id` to the attachment id, and clears these flags.
        _placeholder: true,
        _figma_asset_id: node.assetId,
      },
      image_size: 'full',
      _element_width: 'initial',
      _element_custom_width: sizePx(node.width),
      height: sizePx(node.height),
      _border_radius: borderRadiusSetting(node.cornerRadius),
    }),
    elements: [],
  };
}

// Return the explicit alt text when the layer was given a meaningful
// name. Defaults to empty for generic Figma names ("Frame 1234", "Vector",
// "Rectangle 7") so we don't pollute Elementor's alt field with noise the
// agent (and screen readers) have to undo later.
const GENERIC_LAYER_NAME_RX = /^(Frame|Group|Rectangle|Ellipse|Vector|Component|Instance|Path|Image) ?\d*$/i;
function imageAlt(node: ExtractedNode): string {
  const raw = (node.altText ?? node.name ?? '').trim();
  if (!raw) return '';
  if (GENERIC_LAYER_NAME_RX.test(raw)) return '';
  return raw;
}

// --- Button widget -------------------------------------------------------

function mapButton(node: ExtractedNode, lookup: TokenLookup): ElementorElement {
  const innerText = findFirstTextNode(node);
  const label = innerText?.text?.characters ?? node.name;
  const fillColor = solidColor(node.fills);
  const textColor = innerText?.text?.color ?? undefined;
  const fontSize = innerText?.text?.fontSize ?? undefined;
  const fontFamily = innerText?.text?.fontFamily ?? undefined;
  const fontWeight = innerText?.text?.fontWeight ?? undefined;

  const stroke = node.strokes[0];

  // Hover settings are only emitted when the Figma component actually
  // exposed a hover variant — otherwise we'd lock the button to its base
  // colors on hover and disable Elementor's default treatment (theme
  // darken / accent shift).
  const hover = node.states?.hover;
  const hoverBg = hover?.background;
  const hoverText = hover?.color;
  const hoverBorder = hover?.borderColor;

  const settings: Record<string, unknown> = {
    text: label,
    link: buttonLink(node, innerText),
    align: 'left',
    size: buttonSizeFromHeight(node.height),
    button_type: '',
    view: 'traditional',
    typography_typography: fontSize || fontFamily ? 'custom' : undefined,
    typography_font_family: fontFamily,
    typography_font_size: fontSize ? sizePx(fontSize) : undefined,
    typography_font_weight: fontWeight,
    background_color: elementorColor(fillColor),
    button_text_color: elementorColor(textColor),
    hover_color: elementorColor(hoverText),
    button_background_hover_color: elementorColor(hoverBg),
    button_hover_border_color: elementorColor(hoverBorder),
    border_border: stroke ? 'solid' : undefined,
    border_width: stroke ? uniformPx(stroke.weight) : undefined,
    border_color: stroke ? elementorColor(stroke.color) : undefined,
    border_radius: borderRadiusSetting(node.cornerRadius),
    text_padding: paddingSetting(node.layout.padding),
  };

  // Token paths (Elementor still needs the raw value but the agent can
  // read __tokens__ to know the semantic name).
  const bgToken = lookupColorToken(lookup, fillColor);
  if (bgToken) attachToken(settings, 'background_color', bgToken);
  const textToken = lookupColorToken(lookup, textColor);
  if (textToken) attachToken(settings, 'button_text_color', textToken);
  if (hoverBg) {
    const hoverBgToken = lookupColorToken(lookup, hoverBg);
    if (hoverBgToken) attachToken(settings, 'button_background_hover_color', hoverBgToken);
  }

  return {
    id: nextId(),
    elType: 'widget',
    widgetType: 'button',
    settings: clean(settings),
    elements: [],
  };
}

// Pull a hyperlink off the button's inner text (Figma exposes per-run
// links via TextRun.link). Falls back to Elementor's empty-link shape so
// the widget renders correctly even when the designer didn't wire a URL.
function buttonLink(_node: ExtractedNode, innerText: ExtractedNode | null) {
  const runs = innerText?.text?.runs;
  if (runs && runs.length > 0) {
    const linked = runs.find((r) => r.link && r.link.value);
    if (linked && linked.link) {
      const url = linked.link.value;
      const isExternal = /^https?:\/\//i.test(url);
      return { url, is_external: isExternal ? 'on' : '', nofollow: '' };
    }
  }
  return { url: '', is_external: '', nofollow: '' };
}

// --- Shape (decorative) --------------------------------------------------

function mapShape(node: ExtractedNode, lookup: TokenLookup): ElementorElement | null {
  if (node.fills.length === 0 && node.strokes.length === 0) return null;

  const hasSolid = node.fills.some((f) => f.type === 'SOLID');
  const hasGradient = node.fills.some((f) => f.type.startsWith('GRADIENT'));
  const hasImage = node.fills.some((f) => f.type === 'IMAGE');
  const hasStroke = node.strokes.length > 0;
  const hasFill = hasSolid || hasGradient || hasImage;

  // A spacer with no fill is fine — it just reserves vertical space. As
  // soon as the shape carries any paint, the spacer widget swallows it
  // (Elementor's spacer ignores background_* settings on most themes).
  // Emit an inner container instead so the color/gradient/image survives.
  if (hasFill) {
    const bgColor = solidColor(node.fills);
    const gradient = gradientBackground(node.fills);
    const bgImage = imageBackground(node.fills);
    const shadow = boxShadowSettings(node.effects);
    const settings: Record<string, unknown> = {
      background_background: backgroundType(node.fills),
      background_color: elementorColor(bgColor),
      background_image: bgImage,
      border_radius: borderRadiusSetting(node.cornerRadius),
      box_shadow_box_shadow_type: shadow ? 'yes' : undefined,
      box_shadow_box_shadow: shadow,
      width: { unit: 'px', size: Math.round(node.width), sizes: [] },
      min_height: sizePx(node.height),
      border_border: hasStroke ? 'solid' : undefined,
      border_width: hasStroke ? uniformPx(node.strokes[0].weight) : undefined,
      border_color: hasStroke ? elementorColor(node.strokes[0].color) : undefined,
    };
    if (gradient) Object.assign(settings, gradient);
    const bgToken = lookupColorToken(lookup, bgColor);
    if (bgToken) attachToken(settings, 'background_color', bgToken);
    return {
      id: nextId(),
      elType: 'container',
      isInner: true,
      settings: clean(settings),
      elements: [],
    };
  }

  // Stroke-only thin shapes act as dividers. Anything else just reserves
  // vertical space.
  const isThinDivider = hasStroke && !hasFill && (node.height <= 4 || node.width <= 4);
  if (isThinDivider) {
    const s = node.strokes[0];
    return {
      id: nextId(),
      elType: 'widget',
      widgetType: 'divider',
      settings: clean({
        color: elementorColor(s.color),
        weight: { unit: 'px', size: Math.round(s.weight), sizes: [] },
        style: 'solid',
        _element_width: 'initial',
        _element_custom_width: sizePx(node.width),
      }),
      elements: [],
    };
  }

  return {
    id: nextId(),
    elType: 'widget',
    widgetType: 'spacer',
    settings: clean({
      space: sizePx(node.height),
      _element_width: 'initial',
      _element_custom_width: sizePx(node.width),
    }),
    elements: [],
  };
}

// --- Absolute positioning (for non-auto-layout parents) ------------------

function applyAbsolutePosition(el: ElementorElement, node: ExtractedNode) {
  Object.assign(el.settings, {
    _position: 'absolute',
    _offset_orientation_h: 'start',
    _offset_x: sizePx(node.x),
    _offset_orientation_v: 'start',
    _offset_y: sizePx(node.y),
    _element_width: 'initial',
    _element_custom_width: sizePx(node.width),
  });
}

// --- Helpers -------------------------------------------------------------

function clean<T extends Record<string, unknown>>(o: T): T {
  for (const k of Object.keys(o)) {
    if (o[k] === undefined) delete o[k];
  }
  return o;
}

// Stash a token path under settings.__tokens__[settingKey]. Lets the agent
// see "title_color is color.primary" without having to reverse-match by hex.
function attachToken(settings: Record<string, unknown>, settingKey: string, tokenPath: string): void {
  const existing = settings.__tokens__ as Record<string, string> | undefined;
  const map = existing ?? {};
  map[settingKey] = tokenPath;
  settings.__tokens__ = map;
}

// Convert an 8-digit hex (#RRGGBBAA, produced by the extractor for fills /
// strokes / shadows with opacity < 1) into a CSS rgba() string. Elementor's
// color controls do not reliably apply the alpha channel from 8-digit hex —
// they expect rgba() — so any color written into Elementor settings goes
// through here. 6-digit hex and already-rgba values pass through unchanged.
// NOTE: only apply this to *output* values, never to the key used for token
// lookup (tokens are keyed by the raw hex).
function elementorColor(c: string | undefined): string | undefined {
  if (!c) return c;
  const m = /^#([0-9a-fA-F]{6})([0-9a-fA-F]{2})$/.exec(c);
  if (!m) return c;
  const r = parseInt(m[1].slice(0, 2), 16);
  const g = parseInt(m[1].slice(2, 4), 16);
  const b = parseInt(m[1].slice(4, 6), 16);
  const a = Math.round((parseInt(m[2], 16) / 255) * 100) / 100;
  if (a >= 1) return `#${m[1].toUpperCase()}`;
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

function sizePx(v: number) {
  return { unit: 'px', size: Math.round(v), sizes: [] };
}

function uniformPx(v: number) {
  const s = String(Math.round(v));
  return { unit: 'px', top: s, right: s, bottom: s, left: s, isLinked: true };
}

function paddingSetting(p?: Padding) {
  if (!p) return undefined;
  if (p.top === 0 && p.right === 0 && p.bottom === 0 && p.left === 0) {
    return undefined;
  }
  return {
    unit: 'px',
    top: String(Math.round(p.top)),
    right: String(Math.round(p.right)),
    bottom: String(Math.round(p.bottom)),
    left: String(Math.round(p.left)),
    isLinked: p.top === p.right && p.right === p.bottom && p.bottom === p.left,
  };
}

function alignToFlex(a?: string): string | undefined {
  switch (a) {
    case 'MIN': return 'flex-start';
    case 'MAX': return 'flex-end';
    case 'CENTER': return 'center';
    case 'SPACE_BETWEEN': return 'space-between';
    default: return undefined;
  }
}

function alignToText(a?: TextStyle['align']): string | undefined {
  if (!a) return undefined;
  if (a === 'JUSTIFIED') return 'justify';
  return a.toLowerCase();
}

function backgroundType(fills: Fill[]): string | undefined {
  if (fills.length === 0) return undefined;
  const first = fills[0];
  if (first.type === 'SOLID') return 'classic';
  if (first.type === 'IMAGE') return 'classic';
  return 'gradient';
}

function solidColor(fills: Fill[]): string | undefined {
  const f = fills.find((x) => x.type === 'SOLID');
  return f && f.type === 'SOLID' ? f.color : undefined;
}

function imageBackground(fills: Fill[]) {
  const f = fills.find((x) => x.type === 'IMAGE');
  if (!f || f.type !== 'IMAGE') return undefined;
  // Image fills are always rasterised PNGs — registry stores them as such.
  // The wrapper carries _placeholder + _figma_asset_id so downstream agents
  // know the URL must be rewritten to a real WordPress media URL.
  return {
    url: `assets/images/${f.assetId}.png`,
    id: '',
    alt: '',
    source: 'url',
    _placeholder: true,
    _figma_asset_id: f.assetId,
  };
}

// Translate a Figma gradient fill to Elementor's flat gradient settings.
// Elementor expresses gradients as a pair of stops (start + end colors,
// positions, type, angle/position). We pick the first and last stops as
// the canonical pair — any intermediate stops are surfaced on
// _figma_gradient_stops so the agent can layer a custom CSS gradient when
// the design uses ≥3 stops.
function gradientBackground(fills: Fill[]): Record<string, unknown> | undefined {
  const f = fills.find((x) => x.type.startsWith('GRADIENT')) as
    | (Fill & { stops?: { position: number; color: string }[]; angle?: number; type: string })
    | undefined;
  if (!f || !('stops' in f) || !f.stops || f.stops.length === 0) return undefined;
  const first = f.stops[0];
  const last = f.stops[f.stops.length - 1];
  const isRadial = f.type === 'GRADIENT_RADIAL' || f.type === 'GRADIENT_DIAMOND';
  const out: Record<string, unknown> = {
    background_background: 'gradient',
    background_color: elementorColor(first.color),
    background_color_stop: { unit: '%', size: Math.round(first.position * 100), sizes: [] },
    background_color_b: elementorColor(last.color),
    background_color_b_stop: { unit: '%', size: Math.round(last.position * 100), sizes: [] },
    background_gradient_type: isRadial ? 'radial' : 'linear',
  };
  if (!isRadial && typeof f.angle === 'number') {
    out.background_gradient_angle = { unit: 'deg', size: Math.round(f.angle), sizes: [] };
  } else if (isRadial) {
    out.background_gradient_position = 'center center';
  }
  if (f.stops.length > 2) out._figma_gradient_stops = f.stops;
  return out;
}

// Background-blur effect → backdrop-filter CSS value. Returns a CSS string
// the agent can drop into custom CSS; undefined when no background blur.
function backdropFilterValue(effects: Effect[] | undefined): string | undefined {
  if (!effects) return undefined;
  const blur = effects.find((e) => e.type === 'BACKGROUND_BLUR') as
    | (Effect & { radius?: number })
    | undefined;
  if (!blur) return undefined;
  const r = blur.radius ?? 0;
  if (r <= 0) return undefined;
  return `blur(${Math.round(r)}px)`;
}

function boxShadowSettings(effects: Effect[] | undefined) {
  if (!effects || effects.length === 0) return undefined;
  const shadow = effects.find((e) => e.type === 'DROP_SHADOW' || e.type === 'INNER_SHADOW');
  if (!shadow || (shadow.type !== 'DROP_SHADOW' && shadow.type !== 'INNER_SHADOW')) return undefined;
  return {
    horizontal: Math.round(shadow.offsetX),
    vertical: Math.round(shadow.offsetY),
    blur: Math.round(shadow.radius),
    spread: Math.round(shadow.spread),
    color: elementorColor(shadow.color),
    position: shadow.type === 'INNER_SHADOW' ? 'inset' : '',
  };
}

function borderRadiusSetting(cr: ExtractedNode['cornerRadius']) {
  if (cr === undefined) return undefined;
  if (typeof cr === 'number') {
    if (cr === 0) return undefined;
    const s = String(Math.round(cr));
    return { unit: 'px', top: s, right: s, bottom: s, left: s, isLinked: true };
  }
  return {
    unit: 'px',
    top: String(Math.round(cr.tl)),
    right: String(Math.round(cr.tr)),
    bottom: String(Math.round(cr.br)),
    left: String(Math.round(cr.bl)),
    isLinked: cr.tl === cr.tr && cr.tr === cr.br && cr.br === cr.bl,
  };
}

function containerWidthSetting(node: ExtractedNode) {
  const sizing = node.layout.sizingHorizontal;
  if (sizing === 'FILL') return { unit: '%', size: 100, sizes: [] };
  if (sizing === 'HUG') return undefined;
  // FIXED, or no auto-layout info — fall back to the actual frame width.
  return sizePx(node.width);
}

function containerMinHeight(node: ExtractedNode) {
  const sizing = node.layout.sizingVertical;
  if (sizing === 'FILL' || sizing === 'HUG') return undefined;
  // FIXED or no auto-layout — use frame height.
  if (node.height > 0) return sizePx(node.height);
  return undefined;
}

function isHeading(t: TextStyle): boolean {
  const size = t.fontSize ?? 0;
  const weight = t.fontWeight ?? 400;
  if (size >= 24) return true;
  if (size >= 18 && weight >= 600) return true;
  return false;
}

function headingTag(size: number): 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6' {
  if (size >= 48) return 'h1';
  if (size >= 36) return 'h2';
  if (size >= 28) return 'h3';
  if (size >= 22) return 'h4';
  if (size >= 18) return 'h5';
  return 'h6';
}

function buttonSizeFromHeight(h: number): string {
  if (h <= 32) return 'xs';
  if (h <= 40) return 'sm';
  if (h <= 48) return 'md';
  if (h <= 56) return 'lg';
  return 'xl';
}

function lineHeightSetting(t: TextStyle) {
  if (!t.lineHeight) return undefined;
  if (t.lineHeight === 'AUTO') return undefined;
  if (t.lineHeight.unit === 'PERCENT') {
    return { unit: 'em', size: t.lineHeight.value / 100, sizes: [] };
  }
  return { unit: 'px', size: Math.round(t.lineHeight.value), sizes: [] };
}

function letterSpacingSetting(t: TextStyle) {
  if (!t.letterSpacing) return undefined;
  return { unit: 'px', size: round1(t.letterSpacing.value), sizes: [] };
}

function round1(v: number) { return Math.round(v * 10) / 10; }

function textCaseToCss(c: string | null): string | undefined {
  if (!c) return undefined;
  switch (c) {
    case 'UPPER': return 'uppercase';
    case 'LOWER': return 'lowercase';
    case 'TITLE': return 'capitalize';
    default: return 'none';
  }
}

function textDecorationCss(d: string | null): string | undefined {
  if (!d) return undefined;
  switch (d) {
    case 'UNDERLINE': return 'underline';
    case 'STRIKETHROUGH': return 'line-through';
    default: return 'none';
  }
}

function findFirstTextNode(node: ExtractedNode): ExtractedNode | null {
  if (node.text) return node;
  for (const c of node.children) {
    const t = findFirstTextNode(c);
    if (t) return t;
  }
  return null;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/"/g, '&quot;');
}

// Build the editor HTML for a text-editor widget. Prefers inline rich-text
// runs (bold keywords, inline links, colored spans) when the Figma text
// node had more than one styled segment; otherwise falls back to the plain
// escape+newline path. Returns block-complete HTML (already wrapped in
// <p>/<ul>) — callers must NOT wrap it again.
function textEditorHtml(t: TextStyle): string {
  if (t.runs && t.runs.length > 1) return runsToHtml(t);
  return escapeRichText(t.characters);
}

// Reconstruct inline formatting from per-segment runs relative to the base
// style. Only deltas that Elementor can express inline are emitted: weight
// (≥600 → <strong>), underline, hyperlinks, and color overrides.
function runsToHtml(t: TextStyle): string {
  const runs = t.runs ?? [];
  const baseWeight = t.fontWeight ?? 400;
  let inner = '';
  for (const r of runs) {
    let text = escapeHtml(r.text).split(/\r?\n/).join('<br>');
    let open = '';
    let close = '';
    const weight = r.fontWeight ?? baseWeight;
    if (weight >= 600 && baseWeight < 600) { open += '<strong>'; close = '</strong>' + close; }
    if (r.textDecoration === 'UNDERLINE') { open += '<u>'; close = '</u>' + close; }
    if (r.color && r.color !== t.color) {
      open += `<span style="color:${elementorColor(r.color)}">`;
      close = '</span>' + close;
    }
    if (r.link && r.link.value) {
      const url = r.link.value;
      const ext = /^https?:\/\//i.test(url) ? ' target="_blank" rel="noopener"' : '';
      open += `<a href="${escapeAttr(url)}"${ext}>`;
      close = '</a>' + close;
    }
    inner += open + text + close;
  }
  return `<p>${inner}</p>`;
}

// Escape user-authored copy for an Elementor text-editor widget and
// preserve newlines as <br> so multi-line paragraphs survive the round
// trip. Bullet-style prefixes ("- ", "• ", "* ") are wrapped into a real
// <ul> so Elementor's editor renders a proper list rather than a flat
// run with leading dashes. Returns block-complete HTML.
function escapeRichText(s: string): string {
  const escaped = escapeHtml(s);
  const lines = escaped.split(/\r?\n/);
  const bulletRx = /^\s*(?:[-•*]|•)\s+(.+)$/;
  const isAllBullets = lines.length >= 2 && lines.every((l) => l.trim() === '' || bulletRx.test(l));
  if (isAllBullets) {
    const items = lines
      .filter((l) => l.trim() !== '')
      .map((l) => `<li>${l.replace(bulletRx, '$1')}</li>`)
      .join('');
    return `<ul>${items}</ul>`;
  }
  return `<p>${lines.join('<br>')}</p>`;
}

// Walk template to count widgets/sections (used in metadata). Only top-level
// containers count as "sections" — nested containers are layout machinery,
// not page sections, and including them inflates the count by ~10×.
export function tallyTemplate(t: ElementorTemplate): { sections: number; widgets: number } {
  let sections = 0;
  let widgets = 0;
  function walk(el: ElementorElement, depth: number) {
    if (el.elType === 'container') {
      if (depth === 0) sections += 1;
    } else {
      widgets += 1;
    }
    for (const c of el.elements) walk(c, depth + 1);
  }
  for (const c of t.content) walk(c, 0);
  return { sections, widgets };
}

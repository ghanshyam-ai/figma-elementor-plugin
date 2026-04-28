import type {
  DesignTokens,
  ElementorElement,
  ElementorTemplate,
  ExtractedNode,
  Fill,
  Padding,
  TextStyle,
} from './types';

// Map an ExtractedNode tree to an Elementor JSON template.
// We aim for "minimal nesting + clean settings" rather than perfect fidelity.

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
  const content: ElementorElement[] = [];
  for (const root of roots) {
    const el = mapNode(root, tokens, /*top*/ true);
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
  top: boolean,
): ElementorElement | null {
  if (!node.visible) return null;

  switch (node.role) {
    case 'text':
      return mapText(node);
    case 'image':
      return mapImage(node);
    case 'button':
      return mapButton(node);
    case 'shape':
      // Shapes that aren't images become decorative containers; skip if empty.
      return mapShape(node);
    case 'section':
    case 'container':
    case 'unknown':
      return mapContainer(node, tokens, top);
  }
}

// --- Container -----------------------------------------------------------

function mapContainer(
  node: ExtractedNode,
  tokens: DesignTokens,
  top: boolean,
): ElementorElement {
  const children: ElementorElement[] = [];
  for (const c of node.children) {
    const el = mapNode(c, tokens, false);
    if (el) children.push(el);
  }

  const settings: Record<string, unknown> = {
    content_width: top ? 'full' : 'boxed',
    flex_direction: node.layout.mode === 'HORIZONTAL' ? 'row' : 'column',
    flex_gap: node.layout.itemSpacing
      ? sizePx(node.layout.itemSpacing)
      : undefined,
    flex_justify_content: alignToFlex(node.layout.primaryAlign),
    flex_align_items: alignToFlex(node.layout.counterAlign),
    flex_wrap: node.layout.wrap ? 'wrap' : 'nowrap',
    padding: paddingSetting(node.layout.padding),
    background_background: backgroundType(node.fills),
    background_color: solidColor(node.fills),
    background_image: imageBackground(node.fills),
    border_radius: borderRadiusSetting(node.cornerRadius),
    width: top ? undefined : sizingWidth(node),
    min_height: top ? sizePx(node.height) : undefined,
    _figma_id: node.id,
    _figma_name: node.name,
  };

  return {
    id: nextId(),
    elType: 'container',
    isInner: !top,
    settings: clean(settings),
    elements: children,
  };
}

// --- Text widget ---------------------------------------------------------

function mapText(node: ExtractedNode): ElementorElement {
  const t = node.text!;
  const isHeading = (t.fontSize ?? 0) >= 18;
  const tag = headingTag(t.fontSize ?? 16);

  const settings: Record<string, unknown> = isHeading
    ? {
        title: t.characters,
        header_size: tag,
        align: alignToText(t.align),
        title_color: t.color ?? undefined,
        typography_typography: 'custom',
        typography_font_family: t.fontFamily ?? undefined,
        typography_font_size: t.fontSize ? sizePx(t.fontSize) : undefined,
        typography_font_weight: t.fontWeight ?? undefined,
        typography_line_height: lineHeightSetting(t),
        typography_letter_spacing: letterSpacingSetting(t),
        typography_text_transform: textCaseToCss(t.textCase),
        typography_text_decoration: textDecorationCss(t.textDecoration),
        _figma_id: node.id,
      }
    : {
        editor: `<p>${escapeHtml(t.characters)}</p>`,
        align: alignToText(t.align),
        text_color: t.color ?? undefined,
        typography_typography: 'custom',
        typography_font_family: t.fontFamily ?? undefined,
        typography_font_size: t.fontSize ? sizePx(t.fontSize) : undefined,
        typography_font_weight: t.fontWeight ?? undefined,
        typography_line_height: lineHeightSetting(t),
        typography_letter_spacing: letterSpacingSetting(t),
        _figma_id: node.id,
      };

  return {
    id: nextId(),
    elType: 'widget',
    widgetType: isHeading ? 'heading' : 'text-editor',
    settings: clean(settings),
    elements: [],
  };
}

// --- Image widget --------------------------------------------------------

function mapImage(node: ExtractedNode): ElementorElement {
  const filename = node.assetId ? `${node.assetId}.png` : `${node.id}.png`;
  return {
    id: nextId(),
    elType: 'widget',
    widgetType: 'image',
    settings: clean({
      image: {
        url: `assets/images/${filename}`,
        id: node.assetId,
      },
      image_size: 'full',
      width: sizePx(node.width),
      height: sizePx(node.height),
      border_radius: borderRadiusSetting(node.cornerRadius),
      _figma_id: node.id,
      _figma_name: node.name,
    }),
    elements: [],
  };
}

// --- Button widget -------------------------------------------------------

function mapButton(node: ExtractedNode): ElementorElement {
  const label = findFirstText(node) ?? node.name;
  const fill = node.fills.find((f) => f.type === 'SOLID');
  return {
    id: nextId(),
    elType: 'widget',
    widgetType: 'button',
    settings: clean({
      text: label,
      align: 'left',
      background_color: fill && fill.type === 'SOLID' ? fill.color : undefined,
      border_radius: borderRadiusSetting(node.cornerRadius),
      _figma_id: node.id,
      _figma_name: node.name,
    }),
    elements: [],
  };
}

// --- Shape (decorative) --------------------------------------------------

function mapShape(node: ExtractedNode): ElementorElement | null {
  // Skip purely decorative shapes with no fill — they would just clutter the JSON.
  if (node.fills.length === 0 && node.strokes.length === 0) return null;
  return {
    id: nextId(),
    elType: 'widget',
    widgetType: 'spacer',
    settings: clean({
      space: sizePx(node.height),
      background_background: backgroundType(node.fills),
      background_color: solidColor(node.fills),
      border_radius: borderRadiusSetting(node.cornerRadius),
      _figma_id: node.id,
      _figma_name: node.name,
    }),
    elements: [],
  };
}

// --- Helpers -------------------------------------------------------------

function clean<T extends Record<string, unknown>>(o: T): T {
  for (const k of Object.keys(o)) {
    if (o[k] === undefined) delete o[k];
  }
  return o;
}

function sizePx(v: number) {
  return { unit: 'px', size: Math.round(v), sizes: [] };
}

function paddingSetting(p?: Padding) {
  if (!p) return undefined;
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
  return { url: `assets/images/${f.assetId}.png`, id: f.assetId };
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

function sizingWidth(node: ExtractedNode) {
  if (node.layout.sizingHorizontal === 'FILL') {
    return { unit: '%', size: 100, sizes: [] };
  }
  if (node.layout.sizingHorizontal === 'HUG') return undefined;
  return sizePx(node.width);
}

function headingTag(size: number): 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6' {
  if (size >= 48) return 'h1';
  if (size >= 36) return 'h2';
  if (size >= 28) return 'h3';
  if (size >= 22) return 'h4';
  if (size >= 18) return 'h5';
  return 'h6';
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

function findFirstText(node: ExtractedNode): string | null {
  if (node.text) return node.text.characters;
  for (const c of node.children) {
    const t = findFirstText(c);
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

// Walk template to count widgets/sections (used in metadata).
export function tallyTemplate(t: ElementorTemplate): { sections: number; widgets: number } {
  let sections = 0;
  let widgets = 0;
  function walk(el: ElementorElement) {
    if (el.elType === 'container') sections += 1;
    else widgets += 1;
    for (const c of el.elements) walk(c);
  }
  for (const c of t.content) walk(c);
  return { sections, widgets };
}

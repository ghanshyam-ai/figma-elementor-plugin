import type {
  DesignTokens,
  Effect,
  ElementorElement,
  ElementorSettings,
  ElementorTemplate,
  ElementorTemplateType,
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

// Widget intents the plugin's catalog/tagging UI exposes but the mapper does
// NOT emit as a real widget (they fall through to a container / heading /
// text-editor). We stamp `_unbuilt_widget_intent` on the fallback element so
// the downstream agent knows the designer's intent and can build the proper
// widget instead of treating the container as final.
const UNBUILT_WIDGET_INTENTS: ReadonlySet<string> = new Set([
  'nav-menu', 'image-carousel', 'testimonial-carousel', 'slides',
  'price-table', 'price-list', 'posts', 'social-icons', 'video',
  'progress', 'star-rating', 'image-box', 'icon-box',
]);

// Every heading widget emitted in the current export, with its Figma font
// size. Used after the tree is mapped to guarantee the page carries exactly
// one h1 (see ensureSingleH1). Reset at the start of each export.
let headingRegistry: { el: ElementorElement; size: number }[] = [];

// Finalized exporter output the mapper rewrites asset references from.
//   assetFiles      assetId (and aliases) → final filename in assets/images/
//   referenceFiles  figma node id → rendered 2x reference filename
// When absent (tests, dry runs) the mapper falls back to the extractor's
// suggested extension, which is the pre-export best guess.
export type MapperAssetInfo = {
  assetFiles?: ReadonlyMap<string, string>;
  referenceFiles?: ReadonlyMap<string, string>;
};

let assetInfo: MapperAssetInfo = {};

// True when the root being mapped has NO explicit tablet/mobile Figma frame
// paired in, so the conservative heuristic collapse may apply. Explicit
// Figma data always wins over assumptions.
let heuristicResponsive = true;

function assetFilename(assetId: string, fallbackExt: string): string {
  return assetInfo.assetFiles?.get(assetId) ?? `${assetId}.${fallbackExt}`;
}

export function toElementorTemplate(
  roots: ExtractedNode[],
  tokens: DesignTokens,
  title: string,
  type?: ElementorTemplateType,
  assets: MapperAssetInfo = {},
): ElementorTemplate {
  idCounter = 0;
  repeaterIdCounter = 0;
  headingRegistry = [];
  assetInfo = assets;
  const lookup = buildTokenLookup(tokens);
  const content: ElementorElement[] = [];
  for (const root of roots) {
    heuristicResponsive = !(root.pairedBreakpoints && root.pairedBreakpoints.length > 0);
    const el = mapNode(root, tokens, lookup, /*top*/ true, /*parentLayout*/ undefined);
    if (el) content.push(el);
  }
  ensureSingleH1(headingRegistry);
  const resolvedType = type ?? inferTemplateType(roots);
  return {
    version: '0.4',
    title,
    type: resolvedType,
    content,
    page_settings: pageSettingsFor(resolvedType),
  };
}

// Elementor distinguishes Theme-Builder templates (header/footer/popup) from
// ordinary pages. When the whole export is a single navbar/footer frame we
// promote the template to that type so the agent imports it into the right
// slot and Elementor wraps the content in the correct semantic landmark.
function inferTemplateType(roots: ExtractedNode[]): ElementorTemplateType {
  if (roots.length === 0) return 'page';
  const allHeader = roots.every(
    (r) => r.semanticRole === 'navbar' || r.sectionPurpose === 'header' || r.sectionPurpose === 'navbar',
  );
  if (allHeader) return 'header';
  const allFooter = roots.every((r) => r.semanticRole === 'footer' || r.sectionPurpose === 'footer');
  if (allFooter) return 'footer';
  return 'page';
}

// Empty page_settings must serialise as `[]` (Elementor's own contract).
// Header/footer templates carry the wrapper HTML tag so the imported
// content lands inside a semantic <header>/<footer> landmark.
function pageSettingsFor(type: ElementorTemplateType): ElementorSettings {
  if (type === 'header') return { content_wrapper_html_tag: 'header' };
  if (type === 'footer') return { content_wrapper_html_tag: 'footer' };
  return [];
}

function mapNode(
  node: ExtractedNode,
  tokens: DesignTokens,
  lookup: TokenLookup,
  top: boolean,
  parentLayoutMode: ExtractedNode['layout']['mode'] | undefined,
): ElementorElement | null {
  if (!node.visible) return null;

  // Widget-intent dispatch runs *before* the legacy role switch. The
  // extractor (and any user tag) already decided a node is a counter / icon
  // list / accordion / tabs / form — collapsing those to a generic
  // heading/container throws that intent away and is a major fidelity loss.
  // We only intercept intents we can emit as a *populated* Elementor widget
  // (empty special widgets render blank, which is worse than the fallback);
  // everything else falls through to the structural mapping below.
  const special = mapWidgetIntent(node, tokens, lookup);
  if (special) {
    if (parentLayoutMode === 'NONE' && !top) applyAbsolutePosition(special, node);
    stampFigmaMetadata(special, node);
    return special;
  }

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
  // The node wanted a widget we don't build (carousel, nav-menu, price-table,
  // …) and fell through to this container/heading. Flag the unmet intent so
  // the agent can construct the real widget instead of shipping the fallback.
  const unbuiltIntent = node.widgetHint ?? node.preferredWidget;
  // The navbar wrapper (logo + menu + CTA) is not itself the menu; only the
  // inner menu container carries the nav-menu intent.
  const wrapperNotMenu = unbuiltIntent === 'nav-menu' && node.semanticRole === 'navbar' &&
    node.children.some((c) => (c.widgetHint ?? c.preferredWidget) === 'nav-menu');
  if (unbuiltIntent && UNBUILT_WIDGET_INTENTS.has(unbuiltIntent) && el.widgetType !== unbuiltIntent && !wrapperNotMenu) {
    s._unbuilt_widget_intent = unbuiltIntent;
    // Elementor's Nav Menu widget needs a WordPress menu, which JSON can't
    // create. Hand over the items so the importer can build the menu and
    // swap in the widget instead of re-reading the text nodes.
    if (unbuiltIntent === 'nav-menu') {
      const items = navItems(node);
      if (items.length > 0) s._figma_nav_items = items;
    }
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
  stampRawEvidence(s, node);
  // The full structural fingerprint is recursive (a parent embeds every
  // descendant's sig), which makes it kilobyte-class on deep trees and
  // useless to repeat on every container. Pre-grouped data lives in
  // aiLayout.componentTemplates; per-node routing only needs the group id.
  if (node.instanceGroup) s._figma_instance_group = node.instanceGroup;
}

// Raw Figma evidence that Elementor controls cannot express but a
// downstream importer / visual QA pass still needs: mask intent, render
// bounds, transforms, full IMAGE paint info, component identity and variable
// bindings. Everything is underscore-prefixed so Elementor ignores it.
function stampRawEvidence(s: Record<string, unknown>, node: ExtractedNode): void {
  if (node.isMask) {
    s._figma_is_mask = true;
    if (node.maskType) s._figma_mask_type = node.maskType;
  }
  if (node.clipsContent) s._figma_clips_content = true;
  if (node.effectiveVisible === false) s._figma_effective_visible = false;
  if (node.extendsBeyondBounds && node.renderBounds) s._figma_render_bounds = node.renderBounds;
  if (node.rotation) s._figma_rotation = node.rotation;
  if (node.relativeTransform && node.rotation) s._figma_relative_transform = node.relativeTransform;
  if (node.blendMode) s._figma_blend_mode = node.blendMode;

  const imageFills = node.fills.filter((f) => f.type === 'IMAGE');
  if (imageFills.length > 0) {
    s._figma_image_fills = imageFills.map((f) => {
      if (f.type !== 'IMAGE') return f;
      const out: Record<string, unknown> = {
        fillIndex: f.fillIndex,
        assetId: f.assetId,
        file: assetFilename(f.assetId, 'png'),
        imageHash: f.imageHash,
        scaleMode: f.scaleMode,
        opacity: f.opacity,
      };
      if (f.imageTransform) out.imageTransform = f.imageTransform;
      if (f.scalingFactor !== undefined) out.scalingFactor = f.scalingFactor;
      if (f.rotation) out.rotation = f.rotation;
      if (f.filters) out.filters = f.filters;
      if (f.blendMode) out.blendMode = f.blendMode;
      return out;
    });
    const ref = assetInfo.referenceFiles?.get(node.id);
    if (ref) s._figma_rendered_reference = `assets/images/${ref}`;
  }

  if (node.component) {
    const c = node.component;
    s._figma_component = {
      mainComponentId: c.mainComponentId,
      mainComponentName: c.mainComponentName,
      componentSetId: c.componentSetId,
      componentSetName: c.componentSetName,
      variantProperties: c.variantProperties,
      componentProperties: c.componentProperties,
      componentPropertyReferences: c.componentPropertyReferences,
    };
  }
  if (node.variables) {
    if (node.variables.boundVariables) s._figma_bound_variables = node.variables.boundVariables;
    if (node.variables.explicitVariableModes) s._figma_explicit_variable_modes = node.variables.explicitVariableModes;
    if (node.variables.resolvedVariableModes) s._figma_resolved_variable_modes = node.variables.resolvedVariableModes;
  }
}

// Menu entries in document order: one per top-level text label, with the
// hyperlink (if the text carries one) and a dropdown marker.
function navItems(node: ExtractedNode): { label: string; url?: string; hasDropdown?: boolean }[] {
  const out: { label: string; url?: string; hasDropdown?: boolean }[] = [];
  for (const t of collectTextNodes(node)) {
    const raw = t.text!.characters.trim().replace(/\s+/g, ' ');
    if (!raw) continue;
    const hasDropdown = /[▾▼⌄˅]\s*$/.test(raw);
    const label = raw.replace(/\s*[▾▼⌄˅]\s*$/, '');
    const link = (t.text!.runs ?? []).find((r) => r.link?.type === 'URL')?.link ??
      (t.text!.hyperlink?.type === 'URL' ? t.text!.hyperlink : undefined);
    const item: { label: string; url?: string; hasDropdown?: boolean } = { label };
    if (link) item.url = link.value;
    if (hasDropdown) item.hasDropdown = true;
    out.push(item);
  }
  return out;
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
  // work) but the parent now flows them via flex. When the extractor did
  // NOT infer a layout, we make one last mapper-side attempt to read a
  // non-overlapping vertical/horizontal stack from child geometry before
  // giving up and absolutely-positioning the children — absolute layout is
  // fragile in Elementor and rarely survives a responsive resize.
  const inferred = node.inferredLayout ?? (node.layout.mode === 'NONE' ? inferStackFromChildren(node) : undefined);
  const usingInferred = node.layout.mode === 'NONE' && !!inferred;
  const effectiveLayout = usingInferred ? (inferred as NonNullable<typeof node.inferredLayout>) : node.layout;
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
    border_color: stroke ? elementorColor(withAlpha(stroke.color, stroke.opacity)) : undefined,
  };
  if (bgImage) Object.assign(settings, backgroundImageLayout(imageFillScaleMode(node.fills)));
  if (gradient) Object.assign(settings, gradient);
  if (bgImage) Object.assign(settings, imageLayerSettings(node.fills));
  // Background-blur cannot be expressed via Elementor controls. Stamp the
  // effect on settings so the agent can wire a custom-CSS rule with
  // backdrop-filter at publish time.
  const backdropBlur = backdropFilterValue(node.effects);
  if (backdropBlur) settings._figma_backdrop_filter = backdropBlur;
  const bgToken = lookupColorToken(lookup, bgColor);
  if (bgToken) attachToken(settings, 'background_color', bgToken);

  if (top) {
    // Top-level container: the outer wrapper stretches full-bleed (so a
    // section background spans the viewport) while the *content* is boxed to
    // the Figma frame width, reproducing the width the designer actually
    // drew. This mirrors Elementor's own hero pattern (full section, boxed
    // content) and is far higher-fidelity than forcing everything full-width,
    // which stretched copy edge-to-edge on import. min_height is only emitted
    // when a background image needs the section to actually be that tall —
    // otherwise the section grows to fit its children.
    settings.content_width = 'boxed';
    settings.boxed_width = sizePx(node.width);
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
    if (heuristicResponsive && collapsesOnMobile(node, layoutMode)) {
      settings.flex_direction_mobile = 'column';
      for (const child of children) {
        if (child.elType === 'container' && (child.settings as Record<string, unknown>).width) {
          (child.settings as Record<string, unknown>).width_mobile = { unit: '%', size: 100, sizes: [] };
        }
      }
    }
  } else {
    // No auto layout — children will be absolutely positioned.
    // Container itself holds explicit width/height; no flex props.
  }

  applyContainerResponsive(settings, node);
  if (heuristicResponsive && !node.responsive && isFlex) inferPaddingResponsive(settings, effectiveLayout.padding);

  return {
    id: nextId(),
    elType: 'container',
    isInner: !top,
    settings: clean(settings),
    elements: children,
  };
}

// --- Responsive settings --------------------------------------------------

const BREAKPOINTS = ['tablet', 'mobile'] as const;

// Heuristic fallback used only when no explicit mobile frame exists: a wide
// multi-column row of real blocks stacks on mobile. Rows of small things
// (icon + label, button groups, nav bars, form inputs) stay horizontal.
function collapsesOnMobile(node: ExtractedNode, layoutMode: string): boolean {
  if (layoutMode !== 'HORIZONTAL' || !node.breakpoints?.mobileCollapse) return false;
  const role = node.semanticRole ?? node.role;
  if (role === 'navbar' || role === 'button' || role === 'menu' || role === 'input' || role === 'form') return false;
  const kids = node.children.filter((c) => c.visible && !c.isDecorative);
  if (kids.length < 2) return false;
  if (node.width < 600) return false;
  return kids.every((c) => c.width >= 100 && c.children.length > 0);
}

function explicitPadding(p: Padding) {
  return {
    unit: 'px',
    top: String(Math.round(p.top)),
    right: String(Math.round(p.right)),
    bottom: String(Math.round(p.bottom)),
    left: String(Math.round(p.left)),
    isLinked: p.top === p.right && p.right === p.bottom && p.bottom === p.left,
  };
}

// Elementor container responsive controls from real Desktop↔Tablet↔Mobile
// Figma frame differences (never from guesses).
function applyContainerResponsive(settings: Record<string, unknown>, node: ExtractedNode): void {
  for (const bp of BREAKPOINTS) {
    const d = node.responsive?.[bp];
    if (!d) continue;
    const sfx = `_${bp}`;
    if (d.layoutMode) settings[`flex_direction${sfx}`] = d.layoutMode === 'HORIZONTAL' ? 'row' : 'column';
    if (d.itemSpacing !== undefined) settings[`flex_gap${sfx}`] = sizePx(d.itemSpacing);
    if (d.padding) settings[`padding${sfx}`] = explicitPadding(d.padding);
    if (d.primaryAlign) settings[`flex_justify_content${sfx}`] = alignToFlex(d.primaryAlign);
    if (d.counterAlign) settings[`flex_align_items${sfx}`] = alignToFlex(d.counterAlign);
    if (d.wrap !== undefined) settings[`flex_wrap${sfx}`] = d.wrap ? 'wrap' : 'nowrap';
    if (d.width !== undefined) {
      settings[`width${sfx}`] = d.width === 'FILL' ? { unit: '%', size: 100, sizes: [] } : sizePx(d.width);
    }
  }
}

// Last-resort scaling when the design has NO tablet/mobile frames: display
// headings and generous section padding are far too big on phones. Scales
// are the common web convention (tablet ≈ 80%, mobile ≈ 60% for headings;
// tablet 60% / mobile 30% for padding ≥ 48px). Marked so a reviewer knows
// these are inferred, not drawn.
function inferHeadingResponsive(settings: Record<string, unknown>, t: TextStyle): void {
  const size = t.fontSize ?? 0;
  if (size < 36) return;
  const tablet = Math.round(size * 0.8);
  const mobile = Math.max(24, Math.round(size * 0.6));
  settings.typography_font_size_tablet = sizePx(tablet);
  settings.typography_font_size_mobile = sizePx(mobile);
  if (t.lineHeight && t.lineHeight !== 'AUTO' && t.lineHeight.unit === 'PIXELS') {
    const ratio = t.lineHeight.value / size;
    settings.typography_line_height_tablet = { unit: 'px', size: Math.round(tablet * ratio), sizes: [] };
    settings.typography_line_height_mobile = { unit: 'px', size: Math.round(mobile * ratio), sizes: [] };
  }
  settings._figma_responsive_inferred = true;
}

function inferPaddingResponsive(settings: Record<string, unknown>, p: Padding | undefined): void {
  if (!p || Math.max(p.top, p.right, p.bottom, p.left) < 48) return;
  const scale = (k: number): Padding => ({
    top: Math.round(p.top * k), right: Math.round(p.right * k),
    bottom: Math.round(p.bottom * k), left: Math.round(p.left * k),
  });
  settings.padding_tablet = explicitPadding(scale(0.6));
  settings.padding_mobile = explicitPadding(scale(0.3));
  settings._figma_responsive_inferred = true;
}

// Typography + alignment overrides for heading / text-editor widgets.
function applyTextResponsive(settings: Record<string, unknown>, node: ExtractedNode): void {
  for (const bp of BREAKPOINTS) {
    const d = node.responsive?.[bp];
    if (!d) continue;
    const sfx = `_${bp}`;
    if (d.fontSize !== undefined) settings[`typography_font_size${sfx}`] = sizePx(d.fontSize);
    if (d.lineHeight !== undefined && d.lineHeight !== 'AUTO') {
      settings[`typography_line_height${sfx}`] = d.lineHeight.unit === 'PERCENT'
        ? { unit: 'em', size: d.lineHeight.value / 100, sizes: [] }
        : { unit: 'px', size: Math.round(d.lineHeight.value), sizes: [] };
    }
    if (d.letterSpacing !== undefined) {
      settings[`typography_letter_spacing${sfx}`] = { unit: 'px', size: round1(d.letterSpacing.value), sizes: [] };
    }
    if (d.align) settings[`align${sfx}`] = alignToText(d.align);
  }
}

// Last-resort layout inference the mapper runs when the extractor left a
// non-auto-layout frame without an inferredLayout. If the visible children
// don't overlap along the vertical axis we treat them as a top-to-bottom
// stack (the overwhelmingly common web-section case); if they don't overlap
// horizontally we treat them as a row. Anything genuinely overlapping stays
// NONE and keeps the absolute-position fallback. Returns undefined for <2
// children — a single child never needs a flow.
function inferStackFromChildren(node: ExtractedNode): ExtractedNode['inferredLayout'] | undefined {
  const kids = node.children.filter((c) => c.visible !== false);
  if (kids.length < 2) return undefined;
  const sortedY = kids.slice().sort((a, b) => a.y - b.y);
  let vGap = 0;
  let vOverlap = false;
  for (let i = 1; i < sortedY.length; i += 1) {
    const prev = sortedY[i - 1];
    const cur = sortedY[i];
    const gap = cur.y - (prev.y + prev.height);
    if (gap < -2) { vOverlap = true; break; }
    vGap += Math.max(0, gap);
  }
  if (!vOverlap) {
    return {
      mode: 'VERTICAL',
      itemSpacing: Math.round(vGap / (sortedY.length - 1)),
      primaryAlign: 'MIN',
      counterAlign: 'MIN',
    };
  }
  const sortedX = kids.slice().sort((a, b) => a.x - b.x);
  let hGap = 0;
  let hOverlap = false;
  for (let i = 1; i < sortedX.length; i += 1) {
    const prev = sortedX[i - 1];
    const cur = sortedX[i];
    const gap = cur.x - (prev.x + prev.width);
    if (gap < -2) { hOverlap = true; break; }
    hGap += Math.max(0, gap);
  }
  if (!hOverlap) {
    return {
      mode: 'HORIZONTAL',
      itemSpacing: Math.round(hGap / (sortedX.length - 1)),
      primaryAlign: 'MIN',
      counterAlign: 'MIN',
    };
  }
  return undefined;
}

// --- Text widget ---------------------------------------------------------

function mapText(node: ExtractedNode, lookup: TokenLookup): ElementorElement {
  const t = node.text!;
  // Large text is a heading UNLESS it reads as prose — multi-line, long, or
  // carrying an inline link the heading widget's plain-title field can't hold.
  // Those stay a text-editor so the rich-run HTML (bold / links / lists) and
  // the paragraph flow survive instead of collapsing to a flat <h?>.
  const heading = isHeading(t) && !isLongProse(t);
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

  applyTextResponsive(settings, node);
  if (heading && heuristicResponsive && !node.responsive) inferHeadingResponsive(settings, t);

  const el: ElementorElement = {
    id: nextId(),
    elType: 'widget',
    widgetType: heading ? 'heading' : 'text-editor',
    settings: clean(settings),
    elements: [],
  };
  if (heading) headingRegistry.push({ el, size: t.fontSize ?? 0 });
  return el;
}

// --- Image widget --------------------------------------------------------

function mapImage(node: ExtractedNode): ElementorElement {
  const ext = node.suggestedExportFormat ?? 'png';
  const filename = node.assetId ? assetFilename(node.assetId, ext) : `${node.id}.png`;
  // Only pin object-fit when the node carries a real image fill whose Figma
  // scaleMode tells us how it should crop/contain. Rasterised vectors (no
  // fill) keep Elementor's default so we don't distort a logo.
  const scaleMode = imageFillScaleMode(node.fills);
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
      'object-fit': scaleMode ? objectFitFromScaleMode(scaleMode) : undefined,
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
    border_color: stroke ? elementorColor(withAlpha(stroke.color, stroke.opacity)) : undefined,
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
      border_color: hasStroke ? elementorColor(withAlpha(node.strokes[0].color, node.strokes[0].opacity)) : undefined,
    };
    if (bgImage) Object.assign(settings, backgroundImageLayout(imageFillScaleMode(node.fills)));
    if (gradient) Object.assign(settings, gradient);
    if (bgImage) Object.assign(settings, imageLayerSettings(node.fills));
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

// --- Widget-intent builders ----------------------------------------------
//
// When a node carries an authoritative widget hint (user tag) or a strong
// heuristic preferred-widget, we build the matching Elementor widget with a
// *populated* settings block instead of collapsing it to a plain container.
// Only intents we can populate reliably are handled here — a blank special
// widget renders as nothing, which is worse than the structural fallback, so
// unbuildable intents (carousels, price-table, posts, social-icons, video,
// nav-menu) return null and fall through to mapContainer/mapText.

// Elementor repeater rows need a short unique `_id` (7-char base36 here).
let repeaterIdCounter = 0;
function repeaterId(): string {
  repeaterIdCounter += 1;
  return repeaterIdCounter.toString(36).padStart(7, '0').slice(-7);
}

function widgetIntentOf(node: ExtractedNode): string | undefined {
  return node.widgetHint ?? node.preferredWidget;
}

function mapWidgetIntent(
  node: ExtractedNode,
  _tokens: DesignTokens,
  lookup: TokenLookup,
): ElementorElement | null {
  const intent = widgetIntentOf(node);
  if (!intent) return null;
  switch (intent) {
    case 'counter':
      return mapCounter(node, lookup);
    case 'icon-list':
      return mapIconList(node);
    case 'accordion':
    case 'toggle':
      return mapAccordionOrTabs(node, 'accordion');
    case 'tabs':
      return mapAccordionOrTabs(node, 'tabs');
    case 'form':
      return mapForm(node);
    case 'image-carousel':
      return mapImageCarousel(node);
    default:
      return null;
  }
}

// image-carousel — only when every slide is a single image with an exported
// asset (a carousel whose slides carry text/buttons needs `slides`, which we
// don't build, so it keeps the structured-container fallback and its
// `_unbuilt_widget_intent` flag). Slides-per-view is read off the Figma
// geometry: how many slides fit across the carousel frame.
function mapImageCarousel(node: ExtractedNode): ElementorElement | null {
  const slides = node.children.filter((c) => c.visible);
  if (slides.length < 2) return null;
  const imageOf = (n: ExtractedNode): ExtractedNode | null => {
    if (n.assetId && (n.role === 'image' || n.semanticRole === 'image')) return n;
    if (n.children.length === 1) return imageOf(n.children[0]);
    return null;
  };
  const images = slides.map(imageOf);
  if (images.some((i) => !i)) return null;
  const items = (images as ExtractedNode[]).map((img) => ({
    id: '',
    url: `assets/images/${assetFilename(img.assetId!, img.suggestedExportFormat ?? 'png')}`,
    alt: imageAlt(img),
    _placeholder: true,
    _figma_asset_id: img.assetId,
  }));
  const avg = slides.reduce((a, c) => a + c.width, 0) / slides.length;
  const perView = avg > 0 ? Math.max(1, Math.min(8, Math.round(node.width / avg))) : 1;
  return {
    id: nextId(),
    elType: 'widget',
    widgetType: 'image-carousel',
    settings: {
      carousel: items,
      slides_to_show: String(Math.min(perView, items.length)),
      image_size: 'full',
    },
    elements: [],
  };
}

// counter — driven by the parsed counterHint (value/prefix/suffix/label) so
// the agent gets a real animated counter instead of a static heading.
function mapCounter(node: ExtractedNode, lookup: TokenLookup): ElementorElement | null {
  const c = node.counterHint;
  if (!c) return null;
  const color = node.text?.color ?? findFirstTextNode(node)?.text?.color ?? undefined;
  const settings: Record<string, unknown> = clean({
    starting_number: 0,
    ending_number: Math.round(c.value),
    prefix: c.prefix ?? '',
    suffix: c.suffix ?? '',
    title: c.label ?? '',
    duration: 2000,
    thousand_separator: 'yes',
    number_color: elementorColor(color),
  });
  const colorToken = lookupColorToken(lookup, color);
  if (colorToken) attachToken(settings, 'number_color', colorToken);
  return { id: nextId(), elType: 'widget', widgetType: 'counter', settings, elements: [] };
}

// icon-list — one row per child (or per text descendant when the list is
// flat). We can't reliably map each Figma glyph to a Font Awesome class, so
// every row gets a neutral check icon the agent can re-point; the *text* is
// the high-value part and is always preserved.
function mapIconList(node: ExtractedNode): ElementorElement | null {
  const labels = listItemLabels(node);
  if (labels.length === 0) return null;
  const icon_list = labels.map((text) => ({
    text,
    selected_icon: { value: 'fas fa-check', library: 'fa-solid' },
    _id: repeaterId(),
  }));
  return {
    id: nextId(),
    elType: 'widget',
    widgetType: 'icon-list',
    settings: { view: 'traditional', icon_list },
    elements: [],
  };
}

// accordion / tabs — one panel per child item: the child's first text is the
// panel title, everything after it becomes the panel HTML content. Both
// Elementor widgets share the `tabs` repeater shape (tab_title/tab_content).
function mapAccordionOrTabs(node: ExtractedNode, kind: 'accordion' | 'tabs'): ElementorElement | null {
  const items = node.children.filter((c) => c.visible !== false);
  const tabs: Array<Record<string, unknown>> = [];
  for (const item of items) {
    const texts = collectTextNodes(item);
    if (texts.length === 0) continue;
    const title = texts[0].text!.characters.trim();
    const bodyParts = texts.slice(1).map((t) => escapeHtml(t.text!.characters.trim())).filter(Boolean);
    tabs.push({
      tab_title: title,
      tab_content: bodyParts.length ? `<p>${bodyParts.join('</p><p>')}</p>` : '',
      _id: repeaterId(),
    });
  }
  if (tabs.length === 0) return null;
  const settings: Record<string, unknown> =
    kind === 'tabs' ? { type: 'horizontal', tabs } : { tabs };
  return { id: nextId(), elType: 'widget', widgetType: kind, settings, elements: [] };
}

// form — build form_fields from the detected input descendants + their
// inputMetadata, and pull the submit label off any button inside the form.
function mapForm(node: ExtractedNode): ElementorElement | null {
  const inputs: ExtractedNode[] = [];
  let submitLabel: string | undefined;
  function walk(n: ExtractedNode) {
    if (n.semanticRole === 'input') { inputs.push(n); return; }
    if (n.semanticRole === 'button' && !submitLabel) {
      submitLabel = findButtonLabelText(n) ?? undefined;
    }
    for (const c of n.children) walk(c);
  }
  for (const c of node.children) walk(c);
  if (inputs.length === 0) return null;

  const form_fields = inputs.map((inp) => {
    const m = inp.inputMetadata ?? {};
    // Elementor's Form widget only accepts a fixed set of field types — any
    // other value (e.g. 'password', 'search') imports as a broken field. We
    // clamp to a supported type and carry the human label as the field name,
    // which is the part the designer actually authored.
    const label = m.label ?? m.placeholder ?? findFirstTextNode(inp)?.text?.characters ?? '';
    return {
      custom_id: `field_${repeaterId()}`,
      field_type: toElementorFieldType(m.inputType),
      field_label: label,
      placeholder: m.placeholder ?? findFirstTextNode(inp)?.text?.characters ?? '',
      required: m.required ? 'true' : '',
      width: '100',
      _id: repeaterId(),
    };
  });

  return {
    id: nextId(),
    elType: 'widget',
    widgetType: 'form',
    settings: {
      form_name: node.name || 'Form',
      form_fields,
      button_text: submitLabel ?? 'Submit',
      button_size: 'sm',
    },
    elements: [],
  };
}

// Collect list-item labels: prefer one label per structural child row; fall
// back to every text descendant when the list has no row wrappers.
function listItemLabels(node: ExtractedNode): string[] {
  const rows = node.children.filter((c) => c.visible !== false);
  const perRow: string[] = [];
  for (const row of rows) {
    const t = collectTextNodes(row)[0];
    if (t && t.text) {
      const s = t.text.characters.trim();
      if (s) perRow.push(s);
    }
  }
  if (perRow.length >= 2) return perRow;
  // Flat list: every text descendant becomes an item.
  return collectTextNodes(node).map((t) => t.text!.characters.trim()).filter(Boolean);
}

// Text descendants in document order, skipping nodes inside a nested button.
function collectTextNodes(node: ExtractedNode): ExtractedNode[] {
  const out: ExtractedNode[] = [];
  function walk(n: ExtractedNode) {
    if (n.text && n.text.characters && n.text.characters.trim()) out.push(n);
    for (const c of n.children) walk(c);
  }
  for (const c of node.children) walk(c);
  if (node.text && node.text.characters && node.text.characters.trim()) out.unshift(node);
  return out;
}

function findButtonLabelText(node: ExtractedNode): string | null {
  const t = findFirstTextNode(node);
  return t?.text?.characters ?? null;
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
  return f && f.type === 'SOLID' ? withAlpha(f.color, f.opacity) : undefined;
}

// Figma keeps paint opacity separate from the color; fold it into an 8-digit
// hex so a 50% black fill doesn't import as opaque black.
function withAlpha(hex: string, opacity: number | undefined): string {
  if (opacity === undefined || opacity >= 1 || !/^#[0-9a-fA-F]{6}$/.test(hex)) return hex;
  const a = Math.round(Math.max(0, opacity) * 255).toString(16).padStart(2, '0');
  return `${hex}${a}`;
}

function parseHexA(c: string): { rgb: string; a: number } | null {
  const m = /^#([0-9a-fA-F]{6})([0-9a-fA-F]{2})?$/.exec(c);
  if (!m) return null;
  return { rgb: m[1].toUpperCase(), a: m[2] ? parseInt(m[2], 16) / 255 : 1 };
}

function hexA(rgb: string, a: number): string {
  return `#${rgb}${Math.round(Math.min(1, Math.max(0, a)) * 255).toString(16).padStart(2, '0')}`;
}

// Figma stacks paints bottom→top: [base solid, IMAGE (with opacity), gradient].
// Elementor's background has one layer (color OR gradient + image) plus one
// overlay on top. Mapping: base solid → background color; image → background
// image; paints above the image → overlay; image opacity < 1 is reproduced by
// overlaying the base color at (1 - opacity). Without this, a gradient type
// makes Elementor ignore the background image entirely.
function imageLayerSettings(fills: Fill[]): Record<string, unknown> | undefined {
  const idx = fills.findIndex((f) => f.type === 'IMAGE');
  if (idx < 0) return undefined;
  const img = fills[idx];
  if (img.type !== 'IMAGE') return undefined;
  const below = fills.slice(0, idx);
  const above = fills.slice(idx + 1);
  const base = [...below].reverse().find((f) => f.type === 'SOLID');
  const aboveGradient = [...above].reverse().find((f) => f.type.startsWith('GRADIENT'));
  const aboveSolid = [...above].reverse().find((f) => f.type === 'SOLID');
  const baseHex = base && base.type === 'SOLID' ? withAlpha(base.color, base.opacity) : undefined;
  const baseParsed = baseHex ? parseHexA(baseHex) : null;
  const imgDim = img.opacity < 1 && baseParsed ? 1 - img.opacity : 0;

  // Reset the base layer to a plain color + image; clear gradient leftovers.
  const out: Record<string, unknown> = {
    background_background: 'classic',
    background_color: baseHex ? elementorColor(baseHex) : undefined,
    background_color_stop: undefined,
    background_color_b: undefined,
    background_color_b_stop: undefined,
    background_gradient_type: undefined,
    background_gradient_angle: undefined,
    background_gradient_position: undefined,
    _figma_gradient_stops: undefined,
  };
  if (img.opacity < 1) out._figma_image_opacity = Math.round(img.opacity * 100) / 100;

  const one = { unit: 'px', size: 1, sizes: [] };
  if (aboveGradient && 'stops' in aboveGradient && aboveGradient.stops.length > 0) {
    const first = aboveGradient.stops[0];
    const last = aboveGradient.stops[aboveGradient.stops.length - 1];
    const fa = parseHexA(first.color);
    const la = parseHexA(last.color);
    // Fold the dimmed image into the gradient when both share the base hue.
    const fold = (p: { rgb: string; a: number } | null, raw: string) =>
      p && baseParsed && imgDim > 0 && p.rgb === baseParsed.rgb
        ? hexA(p.rgb, 1 - (1 - imgDim) * (1 - p.a))
        : raw;
    const isRadial = aboveGradient.type === 'GRADIENT_RADIAL' || aboveGradient.type === 'GRADIENT_DIAMOND';
    out.background_overlay_background = 'gradient';
    out.background_overlay_color = elementorColor(fold(fa, first.color));
    out.background_overlay_color_stop = { unit: '%', size: Math.round(first.position * 100), sizes: [] };
    out.background_overlay_color_b = elementorColor(fold(la, last.color));
    out.background_overlay_color_b_stop = { unit: '%', size: Math.round(last.position * 100), sizes: [] };
    out.background_overlay_gradient_type = isRadial ? 'radial' : 'linear';
    if (!isRadial && typeof aboveGradient.angle === 'number') {
      out.background_overlay_gradient_angle = { unit: 'deg', size: Math.round(aboveGradient.angle), sizes: [] };
    }
    out.background_overlay_opacity = one;
    if (aboveGradient.stops.length > 2) out._figma_overlay_gradient_stops = aboveGradient.stops;
  } else if (aboveSolid && aboveSolid.type === 'SOLID') {
    out.background_overlay_background = 'classic';
    out.background_overlay_color = elementorColor(withAlpha(aboveSolid.color, aboveSolid.opacity));
    out.background_overlay_opacity = one;
  } else if (imgDim > 0 && baseParsed) {
    out.background_overlay_background = 'classic';
    out.background_overlay_color = elementorColor(hexA(baseParsed.rgb, imgDim));
    out.background_overlay_opacity = one;
  }
  return out;
}

// Elementor's Form widget field types. Anything the extractor inferred that
// isn't in here (password, search, …) clamps to 'text' so the field still
// imports and renders instead of breaking the form.
const ELEMENTOR_FIELD_TYPES: ReadonlySet<string> = new Set([
  'text', 'email', 'textarea', 'tel', 'url', 'number',
  'date', 'time', 'select', 'radio', 'checkbox', 'acceptance',
]);
function toElementorFieldType(inputType: string | undefined): string {
  if (inputType && ELEMENTOR_FIELD_TYPES.has(inputType)) return inputType;
  return 'text';
}

// Figma image-fill scaleMode for the first IMAGE fill on a node, if any.
function imageFillScaleMode(fills: Fill[]): string | undefined {
  const f = fills.find((x) => x.type === 'IMAGE');
  return f && f.type === 'IMAGE' ? f.scaleMode : undefined;
}

// Elementor background_size/position/repeat sibling controls for an image
// fill, derived from the Figma scaleMode. Without these Elementor defaults to
// repeat + top-left, so a FILL hero background tiles instead of covering.
function backgroundImageLayout(scaleMode: string | undefined): Record<string, unknown> {
  switch (scaleMode) {
    case 'FIT':
      return { background_size: 'contain', background_position: 'center center', background_repeat: 'no-repeat' };
    case 'TILE':
      return { background_size: 'auto', background_position: 'top left', background_repeat: 'repeat' };
    case 'FILL':
    case 'CROP':
    default:
      return { background_size: 'cover', background_position: 'center center', background_repeat: 'no-repeat' };
  }
}

// Figma image scaleMode → CSS object-fit for the image widget.
function objectFitFromScaleMode(scaleMode: string | undefined): string {
  switch (scaleMode) {
    case 'FIT': return 'contain';
    case 'TILE': return 'none';
    case 'FILL':
    case 'CROP':
    default: return 'cover';
  }
}

// A large text node still reads as prose (not a heading) when it is
// multi-line, long, or carries an inline hyperlink — cases the heading
// widget's plain-title field would silently flatten.
function isLongProse(t: TextStyle): boolean {
  if (/\r?\n/.test(t.characters)) return true;
  if (t.characters.length > 80) return true;
  if (t.runs && t.runs.some((r) => r.link && r.link.value)) return true;
  return false;
}

// Guarantee the page has exactly one h1. If the size-based headingTag mapping
// produced none (common when the largest heading is < 48px), promote the
// single largest heading to h1 for SEO + accessibility. Ties resolve to the
// first in document order.
function ensureSingleH1(regs: { el: ElementorElement; size: number }[]): void {
  if (regs.length === 0) return;
  const hasH1 = regs.some((r) => (r.el.settings as Record<string, unknown>).header_size === 'h1');
  if (hasH1) return;
  let top = regs[0];
  for (const r of regs) {
    if (r.size > top.size) top = r;
  }
  (top.el.settings as Record<string, unknown>).header_size = 'h1';
}

function imageBackground(fills: Fill[]) {
  const f = fills.find((x) => x.type === 'IMAGE');
  if (!f || f.type !== 'IMAGE') return undefined;
  // The filename comes from the exporter's finalized file map (the real
  // format of the original upload: png/jpg/webp/gif). The wrapper carries _placeholder + _figma_asset_id so downstream agents
  // know the URL must be rewritten to a real WordPress media URL.
  return {
    url: `assets/images/${assetFilename(f.assetId, 'png')}`,
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

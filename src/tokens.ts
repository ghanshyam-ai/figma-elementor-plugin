import type {
  ColorRoleHint,
  ColorUsageContext,
  DesignTokens,
  ExtractedNode,
  Fill,
  FigmaStyleToken,
  FigmaVariableToken,
} from './types';

// Walk an extracted tree and aggregate global design tokens.
// Combines two sources:
//  1. Figma styles + variables (authoritative when present)
//  2. Usage-derived heuristics (fallback for files without styles)

export async function buildTokens(roots: ExtractedNode[]): Promise<DesignTokens> {
  const colorCounts = new Map<string, number>();
  const colorContexts = new Map<string, ColorUsageContext>();
  const typoMap = new Map<string, DesignTokens['typography'][number]>();
  const spacingSet = new Set<number>();
  const radiiSet = new Set<number>();
  const usedFillStyleIds = new Set<string>();
  const usedTextStyleIds = new Set<string>();
  const usedEffectStyleIds = new Set<string>();

  for (const root of roots) {
    collect(
      root, colorCounts, colorContexts, typoMap, spacingSet, radiiSet,
      usedFillStyleIds, usedTextStyleIds, usedEffectStyleIds,
    );
  }

  const colors = rankColors(colorCounts, colorContexts);
  // Drop entries with no fontFamily — Figma sometimes reports a mixed-font
  // text node with the family field unset, which downstream consumers can't
  // act on. They live in the raw extraction either way.
  const typography = Array.from(typoMap.values())
    .filter((t) => !!t.fontFamily)
    .sort((a, b) => (b.fontSize ?? 0) - (a.fontSize ?? 0));
  const spacing = bucketSpacing(Array.from(spacingSet));
  const radii = bucketRadii(Array.from(radiiSet));

  // Pull Figma local styles + variables (best-effort — not all APIs exist
  // in every plugin runtime; failures are silent).
  const styles = await readLocalStyles().catch(() => [] as FigmaStyleToken[]);
  const variables = await readLocalVariables().catch(() => [] as FigmaVariableToken[]);
  const effectStyles = styles
    .filter((s) => s.type === 'EFFECT')
    .map((s) => {
      // s.value here is whatever stringifyEffects produced — we cache the
      // structured form alongside on the style.value object when available.
      const structured = effectsToStructured((s as { rawEffects?: unknown }).rawEffects);
      const out: { name: string; value: string; shadow?: ReturnType<typeof effectsToStructured>; styleId?: string } = {
        name: s.name,
        value: String(s.value),
        styleId: s.id,
      };
      if (structured && structured.length) out.shadow = structured;
      return out;
    });

  // Attach styleId to colors when names overlap with Figma paint styles.
  // When a match exists, prefer the designer-authored style name over our
  // role-based slug — Figma styles like "Brand/Primary" carry intent that
  // any heuristic would only approximate.
  //
  // Multiple paint styles can resolve to the same hex (e.g. "Brand/Primary"
  // and "Action/Default" both #635BFF). The first match becomes the
  // canonical name; the remaining styleIds are surfaced on aliasStyleIds
  // so downstream tooling can re-apply the intent the designer authored.
  const paintStyles = styles.filter((s) => s.type === 'PAINT');
  const usedNames = new Set(colors.map((c) => c.name));
  for (const c of colors) {
    const matches = paintStyles.filter((s) => stringifyPaintValue(s.value) === c.value);
    if (matches.length === 0) continue;
    const primary = matches[0];
    c.styleId = primary.id;
    if (matches.length > 1) {
      c.aliasStyleIds = matches.slice(1).map((m) => m.id);
    }
    const styleName = slugifyKey(primary.name);
    if (styleName && !usedNames.has(styleName)) {
      usedNames.delete(c.name);
      usedNames.add(styleName);
      c.name = styleName;
    }
  }
  const textStyles = styles.filter((s) => s.type === 'TEXT');
  for (const t of typography) {
    const match = textStyles.find((s) => sameTextStyle(s.value, t));
    if (match) t.styleId = match.id;
  }

  // Build a flat semantic lookup for the AI consumer.
  const semantic: Record<string, string | number> = {};
  for (const c of colors) semantic[`color.${c.name}`] = c.value;
  for (const t of typography) {
    if (t.fontFamily) semantic[`font.${t.name}.family`] = t.fontFamily;
    if (t.fontSize) semantic[`font.${t.name}.size`] = t.fontSize;
    if (t.fontWeight) semantic[`font.${t.name}.weight`] = t.fontWeight;
  }
  if (radii.length) {
    semantic['radius.sm'] = radii[0];
    if (radii.length >= 2) semantic['radius.md'] = radii[Math.floor(radii.length / 2)];
    semantic['radius.lg'] = radii[radii.length - 1];
  }
  for (const s of styles) {
    if (s.type === 'PAINT' && typeof s.value === 'string') semantic[s.key] = s.value;
  }
  for (const v of variables) {
    const first = v.modes[0];
    if (first && (typeof first.value === 'string' || typeof first.value === 'number')) {
      semantic[v.key] = first.value;
    }
  }

  // mark "unused" warning data — caller (validation) may consult these
  void usedFillStyleIds; void usedTextStyleIds; void usedEffectStyleIds;

  return {
    colors,
    typography,
    spacing,
    radii,
    effects: effectStyles.length ? effectStyles : undefined,
    styles: styles.length ? styles : undefined,
    variables: variables.length ? variables : undefined,
    semantic: Object.keys(semantic).length ? semantic : undefined,
  };
}

function collect(
  node: ExtractedNode,
  colors: Map<string, number>,
  contexts: Map<string, ColorUsageContext>,
  typo: Map<string, DesignTokens['typography'][number]>,
  spacing: Set<number>,
  radii: Set<number>,
  fillStyleIds: Set<string>,
  textStyleIds: Set<string>,
  effectStyleIds: Set<string>,
): void {
  for (const f of node.fills) addFillColor(f, colors);
  for (const s of node.strokes) bump(colors, s.color);

  // Per-role usage context — Claude uses these counts to finalise role.
  classifyFillUsage(node, contexts);
  classifyStrokeUsage(node, contexts);

  if (node.fillStyleId) fillStyleIds.add(node.fillStyleId);
  if (node.textStyleId) textStyleIds.add(node.textStyleId);
  if (node.effectStyleId) effectStyleIds.add(node.effectStyleId);

  if (node.layout.mode !== 'NONE') {
    if (node.layout.itemSpacing && node.layout.itemSpacing > 0) {
      spacing.add(round(node.layout.itemSpacing));
    }
    const p = node.layout.padding;
    if (p) {
      for (const v of [p.top, p.right, p.bottom, p.left]) {
        if (v > 0) spacing.add(round(v));
      }
    }
  }

  if (typeof node.cornerRadius === 'number' && node.cornerRadius > 0) {
    radii.add(round(node.cornerRadius));
  } else if (node.cornerRadius && typeof node.cornerRadius === 'object') {
    for (const v of Object.values(node.cornerRadius)) {
      if (v > 0) radii.add(round(v));
    }
  }

  if (node.text && node.text.fontSize) {
    // Round to an integer pt size for dedup — fractional sizes (15.97px,
    // 16.03px) are layout-rounding artefacts, not distinct design tokens.
    const sizeBucket = Math.round(node.text.fontSize);
    const key = `${node.text.fontFamily ?? 'sans'}|${node.text.fontWeight ?? 400}|${sizeBucket}`;
    if (!typo.has(key)) {
      typo.set(key, {
        name: typoName(sizeBucket, node.text.fontWeight),
        fontFamily: node.text.fontFamily,
        fontWeight: node.text.fontWeight,
        fontSize: sizeBucket,
        lineHeight:
          node.text.lineHeight === 'AUTO' ? 'auto' :
          node.text.lineHeight ? Math.round(node.text.lineHeight.value) : null,
        letterSpacing: node.text.letterSpacing ? round(node.text.letterSpacing.value) : null,
      });
    }
  }

  for (const c of node.children) {
    collect(c, colors, contexts, typo, spacing, radii, fillStyleIds, textStyleIds, effectStyleIds);
  }
}

// --- Usage context tracking ---------------------------------------------

function emptyContext(): ColorUsageContext {
  return {
    buttonBg: 0, buttonText: 0, textBody: 0, textHeading: 0,
    surface: 0, border: 0, iconStroke: 0, total: 0,
  };
}

function getCtx(map: Map<string, ColorUsageContext>, color: string): ColorUsageContext {
  let ctx = map.get(color);
  if (!ctx) {
    ctx = emptyContext();
    map.set(color, ctx);
  }
  return ctx;
}

function classifyFillUsage(node: ExtractedNode, contexts: Map<string, ColorUsageContext>): void {
  const role = node.semanticRole ?? node.role;
  for (const f of node.fills) {
    if (f.type !== 'SOLID') continue;
    const ctx = getCtx(contexts, f.color);
    ctx.total += 1;
    if (role === 'button') ctx.buttonBg += 1;
    else if (role === 'text' && node.text) {
      const fs = node.text.fontSize ?? 0;
      if (fs >= 20) ctx.textHeading += 1;
      else ctx.textBody += 1;
    } else if (role === 'section' || role === 'hero' || role === 'card' ||
               role === 'container' || role === 'navbar' || role === 'footer') {
      ctx.surface += 1;
    }
  }
}

function classifyStrokeUsage(node: ExtractedNode, contexts: Map<string, ColorUsageContext>): void {
  const role = node.semanticRole ?? node.role;
  for (const s of node.strokes) {
    const ctx = getCtx(contexts, s.color);
    ctx.total += 1;
    if (role === 'icon' || role === 'shape') ctx.iconStroke += 1;
    else ctx.border += 1;
  }
}

function addFillColor(f: Fill, colors: Map<string, number>) {
  if (f.type === 'SOLID') {
    bump(colors, f.color);
  } else if (
    f.type === 'GRADIENT_LINEAR' || f.type === 'GRADIENT_RADIAL' ||
    f.type === 'GRADIENT_ANGULAR' || f.type === 'GRADIENT_DIAMOND'
  ) {
    for (const stop of f.stops) bump(colors, stop.color);
  }
}

function bump(map: Map<string, number>, key: string) {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function round(v: number): number {
  return Math.round(v * 10) / 10;
}

// Snap raw spacing values to a canonical 8-pt-ish scale. Figma exports
// often contain dozens of near-duplicate values (5.1, 5.3, 6, 8.2…) that
// collapse to the same intent — sticking to a fixed scale keeps the
// design-tokens artefact small and consistent across pages.
const SPACING_SCALE = [4, 8, 12, 16, 20, 24, 32, 40, 48, 64, 96, 128];

function bucketSpacing(raw: number[]): number[] {
  const out = new Set<number>();
  for (const v of raw) {
    if (v <= 0) continue;
    let best = SPACING_SCALE[0];
    let bestDiff = Math.abs(v - best);
    for (const s of SPACING_SCALE) {
      const d = Math.abs(v - s);
      if (d < bestDiff) { best = s; bestDiff = d; }
    }
    // For values above the scale ceiling, snap to nearest multiple of 16
    // so giant hero paddings (200, 256, 320) still bucket cleanly.
    if (v > SPACING_SCALE[SPACING_SCALE.length - 1]) {
      out.add(Math.round(v / 16) * 16);
    } else {
      out.add(best);
    }
  }
  return Array.from(out).sort((a, b) => a - b);
}

// Radii snap to a small set so downstream styling can reason about
// "rounded" intent (`radius.md`) instead of pixel-precise values.
const RADII_SCALE = [4, 8, 12, 16, 24];

function bucketRadii(raw: number[]): number[] {
  const out = new Set<number>();
  for (const v of raw) {
    if (v <= 0) continue;
    // Treat >= 999 (pill/circle) as a single "full" bucket.
    if (v >= 999) { out.add(9999); continue; }
    let best = RADII_SCALE[0];
    let bestDiff = Math.abs(v - best);
    for (const s of RADII_SCALE) {
      const d = Math.abs(v - s);
      if (d < bestDiff) { best = s; bestDiff = d; }
    }
    out.add(best);
  }
  return Array.from(out).sort((a, b) => a - b);
}

// Rank colors by usage and attach a candidate roleHint + usageContext for
// downstream Claude to finalise. We never emit a hard role here — the
// hint represents the strongest signal the plugin can see, but Claude has
// the screenshot and final say on which color is the brand primary.
function rankColors(
  counts: Map<string, number>,
  contexts: Map<string, ColorUsageContext>,
): DesignTokens['colors'] {
  const sorted = Array.from(counts, ([value, usage]) => ({ value, usage }))
    .sort((a, b) => b.usage - a.usage);
  const visible = sorted.filter((c) => !c.value.endsWith('00'));

  // Find the dominant brand color: solid most-used as button background,
  // restricted to colors with enough saturation to actually be a brand
  // accent. Without this guard, a page dominated by a grey illustration
  // ends up naming #E5E5E5 as the brand-primary just because it's the
  // most-used color overall.
  const buttonBgRanking = visible
    .map((c) => ({ value: c.value, count: contexts.get(c.value)?.buttonBg ?? 0 }))
    .filter((c) => c.count > 0 && saturation(c.value) > 0.25)
    .sort((a, b) => b.count - a.count);
  const brandPrimary = buttonBgRanking[0]?.value;
  const brandSecondary = buttonBgRanking[1]?.value;

  const named: DesignTokens['colors'] = [];
  const usedNames = new Set<string>();
  visible.forEach((c, i) => {
    const value = c.value.length > 7 ? c.value.slice(0, 7) : c.value;
    const ctx = contexts.get(c.value) ?? emptyContext();
    const roleHint = inferRoleHint(value, ctx, value === brandPrimary, value === brandSecondary);
    const baseName = roleHintToName(roleHint, i);
    let name = baseName;
    let n = 2;
    while (usedNames.has(name)) {
      name = `${baseName}-${n}`;
      n += 1;
    }
    usedNames.add(name);
    named.push({ name, value, usage: c.usage, roleHint, usageContext: ctx });
  });
  return named;
}

// Translate the inferred role hint into a stable, semantic token name.
// We keep the index suffix only as a tie-breaker — the role itself drives
// the primary segment so downstream code can switch on `color.brand-primary`
// instead of `color.primary` which silently changes meaning per export.
function roleHintToName(hint: DesignTokens['colors'][number]['roleHint'], index: number): string {
  switch (hint) {
    case 'brand-primary': return 'brand-primary';
    case 'brand-secondary': return 'brand-secondary';
    case 'accent': return 'accent';
    case 'text-default': return 'text-default';
    case 'text-muted': return 'text-muted';
    case 'text-inverse': return 'text-inverse';
    case 'surface': return 'surface';
    case 'surface-alt': return 'surface-alt';
    case 'border': return 'border';
    case 'overlay': return 'overlay';
    default: return `neutral-${index + 1}`;
  }
}

// HSL saturation (0–1) for a #RRGGBB or #RRGGBBAA color. We discard
// alpha — a fully-transparent saturated color is still a saturated color.
function saturation(hex: string): number {
  const m = hex.replace('#', '').slice(0, 6);
  if (m.length < 6) return 0;
  const r = parseInt(m.slice(0, 2), 16) / 255;
  const g = parseInt(m.slice(2, 4), 16) / 255;
  const b = parseInt(m.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max === min) return 0;
  const l = (max + min) / 2;
  const d = max - min;
  return l > 0.5 ? d / (2 - max - min) : d / (max + min);
}

function inferRoleHint(
  hex: string,
  ctx: ColorUsageContext,
  isBrandPrimary: boolean,
  isBrandSecondary: boolean,
): ColorRoleHint {
  if (isBrandPrimary) return 'brand-primary';
  if (isBrandSecondary) return 'brand-secondary';

  // Pick the dominant usage category.
  const ranked: Array<[keyof ColorUsageContext, number]> = [
    ['buttonBg', ctx.buttonBg],
    ['buttonText', ctx.buttonText],
    ['textHeading', ctx.textHeading],
    ['textBody', ctx.textBody],
    ['surface', ctx.surface],
    ['border', ctx.border],
    ['iconStroke', ctx.iconStroke],
  ];
  ranked.sort((a, b) => b[1] - a[1]);
  const dominant = ranked[0][1] > 0 ? ranked[0][0] : null;
  const lum = luminance(hex);

  switch (dominant) {
    case 'buttonBg':
      // Same saturation guard as rankColors — desaturated buttons are
      // outline/ghost buttons sharing a surface or border color; calling
      // them "brand-primary" mislabels the real accent.
      return saturation(hex) > 0.25 ? 'brand-primary' : 'surface-alt';
    case 'buttonText': return lum > 0.7 ? 'text-inverse' : 'text-default';
    case 'textHeading':
    case 'textBody':
      if (lum > 0.7) return 'text-inverse';
      if (lum > 0.45) return 'text-muted';
      return 'text-default';
    case 'surface':
      return lum > 0.85 ? 'surface' : 'surface-alt';
    case 'border':
      return 'border';
    case 'iconStroke':
      return 'accent';
    default:
      if (lum > 0.85) return 'surface';
      if (lum < 0.2) return 'text-default';
      return 'unknown';
  }
}

function luminance(hex: string): number {
  // Accept #RRGGBB or #RRGGBBAA — alpha is ignored for luminance.
  const m = hex.replace('#', '').slice(0, 6);
  if (m.length < 6) return 0.5;
  const r = parseInt(m.slice(0, 2), 16) / 255;
  const g = parseInt(m.slice(2, 4), 16) / 255;
  const b = parseInt(m.slice(4, 6), 16) / 255;
  // Perceptual approximation (Rec. 709)
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function typoName(size: number, weight: number | null): string {
  if (size >= 48) return 'display';
  if (size >= 32) return 'h1';
  if (size >= 24) return 'h2';
  if (size >= 20) return 'h3';
  if (size >= 18) return 'h4';
  if (size >= 16) return 'body';
  if (size >= 14) return 'small';
  if ((weight ?? 0) >= 600) return 'caption-strong';
  return 'caption';
}

// --- Figma styles / variables -------------------------------------------

async function readLocalStyles(): Promise<FigmaStyleToken[]> {
  const out: FigmaStyleToken[] = [];
  const api = figma as unknown as Record<string, unknown>;

  // Paint styles
  if (typeof api.getLocalPaintStylesAsync === 'function') {
    const styles = await (api.getLocalPaintStylesAsync as () => Promise<readonly PaintStyle[]>)();
    for (const s of styles) {
      out.push({
        id: s.id,
        name: s.name,
        key: 'color.' + slugifyKey(s.name),
        type: 'PAINT',
        value: stringifyPaintValue(s.paints),
      });
    }
  } else if (typeof (api.getLocalPaintStyles as unknown) === 'function') {
    const styles = (api.getLocalPaintStyles as () => readonly PaintStyle[])();
    for (const s of styles) {
      out.push({
        id: s.id,
        name: s.name,
        key: 'color.' + slugifyKey(s.name),
        type: 'PAINT',
        value: stringifyPaintValue(s.paints),
      });
    }
  }

  // Text styles
  if (typeof api.getLocalTextStylesAsync === 'function') {
    const styles = await (api.getLocalTextStylesAsync as () => Promise<readonly TextStyle[]>)();
    for (const s of styles) {
      out.push({
        id: s.id,
        name: s.name,
        key: 'font.' + slugifyKey(s.name),
        type: 'TEXT',
        value: {
          fontFamily: s.fontName?.family ?? null,
          fontStyle: s.fontName?.style ?? null,
          fontSize: s.fontSize,
          letterSpacing: s.letterSpacing,
          lineHeight: s.lineHeight,
        },
      });
    }
  } else if (typeof (api.getLocalTextStyles as unknown) === 'function') {
    const styles = (api.getLocalTextStyles as () => readonly TextStyle[])();
    for (const s of styles) {
      out.push({
        id: s.id,
        name: s.name,
        key: 'font.' + slugifyKey(s.name),
        type: 'TEXT',
        value: {
          fontFamily: s.fontName?.family ?? null,
          fontStyle: s.fontName?.style ?? null,
          fontSize: s.fontSize,
          letterSpacing: s.letterSpacing,
          lineHeight: s.lineHeight,
        },
      });
    }
  }

  // Effect styles
  if (typeof api.getLocalEffectStylesAsync === 'function') {
    const styles = await (api.getLocalEffectStylesAsync as () => Promise<readonly EffectStyle[]>)();
    for (const s of styles) {
      out.push({
        id: s.id,
        name: s.name,
        key: 'effect.' + slugifyKey(s.name),
        type: 'EFFECT',
        value: stringifyEffects(s.effects),
        rawEffects: s.effects,
      } as FigmaStyleToken & { rawEffects: unknown });
    }
  } else if (typeof (api.getLocalEffectStyles as unknown) === 'function') {
    const styles = (api.getLocalEffectStyles as () => readonly EffectStyle[])();
    for (const s of styles) {
      out.push({
        id: s.id,
        name: s.name,
        key: 'effect.' + slugifyKey(s.name),
        type: 'EFFECT',
        value: stringifyEffects(s.effects),
        rawEffects: s.effects,
      } as FigmaStyleToken & { rawEffects: unknown });
    }
  }

  return out;
}

async function readLocalVariables(): Promise<FigmaVariableToken[]> {
  const out: FigmaVariableToken[] = [];
  const api = (figma as unknown as { variables?: Record<string, unknown> }).variables;
  if (!api) return out;

  let collections: { id: string; name: string; modes: { modeId: string; name: string }[] }[] = [];
  if (typeof api.getLocalVariableCollectionsAsync === 'function') {
    collections = await (api.getLocalVariableCollectionsAsync as () => Promise<typeof collections>)();
  } else if (typeof api.getLocalVariableCollections === 'function') {
    collections = (api.getLocalVariableCollections as () => typeof collections)();
  }

  let variables: {
    id: string;
    name: string;
    resolvedType: string;
    variableCollectionId: string;
    valuesByMode: Record<string, unknown>;
  }[] = [];
  if (typeof api.getLocalVariablesAsync === 'function') {
    variables = await (api.getLocalVariablesAsync as () => Promise<typeof variables>)();
  } else if (typeof api.getLocalVariables === 'function') {
    variables = (api.getLocalVariables as () => typeof variables)();
  }

  for (const v of variables) {
    const collection = collections.find((c) => c.id === v.variableCollectionId);
    const modes = (collection?.modes ?? []).map((m) => {
      const raw = v.valuesByMode[m.modeId];
      return { name: m.name, value: serializeVariableValue(raw) };
    });
    out.push({
      id: v.id,
      name: v.name,
      key: variableKey(v.resolvedType, v.name),
      collection: collection?.name ?? '',
      resolvedType: v.resolvedType,
      modes,
    });
  }
  return out;
}

function variableKey(type: string, name: string): string {
  const slug = slugifyKey(name);
  switch (type) {
    case 'COLOR': return 'color.' + slug;
    case 'FLOAT': return 'size.' + slug;
    case 'STRING': return 'string.' + slug;
    case 'BOOLEAN': return 'flag.' + slug;
    default: return 'var.' + slug;
  }
}

function slugifyKey(name: string): string {
  return name
    .replace(/\//g, '.')
    .replace(/\s+/g, '-')
    .replace(/[^a-zA-Z0-9._-]/g, '')
    .toLowerCase();
}

function serializeVariableValue(value: unknown): unknown {
  if (value && typeof value === 'object' && 'r' in value) {
    const c = value as { r: number; g: number; b: number; a?: number };
    return rgbaToHex(c);
  }
  return value;
}

function rgbaToHex(c: { r: number; g: number; b: number; a?: number }): string {
  const h = (n: number) => Math.round(Math.max(0, Math.min(1, n)) * 255).toString(16).padStart(2, '0');
  const base = `#${h(c.r)}${h(c.g)}${h(c.b)}`.toUpperCase();
  if (c.a === undefined || c.a >= 1) return base;
  return `${base}${h(c.a)}`.toUpperCase();
}

function stringifyPaintValue(paints: unknown): string {
  if (!Array.isArray(paints) || paints.length === 0) return '';
  const p = paints[0] as { type?: string; color?: { r: number; g: number; b: number }; opacity?: number };
  if (p.type === 'SOLID' && p.color) return rgbaToHex({ r: p.color.r, g: p.color.g, b: p.color.b, a: p.opacity ?? 1 });
  return p.type ?? 'unknown';
}

function stringifyEffects(effects: unknown): string {
  if (!Array.isArray(effects) || effects.length === 0) return '';
  return effects.map((e) => {
    const ef = e as { type?: string; radius?: number; offset?: { x: number; y: number } };
    if (ef.type === 'DROP_SHADOW' || ef.type === 'INNER_SHADOW') {
      return `${ef.type} ${ef.offset?.x ?? 0}/${ef.offset?.y ?? 0} blur ${ef.radius ?? 0}`;
    }
    return `${ef.type} ${ef.radius ?? 0}`;
  }).join(', ');
}

// Structured shadow data for downstream consumers (mapper, AI agent) so
// they don't have to re-parse the human-readable `value` string.
function effectsToStructured(effects: unknown): {
  type: 'DROP_SHADOW' | 'INNER_SHADOW' | 'LAYER_BLUR' | 'BACKGROUND_BLUR';
  x?: number;
  y?: number;
  blur: number;
  spread?: number;
  color?: string;
}[] | undefined {
  if (!Array.isArray(effects)) return undefined;
  const out: ReturnType<typeof effectsToStructured> = [] as NonNullable<ReturnType<typeof effectsToStructured>>;
  for (const e of effects) {
    const ef = e as {
      type?: string;
      visible?: boolean;
      radius?: number;
      spread?: number;
      offset?: { x: number; y: number };
      color?: { r: number; g: number; b: number; a?: number };
    };
    if (ef.visible === false) continue;
    if (ef.type === 'DROP_SHADOW' || ef.type === 'INNER_SHADOW') {
      out!.push({
        type: ef.type,
        x: Math.round(ef.offset?.x ?? 0),
        y: Math.round(ef.offset?.y ?? 0),
        blur: Math.round(ef.radius ?? 0),
        spread: Math.round(ef.spread ?? 0),
        color: ef.color ? rgbaToHex({ r: ef.color.r, g: ef.color.g, b: ef.color.b, a: ef.color.a }) : undefined,
      });
    } else if (ef.type === 'LAYER_BLUR' || ef.type === 'BACKGROUND_BLUR') {
      out!.push({ type: ef.type, blur: Math.round(ef.radius ?? 0) });
    }
  }
  return out!.length > 0 ? out : undefined;
}

function sameTextStyle(
  raw: unknown,
  t: DesignTokens['typography'][number],
): boolean {
  if (!raw || typeof raw !== 'object') return false;
  const v = raw as { fontFamily?: string | null; fontSize?: number };
  return v.fontFamily === t.fontFamily && v.fontSize === t.fontSize;
}

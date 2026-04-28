import type { DesignTokens, ExtractedNode, Fill } from './types';

// Walk an extracted tree and aggregate global design tokens.
// Heuristic, not authoritative — Figma's variable system would be better
// when available, but we want this to work on any file.

export function buildTokens(roots: ExtractedNode[]): DesignTokens {
  const colorCounts = new Map<string, number>();
  const typoMap = new Map<string, DesignTokens['typography'][number]>();
  const spacingSet = new Set<number>();
  const radiiSet = new Set<number>();

  for (const root of roots) collect(root, colorCounts, typoMap, spacingSet, radiiSet);

  const colors = rankColors(colorCounts);
  const typography = Array.from(typoMap.values()).sort((a, b) => {
    return (b.fontSize ?? 0) - (a.fontSize ?? 0);
  });
  const spacing = Array.from(spacingSet).sort((a, b) => a - b);
  const radii = Array.from(radiiSet).sort((a, b) => a - b);

  return { colors, typography, spacing, radii };
}

function collect(
  node: ExtractedNode,
  colors: Map<string, number>,
  typo: Map<string, DesignTokens['typography'][number]>,
  spacing: Set<number>,
  radii: Set<number>,
): void {
  for (const f of node.fills) addFillColor(f, colors);
  for (const s of node.strokes) bump(colors, s.color);

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
    const key = `${node.text.fontFamily ?? 'sans'}|${node.text.fontWeight ?? 400}|${node.text.fontSize}`;
    if (!typo.has(key)) {
      typo.set(key, {
        name: typoName(node.text.fontSize, node.text.fontWeight),
        fontFamily: node.text.fontFamily,
        fontWeight: node.text.fontWeight,
        fontSize: node.text.fontSize,
        lineHeight:
          node.text.lineHeight === 'AUTO' ? 'auto' :
          node.text.lineHeight ? node.text.lineHeight.value : null,
        letterSpacing: node.text.letterSpacing ? node.text.letterSpacing.value : null,
      });
    }
  }

  for (const c of node.children) collect(c, colors, typo, spacing, radii);
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

// Rank colors by usage and assign role-style names.
function rankColors(counts: Map<string, number>): DesignTokens['colors'] {
  const sorted = Array.from(counts, ([value, usage]) => ({ value, usage }))
    .sort((a, b) => b.usage - a.usage);

  // Drop pure-transparent entries.
  const visible = sorted.filter((c) => !c.value.endsWith('00'));

  const named: DesignTokens['colors'] = [];
  const roles = ['primary', 'secondary', 'accent', 'neutral-1', 'neutral-2', 'neutral-3'];
  visible.forEach((c, i) => {
    named.push({
      name: roles[i] ?? `color-${i + 1}`,
      value: c.value.length > 7 ? c.value.slice(0, 7) : c.value,
      usage: c.usage,
    });
  });
  return named;
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

import type {
  DesignTokens,
  ElementorGlobalColor,
  ElementorGlobalFont,
  ElementorGlobals,
} from './types';

// Maps Figma-derived design tokens onto Elementor's Kit model:
//   Global Colors      system (primary/secondary/text/accent) + custom
//   Global Fonts       system (primary/secondary/text/accent) + custom
//   Site Settings      body + heading typography/colour in the Kit
//
// Output is data only. Widgets in data.json keep their literal values plus
// `__tokens__` (setting → token path); `references` below tells the
// WordPress-side importer which `globals/...?id=` to turn each token path
// into AFTER it has written the globals to the Kit. Emitting __globals__ for
// the system ids directly from here would be unsafe: if the Kit is not
// updated first, `globals/colors?id=primary` resolves to the site's OLD
// primary colour and silently recolours the page.

function shortHash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i += 1) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(16).padStart(7, '0').slice(0, 7);
}

function titleCase(slug: string): string {
  return slug.replace(/[-_.]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()).trim();
}

const SYSTEM_IDS = ['primary', 'secondary', 'text', 'accent'] as const;
const MAX_CUSTOM_COLORS = 24;

export function buildElementorGlobals(tokens: DesignTokens): ElementorGlobals {
  const references: Record<string, string> = {};
  const notes: string[] = [];

  // ---- Colors ----------------------------------------------------------
  const bySystem: Partial<Record<(typeof SYSTEM_IDS)[number], DesignTokens['colors'][number]>> = {};
  const claim = (id: (typeof SYSTEM_IDS)[number], c: DesignTokens['colors'][number] | undefined) => {
    if (c && !bySystem[id] && !Object.values(bySystem).includes(c)) bySystem[id] = c;
  };
  const byHint = (hint: string) => tokens.colors.find((c) => c.roleHint === hint);
  claim('primary', byHint('brand-primary'));
  claim('secondary', byHint('brand-secondary'));
  claim('text', byHint('text-default'));
  claim('accent', byHint('accent'));
  // Name-based fallback for files that author their own palette names.
  const byName = (rx: RegExp) => tokens.colors.find((c) => rx.test(c.name));
  claim('primary', byName(/primary/i));
  claim('secondary', byName(/secondary/i));
  claim('text', byName(/\b(text|body|ink)\b/i));
  claim('accent', byName(/accent|highlight/i));

  const colorSystem: ElementorGlobalColor[] = [];
  const taken = new Set<string>();
  for (const id of SYSTEM_IDS) {
    const c = bySystem[id];
    if (!c) continue;
    const tokenPath = `color.${c.name}`;
    colorSystem.push({ _id: id, title: titleCase(id), color: c.value, tokenPath });
    references[tokenPath] = `globals/colors?id=${id}`;
    taken.add(c.name);
  }
  const colorCustom: ElementorGlobalColor[] = [];
  for (const c of tokens.colors) {
    if (taken.has(c.name) || colorCustom.length >= MAX_CUSTOM_COLORS) continue;
    const id = `fx${shortHash(`color:${c.name}:${c.value}`)}`;
    const tokenPath = `color.${c.name}`;
    colorCustom.push({ _id: id, title: titleCase(c.name), color: c.value, tokenPath });
    references[tokenPath] = `globals/colors?id=${id}`;
  }

  // ---- Typography ------------------------------------------------------
  const typoByName = new Map(tokens.typography.map((t) => [t.name, t]));
  const pick = (...names: string[]) => names.map((n) => typoByName.get(n)).find(Boolean);
  const slots: Array<[(typeof SYSTEM_IDS)[number], DesignTokens['typography'][number] | undefined]> = [
    ['primary', pick('h1', 'display', 'h2')],
    ['secondary', pick('h2', 'h3', 'h4')],
    ['text', pick('body', 'small')],
    ['accent', pick('caption-strong', 'h4', 'small', 'caption')],
  ];
  const usedTypo = new Set<string>();
  const toFont = (id: string, title: string, t: DesignTokens['typography'][number]): ElementorGlobalFont => {
    const f: ElementorGlobalFont = {
      _id: id, title, tokenPath: `font.${t.name}`, typography_typography: 'custom',
    };
    if (t.fontFamily) f.typography_font_family = t.fontFamily;
    if (t.fontWeight) f.typography_font_weight = t.fontWeight;
    if (t.fontSize) f.typography_font_size = { unit: 'px', size: t.fontSize, sizes: [] };
    if (typeof t.lineHeight === 'number') f.typography_line_height = { unit: 'px', size: Math.round(t.lineHeight), sizes: [] };
    if (typeof t.letterSpacing === 'number' && t.letterSpacing !== 0) {
      f.typography_letter_spacing = { unit: 'px', size: t.letterSpacing, sizes: [] };
    }
    return f;
  };
  const fontSystem: ElementorGlobalFont[] = [];
  for (const [id, t] of slots) {
    if (!t || usedTypo.has(t.name)) continue;
    usedTypo.add(t.name);
    fontSystem.push(toFont(id, titleCase(id), t));
    references[`font.${t.name}.family`] = `globals/typography?id=${id}`;
    references[`font.${t.name}.size`] = `globals/typography?id=${id}`;
  }
  const fontCustom: ElementorGlobalFont[] = [];
  for (const t of tokens.typography) {
    if (usedTypo.has(t.name)) continue;
    const id = `fx${shortHash(`font:${t.name}`)}`;
    fontCustom.push(toFont(id, titleCase(t.name), t));
    references[`font.${t.name}.family`] = `globals/typography?id=${id}`;
    references[`font.${t.name}.size`] = `globals/typography?id=${id}`;
  }

  // ---- Site settings (Kit) ----------------------------------------------
  const siteSettings: Record<string, unknown> = {};
  const bodyFont = fontSystem.find((f) => f._id === 'text');
  if (bodyFont) {
    siteSettings.body_typography_typography = 'custom';
    if (bodyFont.typography_font_family) siteSettings.body_typography_font_family = bodyFont.typography_font_family;
    if (bodyFont.typography_font_size) siteSettings.body_typography_font_size = bodyFont.typography_font_size;
    if (bodyFont.typography_font_weight) siteSettings.body_typography_font_weight = bodyFont.typography_font_weight;
  }
  const textColor = colorSystem.find((c) => c._id === 'text');
  if (textColor) siteSettings.body_color = textColor.color;
  for (const [level, names] of [['h1', ['h1', 'display']], ['h2', ['h2']], ['h3', ['h3']]] as const) {
    const t = names.map((n) => typoByName.get(n)).find(Boolean);
    if (!t) continue;
    siteSettings[`${level}_typography_typography`] = 'custom';
    if (t.fontFamily) siteSettings[`${level}_typography_font_family`] = t.fontFamily;
    if (t.fontSize) siteSettings[`${level}_typography_font_size`] = { unit: 'px', size: t.fontSize, sizes: [] };
    if (t.fontWeight) siteSettings[`${level}_typography_font_weight`] = t.fontWeight;
  }

  if (colorSystem.length < SYSTEM_IDS.length) {
    notes.push('Some Elementor system colors had no confident Figma match; review global.json › elementorGlobals before importing.');
  }
  notes.push('Write colors/typography to the active Kit first, then convert data.json `__tokens__` entries to `__globals__` using `references`.');

  return {
    colors: { system: colorSystem, custom: colorCustom },
    typography: { system: fontSystem, custom: fontCustom },
    siteSettings,
    references,
    notes,
  };
}

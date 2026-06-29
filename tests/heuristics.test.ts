import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  looksLikeLogoStrip,
  parseCounter,
  promoteLeafWidget,
} from '../src/extractor';
import { detectSectionPurpose } from '../src/aiLayout';
import { brandColorHygieneWarnings } from '../src/tokens';
import type {
  DesignTokens,
  ExtractedNode,
  FigmaStyleToken,
  Fill,
} from '../src/types';

// Minimal ExtractedNode factory — only fills the fields the function under
// test actually reads. Anything unset defaults to a safe shape (empty
// children, NONE layout, no fills).
function makeNode(overrides: Partial<ExtractedNode> = {}): ExtractedNode {
  return {
    id: overrides.id ?? 'n_' + Math.random().toString(36).slice(2, 8),
    name: overrides.name ?? 'Node',
    type: overrides.type ?? 'FRAME',
    visible: overrides.visible ?? true,
    role: overrides.role ?? 'container',
    x: overrides.x ?? 0,
    y: overrides.y ?? 0,
    width: overrides.width ?? 100,
    height: overrides.height ?? 100,
    fills: overrides.fills ?? [],
    strokes: overrides.strokes ?? [],
    layout: overrides.layout ?? { mode: 'NONE' },
    children: overrides.children ?? [],
    ...overrides,
  };
}

test('parseCounter accepts the common stats-section shapes', () => {
  const cases: { input: string; value: number; suffix?: string; prefix?: string }[] = [
    { input: '500+', value: 500, suffix: '+' },
    { input: '75.5K+', value: 75.5, suffix: 'K+' },
    { input: '4.8/5', value: 4.8, suffix: '/5' },
    { input: '98%', value: 98, suffix: '%' },
    { input: '$1.2M', value: 1.2, suffix: 'M', prefix: '$' },
    { input: '10,000', value: 10000 },
    { input: '1,234,567', value: 1234567 },
    { input: '0', value: 0 },
  ];
  for (const c of cases) {
    const got = parseCounter(c.input);
    assert.ok(got, `should parse "${c.input}"`);
    assert.equal(got!.value, c.value, `value for "${c.input}"`);
    if (c.suffix !== undefined) assert.equal(got!.suffix, c.suffix);
    if (c.prefix !== undefined) assert.equal(got!.prefix, c.prefix);
  }
});

test('parseCounter rejects sentence-embedded numbers and noise', () => {
  const rejects = [
    '', '   ', 'we have 500 users now', 'Buy 2 get 1 free',
    'This is a very long string that should not parse',
    'plan with 5 features',
  ];
  for (const r of rejects) {
    assert.equal(parseCounter(r), null, `should reject "${r}"`);
  }
});

test('promoteLeafWidget promotes single-image wrappers to image', () => {
  const wrapper = makeNode({
    name: 'image wrapper',
    semanticRole: 'container',
    children: [
      makeNode({
        name: 'photo',
        semanticRole: 'image',
        fills: [{ type: 'IMAGE', assetId: 'img_1', scaleMode: 'FILL', opacity: 1 } as Fill],
      }),
    ],
  });
  const result = promoteLeafWidget(wrapper);
  assert.ok(result, 'should promote');
  assert.equal(result!.widget, 'image');
  assert.ok(result!.confidence >= 0.7, 'confidence ≥ 0.7');
});

test('promoteLeafWidget promotes single-button wrappers to button', () => {
  const wrapper = makeNode({
    semanticRole: 'container',
    children: [
      makeNode({ semanticRole: 'button', name: 'Get Started' }),
    ],
  });
  const result = promoteLeafWidget(wrapper);
  assert.ok(result, 'should promote');
  assert.equal(result!.widget, 'button');
});

test('promoteLeafWidget leaves real container sections alone', () => {
  const section = makeNode({
    semanticRole: 'hero',
    children: [
      makeNode({ semanticRole: 'text' }),
      makeNode({ semanticRole: 'button' }),
      makeNode({ semanticRole: 'image' }),
    ],
  });
  const result = promoteLeafWidget(section);
  assert.equal(result, null, 'hero with mixed leaves should stay a container');
});

test('promoteLeafWidget promotes icon + heading to icon-box', () => {
  const wrapper = makeNode({
    semanticRole: 'container',
    children: [
      makeNode({ semanticRole: 'icon' }),
      makeNode({
        semanticRole: 'text',
        text: {
          characters: 'Fast', fontFamily: null, fontStyle: null, fontWeight: 700,
          fontSize: 18, lineHeight: null, letterSpacing: null,
          align: null, verticalAlign: null, textCase: null, textDecoration: null, color: null,
        },
      }),
    ],
  });
  const result = promoteLeafWidget(wrapper);
  assert.ok(result);
  assert.equal(result!.widget, 'icon-box');
});

test('looksLikeLogoStrip flags a row of similar-height images', () => {
  const strip = makeNode({
    name: 'Trusted by',
    semanticRole: 'container',
    layout: { mode: 'HORIZONTAL' },
    children: [
      makeNode({ semanticRole: 'image', height: 40, width: 100 }),
      makeNode({ semanticRole: 'image', height: 40, width: 110 }),
      makeNode({ semanticRole: 'image', height: 45, width: 90 }),
      makeNode({ semanticRole: 'image', height: 42, width: 95 }),
    ],
  });
  assert.equal(looksLikeLogoStrip(strip), true);
});

test('looksLikeLogoStrip rejects rows that include text labels', () => {
  const featureRow = makeNode({
    name: 'features',
    layout: { mode: 'HORIZONTAL' },
    children: [
      makeNode({ semanticRole: 'image', height: 40 }),
      makeNode({ semanticRole: 'text', height: 24 }),
      makeNode({ semanticRole: 'image', height: 40 }),
    ],
  });
  assert.equal(looksLikeLogoStrip(featureRow), false);
});

test('looksLikeLogoStrip rejects vertical stacks', () => {
  const stack = makeNode({
    layout: { mode: 'VERTICAL' },
    children: [
      makeNode({ semanticRole: 'image', height: 40 }),
      makeNode({ semanticRole: 'image', height: 40 }),
      makeNode({ semanticRole: 'image', height: 40 }),
    ],
  });
  assert.equal(looksLikeLogoStrip(stack), false);
});

test('detectSectionPurpose returns trust-row for ≥3 logos without text', () => {
  const node = makeNode({
    name: 'partners',
    children: [
      makeNode({ semanticRole: 'logo' }),
      makeNode({ semanticRole: 'logo' }),
      makeNode({ semanticRole: 'logo' }),
      makeNode({ semanticRole: 'logo' }),
    ],
  });
  assert.equal(detectSectionPurpose(node), 'trust-row');
});

test('detectSectionPurpose returns stats when descendants carry counter hints', () => {
  const counterText = makeNode({
    semanticRole: 'text',
    widgetHint: 'counter',
    counterHint: { raw: '500+', value: 500, suffix: '+' },
  });
  const stats = makeNode({
    name: 'Card',
    children: [
      makeNode({ children: [counterText] }),
    ],
  });
  assert.equal(detectSectionPurpose(stats), 'stats');
});

test('detectSectionPurpose returns pricing when name hints at it', () => {
  const node = makeNode({ name: 'Pricing plans' });
  assert.equal(detectSectionPurpose(node), 'pricing');
});

test('detectSectionPurpose prefers pricing over stats even with counter-like numbers', () => {
  // A pricing section whose price headings parsed as counters must still be
  // classified as pricing, not stats (fix: pricing check runs before stats).
  const priceCounter = makeNode({
    semanticRole: 'text',
    widgetHint: 'counter',
    counterHint: { raw: '99', value: 99 },
  });
  const node = makeNode({
    name: 'Pricing',
    children: [makeNode({ children: [priceCounter] })],
  });
  assert.equal(detectSectionPurpose(node), 'pricing');
});

test('brandColorHygieneWarnings fires when fewer than 2 brand-named paint styles exist', () => {
  const tokens: DesignTokens = {
    colors: [], typography: [], spacing: [], radii: [],
    styles: [
      { id: '1', name: 'Color 1', key: 'color.color-1', type: 'PAINT', value: '#FF0000' } as FigmaStyleToken,
      { id: '2', name: 'Stroke 4', key: 'color.stroke-4', type: 'PAINT', value: '#00FF00' } as FigmaStyleToken,
      { id: '3', name: 'Background', key: 'color.background', type: 'PAINT', value: '#FFFFFF' } as FigmaStyleToken,
    ],
  };
  const warnings = brandColorHygieneWarnings(tokens);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].code, 'unnamed-brand-colors');
  assert.equal(warnings[0].level, 'warn');
});

test('brandColorHygieneWarnings stays silent when brand-intent names are present', () => {
  const tokens: DesignTokens = {
    colors: [], typography: [], spacing: [], radii: [],
    styles: [
      { id: '1', name: 'Brand/Primary', key: 'color.brand-primary', type: 'PAINT', value: '#635BFF' } as FigmaStyleToken,
      { id: '2', name: 'Brand/Accent', key: 'color.brand-accent', type: 'PAINT', value: '#FF6F61' } as FigmaStyleToken,
      { id: '3', name: 'Background', key: 'color.background', type: 'PAINT', value: '#FFFFFF' } as FigmaStyleToken,
    ],
  };
  const warnings = brandColorHygieneWarnings(tokens);
  assert.equal(warnings.length, 0);
});

test('brandColorHygieneWarnings stays silent when no paint styles exist', () => {
  const tokens: DesignTokens = {
    colors: [], typography: [], spacing: [], radii: [],
  };
  const warnings = brandColorHygieneWarnings(tokens);
  assert.equal(warnings.length, 0);
});

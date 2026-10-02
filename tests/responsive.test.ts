import { test } from 'node:test';
import assert from 'node:assert/strict';

import { classifyFrameName, foldBreakpointFrames } from '../src/responsive';
import { toElementorTemplate } from '../src/mapper';
import { validateElementorTemplate } from '../src/elementorSchema';
import type { DesignTokens, ExtractedNode, TextStyle } from '../src/types';

const TOKENS: DesignTokens = { colors: [], typography: [], spacing: [], radii: [] };

function n(o: Partial<ExtractedNode>): ExtractedNode {
  return {
    id: o.id ?? 'n' + Math.random().toString(36).slice(2, 7), name: o.name ?? 'Node', type: 'FRAME',
    visible: true, role: o.role ?? 'container', x: 0, y: 0, width: o.width ?? 100, height: o.height ?? 100,
    fills: [], strokes: [], layout: o.layout ?? { mode: 'NONE' }, children: o.children ?? [], ...o,
  };
}
function text(chars: string, fontSize: number, extra: Partial<TextStyle> = {}): ExtractedNode {
  return n({
    name: 'Title', role: 'text', semanticRole: 'text', width: 300, height: 40,
    text: {
      characters: chars, fontFamily: 'Inter', fontStyle: null, fontWeight: 700, fontSize,
      lineHeight: { value: fontSize * 1.2, unit: 'PIXELS' }, letterSpacing: null, align: 'LEFT',
      verticalAlign: null, textCase: null, textDecoration: null, color: '#000000', ...extra,
    },
  });
}
function page(name: string, width: number, dir: 'HORIZONTAL' | 'VERTICAL', gap: number, pad: number, fs: number): ExtractedNode {
  const p = { top: pad, right: pad, bottom: pad, left: pad };
  return n({
    name, width, role: 'section', semanticRole: 'section',
    layout: { mode: 'VERTICAL', itemSpacing: 0, padding: p },
    children: [n({
      name: 'Row', width: width - 2 * pad, semanticRole: 'container',
      layout: { mode: dir, itemSpacing: gap, padding: { top: 0, right: 0, bottom: 0, left: 0 }, primaryAlign: 'MIN', counterAlign: 'MIN' },
      children: [text('Hello', fs), text('World', fs)],
    })],
  });
}

test('classifyFrameName finds the breakpoint token and a shared stem', () => {
  assert.deepEqual(classifyFrameName('Homepage Desktop'), { cls: 'desktop', stem: 'homepage' });
  assert.deepEqual(classifyFrameName('Homepage - Mobile (375px)'), { cls: 'mobile', stem: 'homepage' });
  assert.deepEqual(classifyFrameName('homepage/tablet'), { cls: 'tablet', stem: 'homepage' });
  assert.equal(classifyFrameName('Hero'), null);
});

test('desktop + tablet + mobile frames fold into one page with _tablet/_mobile keys', () => {
  const desktop = page('Homepage Desktop', 1440, 'HORIZONTAL', 32, 80, 48);
  const tablet = page('Homepage Tablet', 768, 'HORIZONTAL', 24, 40, 36);
  const mobile = page('Homepage Mobile', 375, 'VERTICAL', 16, 20, 28);
  const other = n({ name: 'Standalone', width: 1440 });
  const { trees, pairs } = foldBreakpointFrames([desktop, tablet, mobile, other]);
  assert.equal(trees.length, 2, 'tablet + mobile are folded away');
  assert.equal(pairs.length, 1);

  const tpl = toElementorTemplate(trees, TOKENS, 'Homepage');
  const root = tpl.content[0].settings as Record<string, any>;
  // padding differs per breakpoint
  assert.equal(root.padding_tablet.top, '40');
  assert.equal(root.padding_mobile.top, '20');
  const row = tpl.content[0].elements[0].settings as Record<string, any>;
  assert.equal(row.flex_direction, 'row');
  assert.equal(row.flex_direction_mobile, 'column');
  assert.equal(row.flex_direction_tablet, undefined, 'tablet kept the row layout');
  assert.equal(row.flex_gap_tablet.size, 24);
  assert.equal(row.flex_gap_mobile.size, 16);
  const h = tpl.content[0].elements[0].elements[0].settings as Record<string, any>;
  assert.equal(h.typography_font_size.size, 48);
  assert.equal(h.typography_font_size_tablet.size, 36);
  assert.equal(h.typography_font_size_mobile.size, 28);
  assert.ok(h.typography_line_height_mobile, 'line height follows mobile frame');

  const errors = validateElementorTemplate(tpl).issues.filter((i) => i.level === 'error');
  assert.deepEqual(errors, []);
});

test('a "mobile" frame wider than its desktop is not paired', () => {
  const { trees, pairs } = foldBreakpointFrames([
    page('Home Desktop', 800, 'HORIZONTAL', 8, 8, 16),
    page('Home Mobile', 1200, 'VERTICAL', 8, 8, 16),
  ]);
  assert.equal(pairs.length, 0);
  assert.equal(trees.length, 2);
});

function wideRow(): ExtractedNode {
  const card = (i: number) => n({
    id: 'card' + i, name: 'Card', width: 300, semanticRole: 'card', layout: { mode: 'VERTICAL', itemSpacing: 8 },
    children: [text('t' + i, 20)],
  });
  return n({
    name: 'Features', width: 1000, semanticRole: 'container',
    layout: { mode: 'HORIZONTAL', itemSpacing: 24, primaryAlign: 'MIN', counterAlign: 'MIN' },
    breakpoints: { mobileCollapse: true },
    children: [card(1), card(2), card(3)],
  });
}

test('heuristic fallback: wide multi-card row stacks on mobile when no mobile frame exists', () => {
  const tpl = toElementorTemplate([wideRow()], TOKENS, 't');
  const s = tpl.content[0].settings as Record<string, any>;
  assert.equal(s.flex_direction_mobile, 'column');
  const card = tpl.content[0].elements[0].settings as Record<string, any>;
  assert.deepEqual(card.width_mobile, { unit: '%', size: 100, sizes: [] });
});

test('heuristic fallback never fires for small rows (icon + label) or navbars', () => {
  const small = n({
    name: 'Chip', width: 200, layout: { mode: 'HORIZONTAL', itemSpacing: 8 },
    breakpoints: { mobileCollapse: true }, children: [text('a', 14), text('b', 14)],
  });
  const nav = wideRow();
  nav.semanticRole = 'navbar';
  const tpl = toElementorTemplate([small, nav], TOKENS, 't');
  assert.equal((tpl.content[0].settings as any).flex_direction_mobile, undefined);
  assert.equal((tpl.content[1].settings as any).flex_direction_mobile, undefined);
});

test('explicit Figma breakpoint frames suppress the heuristic', () => {
  const desktop = wideRow();
  desktop.name = 'Features Desktop';
  const mobile = wideRow();
  mobile.name = 'Features Mobile';
  mobile.width = 375;
  // The designer kept it a row on mobile — the heuristic must not override.
  const { trees } = foldBreakpointFrames([desktop, mobile]);
  const tpl = toElementorTemplate(trees, TOKENS, 't');
  assert.equal((tpl.content[0].settings as any).flex_direction_mobile, undefined);
});

test('no mobile frame: display headings and big section padding get inferred scaling, marked as inferred', () => {
  const sec = n({
    name: 'Hero', width: 1440, semanticRole: 'section',
    layout: { mode: 'VERTICAL', itemSpacing: 16, padding: { top: 96, right: 80, bottom: 96, left: 80 } },
    children: [text('Big title', 56), text('small', 16)],
  });
  const tpl = toElementorTemplate([sec], TOKENS, 't');
  const s = tpl.content[0].settings as Record<string, any>;
  assert.equal(s.padding_tablet.top, '58');
  assert.equal(s.padding_mobile.top, '29');
  assert.equal(s._figma_responsive_inferred, true);
  const big = tpl.content[0].elements[0].settings as Record<string, any>;
  assert.equal(big.typography_font_size_tablet.size, 45);
  assert.equal(big.typography_font_size_mobile.size, 34);
  assert.ok(big.typography_line_height_mobile);
  const small = tpl.content[0].elements[1].settings as Record<string, any>;
  assert.equal(small.typography_font_size_mobile, undefined);
});

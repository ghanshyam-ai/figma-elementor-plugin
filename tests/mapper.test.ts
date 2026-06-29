import { test } from 'node:test';
import assert from 'node:assert/strict';

import { toElementorTemplate } from '../src/mapper';
import type {
  DesignTokens,
  ElementorElement,
  ExtractedNode,
  Fill,
  Stroke,
  TextStyle,
} from '../src/types';

const EMPTY_TOKENS: DesignTokens = {
  colors: [], typography: [], spacing: [], radii: [],
};

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

function makeText(characters: string, partial: Partial<TextStyle> = {}): TextStyle {
  return {
    characters,
    fontFamily: partial.fontFamily ?? 'Inter',
    fontStyle: partial.fontStyle ?? null,
    fontWeight: partial.fontWeight ?? 400,
    fontSize: partial.fontSize ?? 16,
    lineHeight: partial.lineHeight ?? null,
    letterSpacing: partial.letterSpacing ?? null,
    align: partial.align ?? null,
    verticalAlign: partial.verticalAlign ?? null,
    textCase: partial.textCase ?? null,
    textDecoration: partial.textDecoration ?? null,
    color: partial.color ?? null,
    runs: partial.runs,
  };
}

// Find the first element matching a predicate anywhere in the tree.
function find(els: ElementorElement[], pred: (e: ElementorElement) => boolean): ElementorElement | null {
  for (const e of els) {
    if (pred(e)) return e;
    const inner = find(e.elements, pred);
    if (inner) return inner;
  }
  return null;
}

// --- #1 container borders ------------------------------------------------

test('mapContainer emits border settings from a frame stroke', () => {
  const stroke: Stroke = { color: '#CCCCCC', opacity: 1, weight: 2, align: 'INSIDE' };
  const node = makeNode({
    role: 'container',
    semanticRole: 'card',
    strokes: [stroke],
    layout: { mode: 'VERTICAL', itemSpacing: 8 },
    children: [makeNode({ role: 'text', semanticRole: 'text', text: makeText('hi') })],
  });
  const tmpl = toElementorTemplate([node], EMPTY_TOKENS, 'T');
  const container = tmpl.content[0];
  assert.equal(container.settings.border_border, 'solid');
  assert.equal((container.settings.border_color as string), '#CCCCCC');
  assert.ok(container.settings.border_width, 'border_width present');
});

// --- #2 rgba colors ------------------------------------------------------

test('transparent heading color is emitted as rgba()', () => {
  const node = makeNode({
    role: 'text',
    semanticRole: 'text',
    text: makeText('Title', { fontSize: 40, fontWeight: 700, color: '#FF000080' }),
  });
  const tmpl = toElementorTemplate([node], EMPTY_TOKENS, 'T');
  const heading = find(tmpl.content, (e) => e.widgetType === 'heading');
  assert.ok(heading, 'heading emitted');
  assert.equal(heading!.settings.title_color, 'rgba(255, 0, 0, 0.5)');
});

test('opaque colors stay 6-digit hex', () => {
  const node = makeNode({
    role: 'text',
    semanticRole: 'text',
    text: makeText('Title', { fontSize: 40, fontWeight: 700, color: '#112233' }),
  });
  const tmpl = toElementorTemplate([node], EMPTY_TOKENS, 'T');
  const heading = find(tmpl.content, (e) => e.widgetType === 'heading');
  assert.equal(heading!.settings.title_color, '#112233');
});

test('transparent container background becomes rgba()', () => {
  const fill: Fill = { type: 'SOLID', color: '#00000080', opacity: 1 };
  const node = makeNode({ role: 'container', semanticRole: 'section', fills: [fill] });
  const tmpl = toElementorTemplate([node], EMPTY_TOKENS, 'T');
  assert.equal(tmpl.content[0].settings.background_color, 'rgba(0, 0, 0, 0.5)');
});

// --- #5 rich text runs ---------------------------------------------------

test('text-editor preserves an inline hyperlink from runs', () => {
  const node = makeNode({
    role: 'text',
    semanticRole: 'text',
    text: makeText('Visit our site', {
      fontSize: 16,
      runs: [
        { start: 0, end: 6, text: 'Visit ' },
        { start: 6, end: 14, text: 'our site', link: { type: 'URL', value: 'https://example.com' } },
      ],
    }),
  });
  const tmpl = toElementorTemplate([node], EMPTY_TOKENS, 'T');
  const editor = find(tmpl.content, (e) => e.widgetType === 'text-editor');
  assert.ok(editor, 'text-editor emitted');
  const html = editor!.settings.editor as string;
  assert.match(html, /<a href="https:\/\/example\.com" target="_blank"/);
  assert.match(html, /our site<\/a>/);
});

test('text-editor preserves an inline bold run', () => {
  const node = makeNode({
    role: 'text',
    semanticRole: 'text',
    text: makeText('plain bold', {
      fontSize: 16,
      fontWeight: 400,
      runs: [
        { start: 0, end: 6, text: 'plain ', fontWeight: 400 },
        { start: 6, end: 10, text: 'bold', fontWeight: 700 },
      ],
    }),
  });
  const tmpl = toElementorTemplate([node], EMPTY_TOKENS, 'T');
  const editor = find(tmpl.content, (e) => e.widgetType === 'text-editor');
  assert.match(editor!.settings.editor as string, /<strong>bold<\/strong>/);
});

test('bullet list does not get wrapped in an outer <p>', () => {
  const node = makeNode({
    role: 'text',
    semanticRole: 'text',
    text: makeText('- one\n- two', { fontSize: 16 }),
  });
  const tmpl = toElementorTemplate([node], EMPTY_TOKENS, 'T');
  const editor = find(tmpl.content, (e) => e.widgetType === 'text-editor');
  const html = editor!.settings.editor as string;
  assert.equal(html, '<ul><li>one</li><li>two</li></ul>');
  assert.doesNotMatch(html, /<p><ul>/);
});

test('plain multi-line paragraph is wrapped once in <p> with <br>', () => {
  const node = makeNode({
    role: 'text',
    semanticRole: 'text',
    text: makeText('line one\nline two', { fontSize: 16 }),
  });
  const tmpl = toElementorTemplate([node], EMPTY_TOKENS, 'T');
  const editor = find(tmpl.content, (e) => e.widgetType === 'text-editor');
  assert.equal(editor!.settings.editor as string, '<p>line one<br>line two</p>');
});

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

// settings is typed as an object | array union; every test node reads object
// members, so narrow once here for terser assertions.
function settingsOf(e: ElementorElement): Record<string, unknown> {
  return e.settings as Record<string, unknown>;
}

// --- widget-intent builders (#2) ----------------------------------------

test('counterHint node becomes a counter widget, not a heading', () => {
  const node = makeNode({
    role: 'text',
    semanticRole: 'text',
    widgetHint: 'counter',
    counterHint: { raw: '500+', value: 500, suffix: '+', label: 'Happy customers' },
    text: makeText('500+', { fontSize: 48, fontWeight: 700 }),
  });
  const tmpl = toElementorTemplate([node], EMPTY_TOKENS, 'T');
  const counter = find(tmpl.content, (e) => e.widgetType === 'counter');
  assert.ok(counter, 'counter widget emitted');
  const s = settingsOf(counter!);
  assert.equal(s.ending_number, 500);
  assert.equal(s.suffix, '+');
  assert.equal(s.title, 'Happy customers');
  assert.equal(find(tmpl.content, (e) => e.widgetType === 'heading'), null);
});

test('icon-list intent builds an icon_list repeater from child rows', () => {
  const row = (t: string) =>
    makeNode({ role: 'container', children: [makeNode({ role: 'text', text: makeText(t) })] });
  const node = makeNode({
    role: 'container',
    preferredWidget: 'icon-list',
    layout: { mode: 'VERTICAL', itemSpacing: 8 },
    children: [row('Fast'), row('Secure'), row('Reliable')],
  });
  const tmpl = toElementorTemplate([node], EMPTY_TOKENS, 'T');
  const list = find(tmpl.content, (e) => e.widgetType === 'icon-list');
  assert.ok(list, 'icon-list emitted');
  const items = settingsOf(list!).icon_list as Array<{ text: string }>;
  assert.deepEqual(items.map((i) => i.text), ['Fast', 'Secure', 'Reliable']);
});

test('accordion intent builds tab_title/tab_content panels', () => {
  const item = (title: string, body: string) =>
    makeNode({
      role: 'container',
      children: [
        makeNode({ role: 'text', text: makeText(title, { fontSize: 20, fontWeight: 700 }) }),
        makeNode({ role: 'text', text: makeText(body, { fontSize: 14 }) }),
      ],
    });
  const node = makeNode({
    role: 'container',
    widgetHint: 'accordion',
    layout: { mode: 'VERTICAL', itemSpacing: 8 },
    children: [item('Q1', 'A1'), item('Q2', 'A2')],
  });
  const tmpl = toElementorTemplate([node], EMPTY_TOKENS, 'T');
  const acc = find(tmpl.content, (e) => e.widgetType === 'accordion');
  assert.ok(acc, 'accordion emitted');
  const tabs = settingsOf(acc!).tabs as Array<{ tab_title: string; tab_content: string }>;
  assert.equal(tabs.length, 2);
  assert.equal(tabs[0].tab_title, 'Q1');
  assert.equal(tabs[0].tab_content, '<p>A1</p>');
});

test('form intent builds form_fields from detected inputs', () => {
  const input = (type: 'text' | 'email', label: string, required: boolean) =>
    makeNode({
      role: 'container',
      semanticRole: 'input',
      inputMetadata: { inputType: type, label, required },
    });
  const node = makeNode({
    role: 'container',
    semanticRole: 'form',
    preferredWidget: 'form',
    layout: { mode: 'VERTICAL', itemSpacing: 8 },
    children: [
      input('text', 'Name', true),
      input('email', 'Email', true),
      makeNode({ role: 'button', semanticRole: 'button', children: [makeNode({ role: 'text', text: makeText('Send') })] }),
    ],
  });
  const tmpl = toElementorTemplate([node], EMPTY_TOKENS, 'T');
  const form = find(tmpl.content, (e) => e.widgetType === 'form');
  assert.ok(form, 'form emitted');
  const s = settingsOf(form!);
  const fields = s.form_fields as Array<{ field_type: string; field_label: string; required: string }>;
  assert.equal(fields.length, 2);
  assert.equal(fields[1].field_type, 'email');
  assert.equal(fields[0].required, 'true');
  assert.equal(s.button_text, 'Send');
});

// --- form field types clamp to Elementor-supported set (fix #1) ---------

test('unsupported form field types clamp to text, label preserved', () => {
  const input = (type: string, label: string) =>
    makeNode({
      role: 'container',
      semanticRole: 'input',
      // inputType is a wider union than Elementor supports; cast for the test.
      inputMetadata: { inputType: type as never, label },
    });
  const node = makeNode({
    role: 'container',
    semanticRole: 'form',
    preferredWidget: 'form',
    layout: { mode: 'VERTICAL', itemSpacing: 8 },
    children: [input('password', 'Password'), input('search', 'Search'), input('email', 'Email')],
  });
  const tmpl = toElementorTemplate([node], EMPTY_TOKENS, 'T');
  const form = find(tmpl.content, (e) => e.widgetType === 'form');
  const fields = settingsOf(form!).form_fields as Array<{ field_type: string; field_label: string }>;
  assert.equal(fields[0].field_type, 'text');
  assert.equal(fields[0].field_label, 'Password');
  assert.equal(fields[1].field_type, 'text');
  assert.equal(fields[2].field_type, 'email'); // supported type survives
});

// --- background image sizing + object-fit (fix #2 / #3) -----------------

test('image background fill emits cover/center/no-repeat', () => {
  const fill: Fill = { type: 'IMAGE', assetId: 'img_1', scaleMode: 'FILL', opacity: 1 };
  const node = makeNode({ role: 'container', semanticRole: 'section', width: 1440, height: 600, fills: [fill] });
  const s = settingsOf(toElementorTemplate([node], EMPTY_TOKENS, 'T').content[0]);
  assert.equal(s.background_size, 'cover');
  assert.equal(s.background_position, 'center center');
  assert.equal(s.background_repeat, 'no-repeat');
});

test('a FIT image background is contained, not covered', () => {
  const fill: Fill = { type: 'IMAGE', assetId: 'img_2', scaleMode: 'FIT', opacity: 1 };
  const node = makeNode({ role: 'container', semanticRole: 'section', width: 1440, height: 600, fills: [fill] });
  const s = settingsOf(toElementorTemplate([node], EMPTY_TOKENS, 'T').content[0]);
  assert.equal(s.background_size, 'contain');
});

test('image widget maps scaleMode to object-fit', () => {
  const fill: Fill = { type: 'IMAGE', assetId: 'img_3', scaleMode: 'FIT', opacity: 1 };
  const node = makeNode({ role: 'image', semanticRole: 'image', assetId: 'img_3', width: 200, height: 200, fills: [fill] });
  const img = find(toElementorTemplate([node], EMPTY_TOKENS, 'T').content, (e) => e.widgetType === 'image');
  assert.equal(settingsOf(img!)['object-fit'], 'contain');
});

// --- heading vs prose + guaranteed h1 (fix #5) --------------------------

test('a long paragraph at heading size stays a text-editor', () => {
  const long = 'This is a fairly long introductory paragraph that clearly reads as body prose rather than a short punchy headline.';
  const node = makeNode({ role: 'text', semanticRole: 'text', text: makeText(long, { fontSize: 28, fontWeight: 400 }) });
  const tmpl = toElementorTemplate([node], EMPTY_TOKENS, 'T');
  assert.ok(find(tmpl.content, (e) => e.widgetType === 'text-editor'), 'text-editor emitted');
  assert.equal(find(tmpl.content, (e) => e.widgetType === 'heading'), null);
});

test('the largest heading is promoted to h1 when none exists', () => {
  const big = makeNode({ role: 'text', semanticRole: 'text', y: 0, height: 50, text: makeText('Main title', { fontSize: 40, fontWeight: 700 }) });
  const small = makeNode({ role: 'text', semanticRole: 'text', y: 80, height: 30, text: makeText('Subtitle', { fontSize: 26, fontWeight: 700 }) });
  const node = makeNode({ role: 'container', semanticRole: 'section', width: 800, height: 200, children: [big, small] });
  const tmpl = toElementorTemplate([node], EMPTY_TOKENS, 'T');
  const headings = [] as ElementorElement[];
  (function walk(els: ElementorElement[]) { for (const e of els) { if (e.widgetType === 'heading') headings.push(e); walk(e.elements); } })(tmpl.content);
  const h1s = headings.filter((h) => settingsOf(h).header_size === 'h1');
  assert.equal(h1s.length, 1, 'exactly one h1');
  assert.equal(settingsOf(h1s[0]).title, 'Main title');
});

// --- unbuilt widget intent marker (fix #8) ------------------------------

test('an unbuilt widget intent stamps _unbuilt_widget_intent on the fallback', () => {
  const node = makeNode({
    role: 'container',
    preferredWidget: 'nav-menu',
    layout: { mode: 'HORIZONTAL', itemSpacing: 16 },
    children: [makeNode({ role: 'text', text: makeText('Home') }), makeNode({ role: 'text', text: makeText('About') })],
  });
  const s = settingsOf(toElementorTemplate([node], EMPTY_TOKENS, 'T').content[0]);
  assert.equal(s._unbuilt_widget_intent, 'nav-menu');
});

// --- top-level width (#3) -----------------------------------------------

test('top-level container is boxed to the Figma frame width', () => {
  const node = makeNode({ role: 'container', semanticRole: 'section', width: 1440, height: 600 });
  const tmpl = toElementorTemplate([node], EMPTY_TOKENS, 'T');
  const s = settingsOf(tmpl.content[0]);
  assert.equal(s.content_width, 'boxed');
  assert.deepEqual(s.boxed_width, { unit: 'px', size: 1440, sizes: [] });
});

// --- template type + empty page_settings (#6, #7) -----------------------

test('a navbar root produces a header template with the header wrapper tag', () => {
  const node = makeNode({ role: 'container', semanticRole: 'navbar', width: 1440, height: 80 });
  const tmpl = toElementorTemplate([node], EMPTY_TOKENS, 'Site Header');
  assert.equal(tmpl.type, 'header');
  assert.deepEqual(tmpl.page_settings, { content_wrapper_html_tag: 'header' });
});

test('an ordinary page emits page_settings as an empty array', () => {
  const node = makeNode({ role: 'container', semanticRole: 'section', width: 1200, height: 400 });
  const tmpl = toElementorTemplate([node], EMPTY_TOKENS, 'T');
  assert.equal(tmpl.type, 'page');
  assert.deepEqual(tmpl.page_settings, []);
});

// --- mapper-side stack inference (#5) -----------------------------------

test('non-overlapping children of a NONE-layout frame flow as a column, not absolute', () => {
  const a = makeNode({ role: 'text', y: 0, height: 40, text: makeText('top', { fontSize: 30, fontWeight: 700 }) });
  const b = makeNode({ role: 'text', y: 60, height: 40, text: makeText('bottom', { fontSize: 16 }) });
  const node = makeNode({
    role: 'container', semanticRole: 'section', width: 800, height: 200,
    layout: { mode: 'NONE' }, children: [a, b],
  });
  const tmpl = toElementorTemplate([node], EMPTY_TOKENS, 'T');
  const container = tmpl.content[0];
  assert.equal(settingsOf(container).flex_direction, 'column');
  for (const child of container.elements) {
    assert.notEqual(settingsOf(child)._position, 'absolute');
  }
});

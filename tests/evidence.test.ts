import { test } from 'node:test';
import assert from 'node:assert/strict';

import { detectImageFormat } from '../src/imageFormat';
import { invertTransform, multiplyTransform, relativeFromAbsolute } from '../src/figmaEvidence';
import { toElementorTemplate } from '../src/mapper';
import { rewriteAssetReferences, validateAssetReferences } from '../src/assetValidation';
import { validateElementorTemplate } from '../src/elementorSchema';
import type { AssetManifestEntry, DesignTokens, ExtractedNode, ImageFill } from '../src/types';

const TOKENS: DesignTokens = { colors: [], typography: [], spacing: [], radii: [] };

function node(o: Partial<ExtractedNode>): ExtractedNode {
  return {
    id: o.id ?? 'n1', name: o.name ?? 'Node', type: o.type ?? 'FRAME', visible: true,
    role: o.role ?? 'container', x: 0, y: 0, width: 100, height: 100,
    fills: [], strokes: [], layout: { mode: 'NONE' }, children: [], ...o,
  };
}

const bytes = (...b: number[]) => new Uint8Array(b);

test('detectImageFormat sniffs png / jpg / gif / webp from magic bytes', () => {
  assert.equal(detectImageFormat(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0)), 'png');
  assert.equal(detectImageFormat(bytes(0xff, 0xd8, 0xff, 0xe0, 0)), 'jpg');
  assert.equal(detectImageFormat(bytes(0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0)), 'gif');
  assert.equal(detectImageFormat(bytes(0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50)), 'webp');
  assert.equal(detectImageFormat(bytes(1, 2, 3)), null);
});

test('relative transform = inverse(parent.abs) × child.abs', () => {
  // parent translated (100, 50) and scaled 2x; child translated (140, 90).
  const parent = [[2, 0, 100], [0, 2, 50]];
  const child = [[1, 0, 140], [0, 1, 90]];
  const rel = relativeFromAbsolute(parent, child)!;
  // child origin in parent space: ((140-100)/2, (90-50)/2) = (20, 20); scale 0.5
  assert.deepEqual(rel, [[0.5, 0, 20], [0, 0.5, 20]]);
  // round trip: parent × rel = child
  const back = multiplyTransform(parent, rel);
  assert.deepEqual(back, [[1, 0, 140], [0, 1, 90]]);
});

test('invertTransform handles rotation and rejects singular matrices', () => {
  const rot90 = [[0, -1, 10], [1, 0, 20]];
  const inv = invertTransform(rot90)!;
  const id = multiplyTransform(rot90, inv);
  assert.ok(Math.abs(id[0][0] - 1) < 1e-9 && Math.abs(id[1][1] - 1) < 1e-9);
  assert.ok(Math.abs(id[0][2]) < 1e-9 && Math.abs(id[1][2]) < 1e-9);
  assert.equal(invertTransform([[0, 0, 0], [0, 0, 0]]), null);
});

const jpegFill: ImageFill = {
  type: 'IMAGE', assetId: 'img_abc', scaleMode: 'FILL', opacity: 1,
  fillIndex: 0, imageHash: 'abc', imageTransform: undefined,
};

test('mapper uses the exporter file map for image-fill backgrounds and image widgets', () => {
  const frame = node({ id: 'f', fills: [jpegFill], role: 'container' });
  const img = node({ id: 'i', role: 'image', assetId: 'img_abc', fills: [jpegFill], suggestedExportFormat: 'png' });
  const tpl = toElementorTemplate([node({ id: 'root', children: [frame, img] })], TOKENS, 't', undefined, {
    assetFiles: new Map([['img_abc', 'img_abc.jpg']]),
  });
  const json = JSON.stringify(tpl);
  assert.ok(json.includes('assets/images/img_abc.jpg'));
  assert.ok(!json.includes('img_abc.png'));
});

test('multiple IMAGE fills are all preserved on the node', () => {
  const second: ImageFill = { ...jpegFill, assetId: 'img_def', imageHash: 'def', fillIndex: 2, rotation: 90 };
  const frame = node({ id: 'multi', fills: [jpegFill, second] });
  const tpl = toElementorTemplate([frame], TOKENS, 't', undefined, {
    assetFiles: new Map([['img_abc', 'img_abc.jpg'], ['img_def', 'img_def.webp']]),
  });
  const s = tpl.content[0].settings as Record<string, unknown>;
  const fills = s._figma_image_fills as Array<Record<string, unknown>>;
  assert.equal(fills.length, 2);
  assert.equal(fills[1].fillIndex, 2);
  assert.equal(fills[1].file, 'img_def.webp');
  assert.equal(fills[1].rotation, 90);
});

test('rewriteAssetReferences repoints an .svg url at the .png fallback', () => {
  const img = node({ id: 'i', role: 'image', assetId: 'icon_1', suggestedExportFormat: 'svg' });
  const tpl = toElementorTemplate([node({ children: [img] })], TOKENS, 't');
  assert.ok(JSON.stringify(tpl).includes('icon_1.svg'));
  const n = rewriteAssetReferences(tpl, new Map([['icon_1', 'icon_1.png']]));
  assert.ok(n >= 1);
  assert.ok(!JSON.stringify(tpl).includes('icon_1.svg'));
  assert.ok(JSON.stringify(tpl).includes('assets/images/icon_1.png'));
});

test('validateAssetReferences reports missing, mismatched and unrewritten refs', () => {
  const img = node({ id: 'i', role: 'image', assetId: 'icon_1', suggestedExportFormat: 'svg' });
  const gone = node({ id: 'g', role: 'image', assetId: 'img_gone', suggestedExportFormat: 'png' });
  const tpl = toElementorTemplate([node({ children: [img, gone] })], TOKENS, 't');
  const manifest = [{
    id: 'icon_1', filename: 'icon_1.png', assetType: 'icon', originalFormat: 'svg',
    suggestedExportFormat: 'svg', width: 1, height: 1,
  }] as AssetManifestEntry[];
  const rep = validateAssetReferences(tpl, manifest, {
    queuedAssets: [], successfulAssets: [], failedAssets: [{ id: 'img_gone', reason: 'x' }],
  });
  assert.ok(rep.brokenAssetReferences.some((b) => b.reason.startsWith('svg fallback not rewritten')));
  assert.ok(rep.missingAssets.some((m) => m.id === 'img_gone'));

  rewriteAssetReferences(tpl, new Map([['icon_1', 'icon_1.png']]));
  const after = validateAssetReferences(tpl, manifest);
  assert.ok(!after.brokenAssetReferences.some((b) => b.url.includes('icon_1')));
});

test('schema: container uses bare keys, widget uses prefixed keys', () => {
  const good = node({
    id: 'c', layout: { mode: 'VERTICAL', itemSpacing: 8, padding: { top: 8, right: 8, bottom: 8, left: 8 } },
    cornerRadius: 4, children: [node({ id: 'img', role: 'image', assetId: 'a', cornerRadius: 4 })],
  });
  const tpl = toElementorTemplate([good], TOKENS, 't');
  const rep = validateElementorTemplate(tpl);
  assert.deepEqual(rep.issues.filter((i) => i.level === 'error'), []);
  const container = tpl.content[0].settings as Record<string, unknown>;
  assert.ok('padding' in container && !('_padding' in container));
  assert.ok('border_radius' in container && !('_border_radius' in container));
  const widget = tpl.content[0].elements[0].settings as Record<string, unknown>;
  assert.ok('_border_radius' in widget && !('border_radius' in widget));
  assert.ok('_element_width' in widget);
});

test('schema: catches wrong key conventions and bad structure', () => {
  const tpl = toElementorTemplate([node({})], TOKENS, 't');
  const c = tpl.content[0];
  (c.settings as Record<string, unknown>)._padding = { unit: 'px', top: '1', right: '1', bottom: '1', left: '1' };
  c.elements.push({
    id: 'w1', elType: 'widget', widgetType: 'heading',
    settings: { margin: { unit: 'px', top: '1', right: '1', bottom: '1', left: '1' } }, elements: [],
  });
  c.elements.push({ id: 'w1', elType: 'widget', settings: {}, elements: [] });
  const issues = validateElementorTemplate(tpl).issues;
  const codes = issues.map((i) => i.code);
  assert.ok(codes.includes('container-prefixed-key'));
  assert.ok(codes.includes('widget-bare-key'));
  assert.ok(codes.includes('duplicate-id'));
  assert.ok(codes.includes('missing-widget-type'));
});

import { buildElementorGlobals } from '../src/elementorGlobals';

test('elementorGlobals maps role hints to system slots and keeps the rest as custom', () => {
  const g = buildElementorGlobals({
    colors: [
      { name: 'brand-primary', value: '#635BFF', usage: 9, roleHint: 'brand-primary' },
      { name: 'ink', value: '#111111', usage: 9, roleHint: 'text-default' },
      { name: 'sky', value: '#00AAFF', usage: 2 },
    ],
    typography: [
      { name: 'h1', fontFamily: 'Inter', fontWeight: 700, fontSize: 40, lineHeight: 48, letterSpacing: null },
      { name: 'body', fontFamily: 'Inter', fontWeight: 400, fontSize: 16, lineHeight: 24, letterSpacing: null },
    ],
    spacing: [], radii: [],
  });
  assert.deepEqual(g.colors.system.map((c) => c._id), ['primary', 'text']);
  assert.equal(g.colors.system[0].color, '#635BFF');
  assert.equal(g.colors.custom.length, 1);
  assert.equal(g.references['color.brand-primary'], 'globals/colors?id=primary');
  assert.equal(g.typography.system[0]._id, 'primary');
  assert.equal(g.typography.system[0].typography_font_size?.size, 40);
  assert.equal(g.references['font.body.family'], 'globals/typography?id=text');
  assert.equal(g.siteSettings.body_color, '#111111');
  assert.equal(g.siteSettings.h1_typography_font_family, 'Inter');
});

test('image-carousel intent builds a native widget only when every slide is a lone image', () => {
  const slide = (i: number) => node({
    id: 's' + i, width: 200,
    children: [node({ id: 'i' + i, role: 'image', semanticRole: 'image', assetId: 'img_' + i, width: 200 })],
  });
  const ok = node({ id: 'car', width: 600, widgetHint: 'image-carousel', children: [slide(1), slide(2), slide(3)] });
  const tpl = toElementorTemplate([ok], TOKENS, 't', undefined, {
    assetFiles: new Map([['img_1', 'img_1.jpg'], ['img_2', 'img_2.png'], ['img_3', 'img_3.webp']]),
  });
  const el = tpl.content[0];
  assert.equal(el.widgetType, 'image-carousel');
  const s = el.settings as Record<string, any>;
  assert.equal(s.carousel.length, 3);
  assert.equal(s.carousel[0].url, 'assets/images/img_1.jpg');
  assert.equal(s.slides_to_show, '3');
  assert.equal(s._unbuilt_widget_intent, undefined);

  // A slide that also carries text can't be a plain image carousel.
  const withText = node({
    id: 'car2', width: 600, widgetHint: 'image-carousel',
    children: [
      node({ id: 'a', children: [node({ role: 'image', assetId: 'x' }), node({ role: 'text', text: { characters: 'c' } as any })] }),
      slide(2),
    ],
  });
  const fb = toElementorTemplate([withText], TOKENS, 't').content[0];
  assert.equal(fb.elType, 'container');
  assert.equal((fb.settings as any)._unbuilt_widget_intent, 'image-carousel');
});

test('image + solid base + gradient keeps the photo (classic bg) and moves the fade to an overlay', () => {
  const frame = node({
    id: 'hero',
    fills: [
      { type: 'SOLID', color: '#1B2736', opacity: 1 },
      { ...jpegFill, opacity: 0.4 },
      { type: 'GRADIENT_LINEAR', opacity: 1, angle: 90, stops: [
        { position: 0, color: '#1B2736E6' }, { position: 1, color: '#1B273600' },
      ] },
    ],
  });
  const s = toElementorTemplate([frame], TOKENS, 't').content[0].settings as Record<string, any>;
  assert.equal(s.background_background, 'classic');
  assert.ok(s.background_image);
  assert.equal(s.background_color, '#1B2736');
  assert.equal(s.background_color_b, undefined);
  assert.equal(s.background_overlay_background, 'gradient');
  assert.equal(s.background_overlay_opacity.size, 1);
  // 40% photo over the base is folded into the fade: 0.9 → 1-(0.4*0.1)=0.96, 0 → 0.6
  assert.equal(s.background_overlay_color, 'rgba(27, 39, 54, 0.96)');
  assert.equal(s.background_overlay_color_b, 'rgba(27, 39, 54, 0.6)');
});

test('a translucent solid fill keeps its opacity', () => {
  const frame = node({ fills: [{ type: 'SOLID', color: '#000000', opacity: 0.5 }] });
  const s = toElementorTemplate([frame], TOKENS, 't').content[0].settings as Record<string, any>;
  assert.equal(s.background_color, 'rgba(0, 0, 0, 0.5)');
});

test('nav-menu fallback hands over the menu items and only flags the inner menu', () => {
  const label = (t: string) => node({ role: 'text', semanticRole: 'text', text: { characters: t, runs: undefined } as any });
  const menu = node({
    id: 'menu', widgetHint: 'nav-menu', semanticRole: 'menu',
    layout: { mode: 'HORIZONTAL', itemSpacing: 8 },
    children: [label('Home'), label('Products ▾'), label('About')],
  });
  const header = node({ id: 'hdr', semanticRole: 'navbar', preferredWidget: 'nav-menu', layout: { mode: 'HORIZONTAL' }, children: [menu] });
  const tpl = toElementorTemplate([header], TOKENS, 't');
  const h = tpl.content[0].settings as Record<string, any>;
  const m = tpl.content[0].elements[0].settings as Record<string, any>;
  assert.equal(h._unbuilt_widget_intent, undefined);
  assert.equal(m._unbuilt_widget_intent, 'nav-menu');
  assert.deepEqual(m._figma_nav_items, [
    { label: 'Home' }, { label: 'Products', hasDropdown: true }, { label: 'About' },
  ]);
});

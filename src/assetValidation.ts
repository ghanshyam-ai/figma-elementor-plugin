import type {
  AssetExportReport,
  AssetManifestEntry,
  AssetReferenceReport,
  ElementorElement,
  ElementorTemplate,
} from './types';

const IMAGE_PREFIX = 'assets/images/';

type Json = unknown;

function isObj(v: Json): v is Record<string, Json> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

// Visit every settings object in the template (depth-first).
function eachElement(els: ElementorElement[], fn: (el: ElementorElement) => void): void {
  for (const el of els) {
    fn(el);
    if (el.elements && el.elements.length) eachElement(el.elements, fn);
  }
}

// Collect every asset-path string reachable from a settings value, together
// with the `_figma_asset_id` of the wrapper object that carries it (if any).
function collectRefs(
  v: Json,
  out: { url: string; assetId?: string }[],
  assetId?: string,
): void {
  if (Array.isArray(v)) {
    for (const x of v) collectRefs(x, out, assetId);
    return;
  }
  if (!isObj(v)) return;
  const ownId = typeof v._figma_asset_id === 'string'
    ? v._figma_asset_id
    : typeof v.assetId === 'string' ? v.assetId : assetId;
  for (const [k, val] of Object.entries(v)) {
    if (typeof val === 'string') {
      if (val.startsWith(IMAGE_PREFIX)) out.push({ url: val, assetId: ownId });
      // _figma_image_fills[].file stores the bare filename.
      else if (k === 'file' && /\.(png|jpe?g|webp|gif|svg)$/i.test(val)) {
        out.push({ url: IMAGE_PREFIX + val, assetId: ownId });
      }
    } else {
      collectRefs(val, out, ownId);
    }
  }
}

// Final check that every image reference in data.json lands on a file that
// was actually exported — including alias ids and SVG→PNG fallbacks.
export function validateAssetReferences(
  template: ElementorTemplate,
  manifest: AssetManifestEntry[],
  exportReport?: AssetExportReport,
): AssetReferenceReport {
  const files = new Set<string>();
  const stems = new Map<string, string[]>(); // stem → existing filenames
  const knownIds = new Set<string>();
  for (const m of manifest) {
    if (m.exportStatus === 'failed') continue;
    files.add(m.filename);
    const stem = m.filename.replace(/\.[^./]+$/, '');
    stems.set(stem, [...(stems.get(stem) ?? []), m.filename]);
    knownIds.add(m.id);
    for (const a of m.aliasIds ?? []) knownIds.add(a);
  }

  const broken: AssetReferenceReport['brokenAssetReferences'] = [];
  const missing = new Map<string, Set<string>>();

  eachElement(template.content, (el) => {
    const refs: { url: string; assetId?: string }[] = [];
    collectRefs(el.settings, refs);
    const settings = isObj(el.settings) ? el.settings : {};
    const figmaId = typeof settings._figma_id === 'string' ? settings._figma_id : undefined;
    for (const ref of refs) {
      const name = ref.url.slice(IMAGE_PREFIX.length);
      if (files.has(name)) continue;
      const stem = name.replace(/\.[^./]+$/, '');
      const sibling = stems.get(stem);
      let reason: string;
      if (sibling) {
        reason = `extension mismatch: exported as ${sibling.join(', ')}`;
        if (/\.svg$/i.test(name)) reason = `svg fallback not rewritten: exported as ${sibling.join(', ')}`;
      } else if (ref.assetId && !knownIds.has(ref.assetId)) {
        reason = 'asset id unknown to assets.json';
      } else {
        reason = 'file was not exported';
      }
      broken.push({ url: ref.url, elementId: el.id, figmaId, reason });
      if (ref.assetId) {
        const set = missing.get(ref.assetId) ?? new Set<string>();
        set.add(el.id);
        missing.set(ref.assetId, set);
      }
    }
  });

  // Assets that failed to export are missing even if nothing points at them.
  for (const f of exportReport?.failedAssets ?? []) {
    if (!missing.has(f.id)) missing.set(f.id, new Set());
  }

  return {
    missingAssets: Array.from(missing, ([id, refs]) => ({ id, referencedBy: Array.from(refs) })),
    brokenAssetReferences: broken,
  };
}

// Safety net after export: any wrapper carrying `_figma_asset_id` whose url
// no longer matches the finalized filename (e.g. the exporter fell back from
// SVG to PNG) is rewritten in place. Returns the number of rewrites.
export function rewriteAssetReferences(
  template: ElementorTemplate,
  assetFiles: ReadonlyMap<string, string>,
): number {
  let rewrites = 0;
  function walk(v: Json): void {
    if (Array.isArray(v)) { v.forEach(walk); return; }
    if (!isObj(v)) return;
    const id = v._figma_asset_id;
    if (typeof id === 'string' && typeof v.url === 'string' && v.url.startsWith(IMAGE_PREFIX)) {
      const final = assetFiles.get(id);
      if (final && v.url !== IMAGE_PREFIX + final) {
        v.url = IMAGE_PREFIX + final;
        rewrites += 1;
      }
    }
    if (typeof v.assetId === 'string' && typeof v.file === 'string') {
      const final = assetFiles.get(v.assetId);
      if (final && v.file !== final) {
        v.file = final;
        rewrites += 1;
      }
    }
    for (const val of Object.values(v)) walk(val);
  }
  eachElement(template.content, (el) => walk(el.settings));
  return rewrites;
}

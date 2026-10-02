import type {
  Asset, AssetExportReport, AssetFormat, AssetType, ExtractedNode, Screenshot,
} from './types';
import type { ImageRegistry } from './extractor';
import { detectImageFormat, extensionFor } from './imageFormat';

export type ExportedAssets = {
  assets: Asset[];
  report: AssetExportReport;
  // assetId (and every alias) -> final filename inside assets/images/.
  // This is the single source of truth the mapper rewrites references from.
  fileMap: Map<string, string>;
};

// Build the assetId -> filename lookup from the finalized asset list,
// including aliases that collapsed onto a canonical asset.
export function buildAssetFileMap(assets: Asset[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const a of assets) {
    if (a.role === 'rendered-reference') continue;
    map.set(a.id, a.filename);
    for (const alias of a.aliasIds ?? []) map.set(alias, a.filename);
  }
  return map;
}

// Export image-fill assets registered during extraction, plus rasterise (or
// SVG-export) any node that we classified as image-like but whose pixels live
// in vector form. De-duplicated by asset id.
//
// Image-fill assetIds are content-addressed (`img_<hash>`) and the extension
// follows the sniffed bytes (Figma hands back the *original* upload, which
// may be JPEG/WebP/GIF), so the filename is stable across runs — the agent's
// media-library uploader can skip re-uploading an unchanged image.
export async function exportAssets(
  imageNodes: { node: SceneNode; assetId: string; format: AssetFormat; assetType: AssetType }[],
  registry: ImageRegistry,
  referenceNodes: RenderedReferenceCandidate[] = [],
): Promise<ExportedAssets> {
  const out: Asset[] = [];
  const seen = new Set<string>();
  const report: AssetExportReport = { queuedAssets: [], successfulAssets: [], failedAssets: [] };
  const queue = (id: string, source: AssetExportReport['queuedAssets'][number]['source'], nodeId?: string) => {
    report.queuedAssets.push({ id, source, nodeId });
  };
  const succeed = (a: Asset) => {
    out.push(a);
    seen.add(a.id);
    report.successfulAssets.push({ id: a.id, filename: a.filename });
  };
  const fail = (id: string, e: unknown) => {
    report.failedAssets.push({ id, reason: e instanceof Error ? e.message : String(e) });
  };

  // 1. Image fills referenced via imageHash.
  for (const { hash, assetId } of registry.entries()) {
    if (seen.has(assetId)) continue;
    queue(assetId, 'image-fill', registry.usagesOf(assetId)[0]?.nodeId);
    const image = figma.getImageByHash(hash);
    if (!image) {
      fail(assetId, 'figma.getImageByHash returned null');
      continue;
    }
    try {
      const bytes = await image.getBytesAsync();
      const size = await image.getSizeAsync().catch(() => ({ width: 0, height: 0 }));
      const sniffed = detectImageFormat(bytes);
      const format: AssetFormat = sniffed ?? 'png';
      succeed({
        id: assetId,
        filename: `${assetId}.${extensionFor(format)}`,
        bytes,
        width: size.width,
        height: size.height,
        format,
        assetType: 'image',
        role: 'original',
        formatUnverified: sniffed ? undefined : true,
      });
    } catch (e) {
      console.warn('Failed to export image', assetId, e);
      fail(assetId, e);
    }
  }

  // 2. Nodes flagged as image-like with no fill (vectors, icons, logos).
  //
  // We content-hash each rasterised/SVG output and dedupe by the hash so
  // the same icon copied across the page produces one asset, not N. The
  // original assetId (icon_<nodeId>) is preserved on aliasIds for the
  // mapper to resolve back to the canonical filename when needed.
  const byContentHash = new Map<string, string>(); // contentHash → canonical assetId
  const aliases: { from: string; to: string }[] = [];
  for (const { node, assetId, format, assetType } of imageNodes) {
    if (seen.has(assetId)) continue;
    queue(assetId, 'node-render', node.id);
    try {
      let bytes: Uint8Array;
      let outFormat: AssetFormat = format;
      if (format === 'svg') {
        try {
          bytes = await node.exportAsync({ format: 'SVG' });
        } catch {
          // SVG export can fail for some node types — fall back to PNG@2x.
          // The file map below carries the .png name so data.json never
          // keeps pointing at the old .svg.
          bytes = await node.exportAsync({ format: 'PNG', constraint: { type: 'SCALE', value: 2 } });
          outFormat = 'png';
        }
      } else {
        bytes = await node.exportAsync({ format: 'PNG', constraint: { type: 'SCALE', value: 2 } });
        outFormat = 'png';
      }
      const contentHash = `${outFormat}:${djb2(bytes)}`;
      const existing = byContentHash.get(contentHash);
      if (existing) {
        // Same vector rendered before — alias the node id to the canonical
        // asset id so mapper-side lookups still find a file.
        aliases.push({ from: assetId, to: existing });
        seen.add(assetId);
        report.successfulAssets.push({ id: assetId, filename: `(alias of ${existing})` });
        continue;
      }
      byContentHash.set(contentHash, assetId);
      const scale = outFormat === 'svg' ? 1 : 2;
      succeed({
        id: assetId,
        filename: `${assetId}.${extensionFor(outFormat)}`,
        bytes,
        width: 'width' in node ? Math.round(node.width * scale) : 0,
        height: 'height' in node ? Math.round(node.height * scale) : 0,
        format: outFormat,
        assetType,
        aliasIds: undefined,
        role: 'original',
      });
    } catch (e) {
      console.warn('Failed to render node as image', assetId, e);
      fail(assetId, e);
    }
  }

  // 3. Rendered 2x Figma references for nodes whose crop / mask / filter /
  // transform the raw image file cannot reproduce on its own.
  for (const ref of referenceNodes) {
    const refId = `ref_${ref.nodeId.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
    if (seen.has(refId)) continue;
    queue(refId, 'rendered-reference', ref.nodeId);
    try {
      const node = await figma.getNodeByIdAsync(ref.nodeId);
      if (!node || !('exportAsync' in node)) {
        fail(refId, 'node not exportable');
        continue;
      }
      const bytes = await (node as SceneNode).exportAsync({
        format: 'PNG',
        constraint: { type: 'SCALE', value: 2 },
        useAbsoluteBounds: false,
      });
      const bounds = ('absoluteRenderBounds' in node && node.absoluteRenderBounds) || null;
      const w = bounds ? bounds.width : 'width' in node ? node.width : 0;
      const h = bounds ? bounds.height : 'height' in node ? node.height : 0;
      succeed({
        id: refId,
        filename: `rendered/${refId}.png`,
        bytes,
        width: Math.round(w * 2),
        height: Math.round(h * 2),
        format: 'png',
        assetType: 'image',
        role: 'rendered-reference',
        referenceFor: ref.assetId,
        nodeId: ref.nodeId,
      });
    } catch (e) {
      console.warn('Failed to render reference for', ref.nodeId, e);
      fail(refId, e);
    }
  }

  // Stamp alias lists onto their canonical assets so downstream consumers
  // (assets.json, mapper rewrites) can resolve duplicate node ids back.
  if (aliases.length > 0) {
    const byId = new Map(out.map((a) => [a.id, a]));
    for (const { from, to } of aliases) {
      const target = byId.get(to);
      if (!target) continue;
      if (!target.aliasIds) target.aliasIds = [];
      target.aliasIds.push(from);
    }
  }

  return { assets: out, report, fileMap: buildAssetFileMap(out) };
}

// A node whose image fill is cropped / tiled / rotated / filtered / masked,
// so a plain copy of the original file will not match what Figma draws.
export type RenderedReferenceCandidate = { nodeId: string; assetId: string };

export function collectRenderedReferenceCandidates(trees: ExtractedNode[]): RenderedReferenceCandidate[] {
  const out: RenderedReferenceCandidate[] = [];
  function walk(n: ExtractedNode, underMask: boolean) {
    const img = n.fills.find((f) => f.type === 'IMAGE');
    if (img && img.type === 'IMAGE') {
      const complex =
        img.scaleMode === 'CROP' || img.scaleMode === 'TILE' ||
        !!img.imageTransform || !!img.rotation || !!img.filters || !!img.blendMode ||
        (n.rotation !== undefined && n.rotation !== 0) ||
        n.fills.filter((f) => f.type === 'IMAGE').length > 1 ||
        underMask || !!n.isMask;
      if (complex) out.push({ nodeId: n.id, assetId: img.assetId });
    }
    const childUnderMask = underMask || n.children.some((c) => c.isMask);
    for (const c of n.children) walk(c, childUnderMask);
  }
  for (const t of trees) walk(t, false);
  return out;
}

// Cheap stable hash for content-addressing exported bytes. Not crypto;
// just enough to detect equality without bundling a SHA implementation.
function djb2(bytes: Uint8Array): string {
  let h = 5381;
  for (let i = 0; i < bytes.length; i += 1) h = ((h << 5) + h + bytes[i]) >>> 0;
  return h.toString(36) + '-' + bytes.length.toString(36);
}

// Roles that justify their own screenshot crop. Tabs/forms/cards aren't
// section-shaped enough to be useful — we only crop the structural top-
// level units the architecture router cares about.
const SECTION_CROP_ROLES = new Set([
  'section', 'hero', 'navbar', 'footer',
]);

// Capture each top-level selected frame as a PNG screenshot, plus a crop
// per top-level structural section so the agent's confidence-fallback
// strategy has visual context for individual sections (not just the
// whole page). When a wrapper frame was flattened (the artificial-root
// case), we also emit `page.png` from the original wrapper so the full
// canvas the designer composed is preserved as a single reference.
export async function captureScreenshots(
  roots: SceneNode[],
  trees: ExtractedNode[],
  flattenedFromRoot: SceneNode | null = null,
): Promise<Screenshot[]> {
  const out: Screenshot[] = [];

  if (flattenedFromRoot && 'exportAsync' in flattenedFromRoot) {
    try {
      const bytes = await (flattenedFromRoot as SceneNode).exportAsync({
        format: 'PNG',
        constraint: { type: 'SCALE', value: 2 },
      });
      out.push({
        filename: 'page.png',
        bytes,
        width: 'width' in flattenedFromRoot ? Math.round(flattenedFromRoot.width * 2) : 0,
        height: 'height' in flattenedFromRoot ? Math.round(flattenedFromRoot.height * 2) : 0,
        nodeId: flattenedFromRoot.id,
        nodeName: flattenedFromRoot.name,
        scope: 'frame',
      });
    } catch (e) {
      console.warn('Failed to capture page screenshot from wrapper', flattenedFromRoot.name, e);
    }
  }

  for (let i = 0; i < roots.length; i += 1) {
    const r = roots[i];
    try {
      const bytes = await r.exportAsync({
        format: 'PNG',
        constraint: { type: 'SCALE', value: 2 },
      });
      const base = sanitize(r.name) || `page-${i + 1}`;
      const filename = roots.length === 1 ? `${base}.png` : `${base}-${i + 1}.png`;
      out.push({
        filename,
        bytes,
        width: Math.round(r.width * 2),
        height: Math.round(r.height * 2),
        nodeId: r.id,
        nodeName: r.name,
        scope: 'frame',
      });
    } catch (e) {
      console.warn('Failed to capture screenshot for', r.name, e);
    }
  }

  // Per-section crops — direct structural children of each root.
  for (const tree of trees) {
    for (const child of tree.children) {
      const role = child.semanticRole;
      if (!role || !SECTION_CROP_ROLES.has(role)) continue;
      const node = await figma.getNodeByIdAsync(child.id);
      if (!node || !('exportAsync' in node)) continue;
      try {
        const bytes = await (node as SceneNode).exportAsync({
          format: 'PNG',
          constraint: { type: 'SCALE', value: 2 },
        });
        const safeId = child.id.replace(/[^a-zA-Z0-9_-]/g, '_');
        out.push({
          filename: `sections/${safeId}.png`,
          bytes,
          width: Math.round(child.width * 2),
          height: Math.round(child.height * 2),
          nodeId: child.id,
          nodeName: child.name,
          scope: 'section',
        });
      } catch (e) {
        console.warn('Failed to capture section screenshot for', child.name, e);
      }
    }
  }
  return out;
}

function sanitize(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase();
}

// Walk extracted trees and resolve raster candidate node ids back to scene nodes.
export async function collectRasterNodes(
  candidates: { nodeId: string; assetId: string; format: AssetFormat; assetType: AssetType }[],
): Promise<{ node: SceneNode; assetId: string; format: AssetFormat; assetType: AssetType }[]> {
  const out: { node: SceneNode; assetId: string; format: AssetFormat; assetType: AssetType }[] = [];
  for (const c of candidates) {
    const node = await figma.getNodeByIdAsync(c.nodeId);
    if (node && 'exportAsync' in node) {
      out.push({ node: node as SceneNode, assetId: c.assetId, format: c.format, assetType: c.assetType });
    }
  }
  return out;
}

// Collect raster candidates by walking the tree (used as a fallback path
// when callers prefer to derive candidates from the extracted tree).
export function collectRasterCandidatesFromTree(
  trees: ExtractedNode[],
): { nodeId: string; assetId: string; format: AssetFormat; assetType: AssetType }[] {
  const out: { nodeId: string; assetId: string; format: AssetFormat; assetType: AssetType }[] = [];
  function walk(t: ExtractedNode) {
    if (t.assetId && !t.fills.some((f) => f.type === 'IMAGE')) {
      const isImageLike = t.role === 'image' ||
        t.semanticRole === 'icon' || t.semanticRole === 'logo' ||
        t.semanticRole === 'background-shape';
      if (isImageLike) {
        out.push({
          nodeId: t.id,
          assetId: t.assetId,
          format: t.suggestedExportFormat ?? 'png',
          assetType: t.assetType ?? 'image',
        });
      }
    }
    for (const c of t.children) walk(c);
  }
  for (const t of trees) walk(t);
  return out;
}

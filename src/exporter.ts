import type { Asset, ExtractedNode, Screenshot } from './types';
import type { ImageRegistry } from './extractor';

const IMG_FORMAT: 'PNG' | 'JPG' = 'PNG';

// Export every image-fill asset registered during extraction, plus rasterise
// any node that we classified as `image` but whose pixels live in a vector
// (e.g. an icon group). De-duplicated by asset id.
export async function exportAssets(
  imageNodes: { node: SceneNode; assetId: string }[],
  registry: ImageRegistry,
): Promise<Asset[]> {
  const out: Asset[] = [];
  const seen = new Set<string>();

  // 1. Image fills referenced via imageHash.
  for (const { hash, assetId } of registry.entries()) {
    if (seen.has(assetId)) continue;
    const image = figma.getImageByHash(hash);
    if (!image) continue;
    try {
      const bytes = await image.getBytesAsync();
      const size = await image.getSizeAsync().catch(() => ({ width: 0, height: 0 }));
      out.push({
        id: assetId,
        filename: `${assetId}.png`,
        bytes,
        width: size.width,
        height: size.height,
      });
      seen.add(assetId);
    } catch (e) {
      console.warn('Failed to export image', assetId, e);
    }
  }

  // 2. Nodes flagged as image with no fill (vector icons etc).
  for (const { node, assetId } of imageNodes) {
    if (seen.has(assetId)) continue;
    try {
      const bytes = await node.exportAsync({
        format: IMG_FORMAT,
        constraint: { type: 'SCALE', value: 2 },
      });
      out.push({
        id: assetId,
        filename: `${assetId}.png`,
        bytes,
        width: 'width' in node ? Math.round(node.width * 2) : 0,
        height: 'height' in node ? Math.round(node.height * 2) : 0,
      });
      seen.add(assetId);
    } catch (e) {
      console.warn('Failed to render node as image', assetId, e);
    }
  }

  return out;
}

// Capture each top-level selected frame as a PNG screenshot.
export async function captureScreenshots(roots: SceneNode[]): Promise<Screenshot[]> {
  const out: Screenshot[] = [];
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
      });
    } catch (e) {
      console.warn('Failed to capture screenshot for', r.name, e);
    }
  }
  return out;
}

function sanitize(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase();
}

// Walk an extracted tree and collect any nodes flagged as `image` whose
// asset id starts with `node_` — these are nodes that need rasterising.
export async function collectRasterNodes(
  trees: ExtractedNode[],
): Promise<{ node: SceneNode; assetId: string }[]> {
  const out: { node: SceneNode; assetId: string }[] = [];
  const ids = new Map<string, string>(); // figma node id -> assetId
  function walk(t: ExtractedNode) {
    if (t.role === 'image' && t.assetId && t.assetId.startsWith('node_')) {
      ids.set(t.id, t.assetId);
    }
    for (const c of t.children) walk(c);
  }
  for (const t of trees) walk(t);

  for (const [id, assetId] of ids) {
    const node = await figma.getNodeByIdAsync(id);
    if (node && 'exportAsync' in node) {
      out.push({ node: node as SceneNode, assetId });
    }
  }
  return out;
}

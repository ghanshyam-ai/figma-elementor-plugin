import type {
  Bounds,
  ComponentMeta,
  ComponentPropertyValue,
  NodeVariables,
  Transform2x3,
} from './types';

// Shared "raw evidence" readers. Both the Elementor extractor (ExtractedNode)
// and the canonical graph (canonical-graph.json) call these, so the two views
// of the same Figma node can never disagree about transforms, masks,
// component metadata or variable bindings.

// --- Transform math (pure) -----------------------------------------------

type M = ReadonlyArray<ReadonlyArray<number>>;

export function toTransform(m: M | undefined | null): Transform2x3 | undefined {
  if (!m || m.length < 2 || m[0].length < 3 || m[1].length < 3) return undefined;
  return [
    [round6(m[0][0]), round6(m[0][1]), round6(m[0][2])],
    [round6(m[1][0]), round6(m[1][1]), round6(m[1][2])],
  ];
}

// Inverse of a 2x3 affine matrix, or null when singular.
export function invertTransform(m: M): Transform2x3 | null {
  const [a, c, tx] = m[0];
  const [b, d, ty] = m[1];
  const det = a * d - b * c;
  if (!isFinite(det) || Math.abs(det) < 1e-12) return null;
  const ia = d / det;
  const ic = -c / det;
  const ib = -b / det;
  const id = a / det;
  return [
    [ia, ic, -(ia * tx + ic * ty)],
    [ib, id, -(ib * tx + id * ty)],
  ];
}

// a × b  (apply b first, then a) for 2x3 affine matrices.
export function multiplyTransform(a: M, b: M): Transform2x3 {
  return [
    [
      a[0][0] * b[0][0] + a[0][1] * b[1][0],
      a[0][0] * b[0][1] + a[0][1] * b[1][1],
      a[0][0] * b[0][2] + a[0][1] * b[1][2] + a[0][2],
    ],
    [
      a[1][0] * b[0][0] + a[1][1] * b[1][0],
      a[1][0] * b[0][1] + a[1][1] * b[1][1],
      a[1][0] * b[0][2] + a[1][1] * b[1][2] + a[1][2],
    ],
  ];
}

// inverse(parent.absoluteTransform) × child.absoluteTransform.
export function relativeFromAbsolute(parentAbs: M, childAbs: M): Transform2x3 | undefined {
  const inv = invertTransform(parentAbs);
  if (!inv) return undefined;
  return toTransform(multiplyTransform(inv, childAbs));
}

function round6(v: number): number {
  return Math.round(v * 1e6) / 1e6;
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

// --- Geometry ------------------------------------------------------------

export type TransformEvidence = {
  absoluteTransform?: Transform2x3;
  relativeTransform?: Transform2x3;
};

export function readTransforms(node: SceneNode): TransformEvidence {
  const out: TransformEvidence = {};
  const abs = (node as { absoluteTransform?: M }).absoluteTransform;
  out.absoluteTransform = toTransform(abs);
  const parent = node.parent as (BaseNode & { absoluteTransform?: M }) | null;
  const parentAbs = parent && 'absoluteTransform' in parent ? parent.absoluteTransform : undefined;
  if (abs && parentAbs) {
    out.relativeTransform = relativeFromAbsolute(parentAbs, abs);
  }
  if (!out.relativeTransform) {
    // Page-level nodes (no transformed parent): Figma's own relativeTransform
    // is already relative to the canvas.
    out.relativeTransform = toTransform((node as { relativeTransform?: M }).relativeTransform);
  }
  return out;
}

function boundsOf(b: { x: number; y: number; width: number; height: number } | null | undefined): Bounds | undefined {
  if (!b) return undefined;
  return { x: round2(b.x), y: round2(b.y), width: round2(b.width), height: round2(b.height) };
}

export function readRenderBounds(node: SceneNode): { renderBounds?: Bounds; extendsBeyondBounds: boolean } {
  const box = 'absoluteBoundingBox' in node ? node.absoluteBoundingBox : null;
  const render = 'absoluteRenderBounds' in node ? node.absoluteRenderBounds : null;
  const renderBounds = boundsOf(render);
  if (!renderBounds || !box) return { renderBounds, extendsBeyondBounds: false };
  const tol = 0.5;
  const extendsBeyondBounds =
    renderBounds.x < box.x - tol ||
    renderBounds.y < box.y - tol ||
    renderBounds.x + renderBounds.width > box.x + box.width + tol ||
    renderBounds.y + renderBounds.height > box.y + box.height + tol;
  return { renderBounds, extendsBeyondBounds };
}

// A node is effectively visible only if it and every ancestor is visible.
export function isEffectivelyVisible(node: BaseNode): boolean {
  let cur: BaseNode | null = node;
  while (cur && cur.type !== 'PAGE' && cur.type !== 'DOCUMENT') {
    if ('visible' in cur && cur.visible === false) return false;
    cur = cur.parent;
  }
  return true;
}

export type MaskEvidence = {
  isMask?: boolean;
  maskType?: 'ALPHA' | 'VECTOR' | 'LUMINANCE';
  clipsContent?: boolean;
};

export function readMask(node: SceneNode): MaskEvidence {
  const out: MaskEvidence = {};
  const n = node as unknown as { isMask?: boolean; maskType?: MaskEvidence['maskType']; clipsContent?: boolean };
  if (n.isMask === true) {
    out.isMask = true;
    // Older API surfaces only isMask (implicitly an alpha/vector mask).
    out.maskType = n.maskType ?? 'ALPHA';
  }
  if (typeof n.clipsContent === 'boolean') out.clipsContent = n.clipsContent;
  return out;
}

// --- Component metadata --------------------------------------------------

export async function readComponentMeta(node: SceneNode): Promise<ComponentMeta | undefined> {
  const meta: ComponentMeta = {};
  let component: ComponentNode | null = null;

  if (node.type === 'INSTANCE') {
    try {
      component = await node.getMainComponentAsync();
    } catch { /* detached / inaccessible */ }
    if (component) {
      meta.mainComponentId = component.id;
      meta.mainComponentName = component.name;
      meta.mainComponentKey = component.key;
      meta.mainComponentRemote = component.remote;
    }
    const props = (node as { componentProperties?: Record<string, ComponentPropertyValue> }).componentProperties;
    if (props) meta.componentProperties = cloneJson(props);
  } else if (node.type === 'COMPONENT') {
    component = node;
    meta.mainComponentId = node.id;
    meta.mainComponentName = node.name;
    meta.mainComponentKey = node.key;
  }

  if (component) {
    const set = component.parent && component.parent.type === 'COMPONENT_SET' ? component.parent : null;
    if (set) {
      meta.componentSetId = set.id;
      meta.componentSetName = set.name;
    }
    const vp = (component as { variantProperties?: Record<string, string> | null }).variantProperties;
    if (vp) meta.variantProperties = { ...vp };
  }

  // Definitions live on the component set, or on a standalone component.
  // Reading them on a variant (a COMPONENT inside a set) throws.
  const defHolder: ComponentSetNode | ComponentNode | null =
    node.type === 'COMPONENT_SET' ? node
    : node.type === 'COMPONENT' && (!node.parent || node.parent.type !== 'COMPONENT_SET') ? node
    : (component && component.parent && component.parent.type === 'COMPONENT_SET'
        ? (component.parent as ComponentSetNode)
        : component && (!component.parent || component.parent.type !== 'COMPONENT_SET') ? component : null);
  if (defHolder) {
    try {
      const defs = (defHolder as { componentPropertyDefinitions?: Record<string, unknown> }).componentPropertyDefinitions;
      if (defs) meta.componentPropertyDefinitions = cloneJson(defs) as ComponentMeta['componentPropertyDefinitions'];
    } catch { /* variant component */ }
  }

  const refs = (node as { componentPropertyReferences?: Record<string, string> | null }).componentPropertyReferences;
  if (refs && Object.keys(refs).length > 0) meta.componentPropertyReferences = { ...refs };

  return Object.keys(meta).length > 0 ? meta : undefined;
}

// --- Variables -----------------------------------------------------------

export function readNodeVariables(node: SceneNode): NodeVariables | undefined {
  const out: NodeVariables = {};
  const n = node as unknown as {
    boundVariables?: Record<string, unknown>;
    explicitVariableModes?: Record<string, string>;
    resolvedVariableModes?: Record<string, string>;
  };
  if (n.boundVariables && Object.keys(n.boundVariables).length > 0) {
    out.boundVariables = cloneJson(n.boundVariables);
  }
  if (n.explicitVariableModes && Object.keys(n.explicitVariableModes).length > 0) {
    out.explicitVariableModes = { ...n.explicitVariableModes };
  }
  if (n.resolvedVariableModes && Object.keys(n.resolvedVariableModes).length > 0) {
    out.resolvedVariableModes = { ...n.resolvedVariableModes };
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

// Figma returns live proxy objects for several of these; round-trip through
// JSON so the postMessage payload is plain data.
function cloneJson<T>(v: T): T {
  try {
    return JSON.parse(JSON.stringify(v)) as T;
  } catch {
    return v;
  }
}

import type {
  BreakpointName,
  ExtractedNode,
  LayoutInfo,
  Padding,
  ResponsiveDelta,
} from './types';

// Pairs "Homepage Desktop" / "Homepage Tablet" / "Homepage Mobile" frames
// into ONE page: the desktop tree stays the source of truth and each node
// gains `responsive.{tablet,mobile}` deltas. The mapper turns those into
// Elementor `_tablet` / `_mobile` settings instead of three separate pages.

type FrameClass = 'desktop' | 'tablet' | 'mobile';

const TOKEN_RX = /(^|[\s\-_/|.()[\]:])(desktop|web|laptop|tablet|ipad|mobile|phone|iphone)(?=$|[\s\-_/|.()[\]:])/i;

export function classifyFrameName(name: string): { cls: FrameClass; stem: string } | null {
  const m = name.match(TOKEN_RX);
  if (!m) return null;
  const token = m[2].toLowerCase();
  const cls: FrameClass =
    token === 'tablet' || token === 'ipad' ? 'tablet'
    : token === 'mobile' || token === 'phone' || token === 'iphone' ? 'mobile'
    : 'desktop';
  const stem = name
    .replace(TOKEN_RX, ' ')
    .replace(/\(?\b\d{3,4}\s*(px)?\)?/gi, ' ')   // "1440", "(375px)"
    .replace(/[\s\-_/|.:]+/g, ' ')
    .trim()
    .toLowerCase();
  return { cls, stem };
}

export type BreakpointPair = {
  stem: string;
  desktopId: string;
  tablet?: string;
  mobile?: string;
};

export type FoldResult = {
  // Trees to map. Paired tablet/mobile frames are folded into the desktop
  // tree and removed; unpaired frames pass through untouched.
  trees: ExtractedNode[];
  pairs: BreakpointPair[];
};

export function foldBreakpointFrames(trees: ExtractedNode[]): FoldResult {
  const groups = new Map<string, { desktop?: ExtractedNode; tablet?: ExtractedNode; mobile?: ExtractedNode }>();
  for (const t of trees) {
    const c = classifyFrameName(t.name);
    if (!c) continue;
    const g = groups.get(c.stem) ?? {};
    // First frame of a class wins; duplicates stay unpaired.
    if (!g[c.cls]) g[c.cls] = t;
    groups.set(c.stem, g);
  }

  const folded = new Set<ExtractedNode>();
  const pairs: BreakpointPair[] = [];
  for (const [stem, g] of groups) {
    if (!g.desktop) continue;
    const { desktop, tablet, mobile } = g;
    // Sanity: a "mobile" frame wider than its desktop is mislabeled.
    const okTablet = tablet && tablet.width < desktop.width;
    const okMobile = mobile && mobile.width < desktop.width;
    if (!okTablet && !okMobile) continue;
    const paired: BreakpointName[] = [];
    if (okTablet) {
      pairNodes(desktop, tablet!, 'tablet', true);
      folded.add(tablet!);
      paired.push('tablet');
    }
    if (okMobile) {
      pairNodes(desktop, mobile!, 'mobile', true);
      folded.add(mobile!);
      paired.push('mobile');
    }
    desktop.pairedBreakpoints = paired;
    pairs.push({ stem, desktopId: desktop.id, tablet: okTablet ? tablet!.id : undefined, mobile: okMobile ? mobile!.id : undefined });
  }
  return { trees: trees.filter((t) => !folded.has(t)), pairs };
}

function normName(n: string): string {
  return n.toLowerCase().replace(/[\s\-_]*\d+$/, '').replace(/\s+/g, ' ').trim();
}

function roleOf(n: ExtractedNode): string {
  return n.semanticRole ?? n.role;
}

// Match children of two corresponding nodes. Same count + same roles → by
// index (the overwhelmingly common "same design, reflowed" case). Otherwise
// fall back to unique-name matching; anything ambiguous stays unpaired.
export function matchChildren(d: ExtractedNode, m: ExtractedNode): Array<[ExtractedNode, ExtractedNode]> {
  const dc = d.children;
  const mc = m.children;
  if (dc.length === mc.length && dc.every((c, i) => roleOf(c) === roleOf(mc[i]))) {
    return dc.map((c, i) => [c, mc[i]] as [ExtractedNode, ExtractedNode]);
  }
  const out: Array<[ExtractedNode, ExtractedNode]> = [];
  const used = new Set<ExtractedNode>();
  for (const c of dc) {
    const key = normName(c.name);
    if (!key) continue;
    const candidates = mc.filter((x) => !used.has(x) && normName(x.name) === key && roleOf(x) === roleOf(c));
    const sameInDesktop = dc.filter((x) => normName(x.name) === key).length;
    if (candidates.length === 1 && sameInDesktop === 1) {
      used.add(candidates[0]);
      out.push([c, candidates[0]]);
    }
  }
  return out;
}

function effectiveLayout(n: ExtractedNode): LayoutInfo {
  return n.layout.mode === 'NONE' && n.inferredLayout ? n.inferredLayout : n.layout;
}

function samePadding(a?: Padding, b?: Padding): boolean {
  const z: Padding = { top: 0, right: 0, bottom: 0, left: 0 };
  const x = a ?? z;
  const y = b ?? z;
  return x.top === y.top && x.right === y.right && x.bottom === y.bottom && x.left === y.left;
}

function sameLH(a: ResponsiveDelta['lineHeight'] | null | undefined, b: ResponsiveDelta['lineHeight'] | null | undefined): boolean {
  if (a === b) return true;
  if (!a || !b || a === 'AUTO' || b === 'AUTO') return false;
  return a.unit === b.unit && Math.abs(a.value - b.value) < 0.01;
}

export function diffNode(d: ExtractedNode, m: ExtractedNode, isRoot: boolean): ResponsiveDelta | undefined {
  const delta: ResponsiveDelta = {};
  const dl = effectiveLayout(d);
  const ml = effectiveLayout(m);

  const dFlex = dl.mode === 'HORIZONTAL' || dl.mode === 'VERTICAL';
  const mFlex = ml.mode === 'HORIZONTAL' || ml.mode === 'VERTICAL';
  if (dFlex && mFlex) {
    if (dl.mode !== ml.mode) delta.layoutMode = ml.mode as 'HORIZONTAL' | 'VERTICAL';
    if ((dl.itemSpacing ?? 0) !== (ml.itemSpacing ?? 0)) delta.itemSpacing = ml.itemSpacing ?? 0;
    if (!samePadding(dl.padding, ml.padding)) delta.padding = ml.padding ?? { top: 0, right: 0, bottom: 0, left: 0 };
    if (dl.primaryAlign !== ml.primaryAlign && ml.primaryAlign) delta.primaryAlign = ml.primaryAlign;
    if (dl.counterAlign !== ml.counterAlign && ml.counterAlign) delta.counterAlign = ml.counterAlign;
    if (!!dl.wrap !== !!ml.wrap) delta.wrap = !!ml.wrap;
  }

  if (!isRoot) {
    const mFill = m.layout.sizingHorizontal === 'FILL';
    const dFill = d.layout.sizingHorizontal === 'FILL';
    if (mFill && !dFill) delta.width = 'FILL';
    else if (!mFill && !dFill && d.layout.sizingHorizontal !== 'HUG' && m.layout.sizingHorizontal !== 'HUG' &&
             Math.abs(d.width - m.width) > 1 && d.children.length > 0) {
      delta.width = Math.round(m.width);
    }
  }

  const dt = d.text;
  const mt = m.text;
  if (dt && mt) {
    if (dt.fontSize && mt.fontSize && dt.fontSize !== mt.fontSize) delta.fontSize = mt.fontSize;
    if (!sameLH(dt.lineHeight, mt.lineHeight) && mt.lineHeight) delta.lineHeight = mt.lineHeight;
    const dls = dt.letterSpacing?.value ?? 0;
    const mls = mt.letterSpacing?.value ?? 0;
    if (Math.abs(dls - mls) > 0.01 && mt.letterSpacing) delta.letterSpacing = mt.letterSpacing;
    if (dt.align && mt.align && dt.align !== mt.align) delta.align = mt.align;
  }
  return Object.keys(delta).length > 0 ? delta : undefined;
}

export function pairNodes(d: ExtractedNode, m: ExtractedNode, bp: BreakpointName, isRoot = false): void {
  const delta = diffNode(d, m, isRoot);
  if (delta) d.responsive = { ...(d.responsive ?? {}), [bp]: delta };
  for (const [dc, mc] of matchChildren(d, m)) pairNodes(dc, mc, bp, false);
}

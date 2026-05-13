import type {
  AILayout,
  AILayoutContent,
  AISection,
  AccessibilityMetadata,
  Asset,
  AssetManifestEntry,
  ComponentTemplate,
  ContentPriority,
  DesignTokens,
  ExtractedNode,
  IconHint,
  SectionPurpose,
  SemanticRole,
  ValidationReport,
  ValidationWarning,
} from './types';
import { inferResponsive } from './extractor';
import { brandColorHygieneWarnings } from './tokens';

// Summarises the extracted Figma tree into a compact, AI-friendly JSON
// document that downstream agents can reason about cheaply (Claude Code,
// etc.) without having to walk the full raw tree.

export function buildAILayout(
  roots: ExtractedNode[],
  title: string,
  rootFlattenedFrom?: string | null,
): AILayout {
  // Mutate trees with cross-tree metadata before summarising.
  for (const r of roots) {
    assignSectionPurpose(r, 0);
    assignContentPriority(r);
  }
  // Re-rank heading levels by relative size across the whole page so the
  // tallest text always becomes h1 even when the design uses comparatively
  // small headings (e.g. a 20pt H1 on a content-dense article). Without
  // this pass, the absolute-size heuristic in extractor.ts buckets every
  // small heading into h6.
  reassignHeadingLevels(roots);
  const sections = roots.map((r) => summarize(r, /*topLevel*/ true));
  const componentTemplates = collectComponentTemplates(roots);
  const layout: AILayout = {
    pageType: inferPageType(sections),
    title,
    sections,
  };
  if (rootFlattenedFrom) layout.rootFlattenedFrom = rootFlattenedFrom;
  if (componentTemplates.length > 0) layout.componentTemplates = componentTemplates;
  return layout;
}

// Walk all trees and bucket nodes by their `instanceGroup` id (assigned in
// extractor.assignInstanceGroups). Each bucket becomes one ComponentTemplate
// the agent can fold into a single Elementor template instead of diffing
// per-node fingerprints itself.
function collectComponentTemplates(roots: ExtractedNode[]): ComponentTemplate[] {
  const groups = new Map<string, { fingerprint: string; role: SemanticRole; nodeIds: string[] }>();
  function walk(n: ExtractedNode) {
    if (n.instanceGroup && n.componentFingerprint) {
      const existing = groups.get(n.instanceGroup);
      if (existing) {
        existing.nodeIds.push(n.id);
      } else {
        groups.set(n.instanceGroup, {
          fingerprint: n.componentFingerprint,
          role: n.semanticRole ?? 'unknown',
          nodeIds: [n.id],
        });
      }
    }
    for (const c of n.children) walk(c);
  }
  for (const r of roots) walk(r);
  const out: ComponentTemplate[] = [];
  groups.forEach((g, groupId) => {
    out.push({
      groupId,
      fingerprint: g.fingerprint,
      role: g.role,
      count: g.nodeIds.length,
      nodeIds: g.nodeIds,
    });
  });
  return out;
}

function summarize(node: ExtractedNode, topLevel = false): AISection {
  const role = node.semanticRole ?? 'unknown';
  const responsive = inferResponsive(node);
  const layout = describeLayout(node);

  // Decide what content to roll up. For leaf-ish/semantic groups (hero,
  // card, navbar) we extract heading/paragraph/buttons. For complex
  // sections we recurse into children.
  const content = extractContent(node);

  // Recurse into structural children that themselves carry semantic meaning.
  const children = node.children
    .filter((c) => isStructural(c))
    .map((c) => summarize(c, false));

  const out: AISection = {
    id: node.id,
    role,
    name: node.name,
    layout,
    bounds: node.absoluteBounds,
    style: node.style,
    confidence: node.confidence,
    reason: node.roleReason,
  };
  if (responsive) out.responsive = responsive;
  if (node.layoutPattern) out.layoutPattern = node.layoutPattern;
  if (node.breakpoints) out.breakpoints = node.breakpoints;
  if (node.sectionPurpose) out.sectionPurpose = node.sectionPurpose;
  if (node.sectionPurposeSource) out.sectionPurposeSource = node.sectionPurposeSource;
  if (node.contentPriority) out.contentPriority = node.contentPriority;
  if (node.importance) out.importance = node.importance;
  if (node.isDecorative) out.isDecorative = true;
  if (node.preferredWidget) out.preferredWidget = node.preferredWidget;
  if (node.widgetHint) out.widgetHint = node.widgetHint;
  if (node.widgetHintSource) out.widgetHintSource = node.widgetHintSource;
  if (node.counterHint) out.counterHint = node.counterHint;
  // Only emit per-node fingerprints when the node belongs to an instance
  // group — for grouped nodes the agent reads the canonical descriptor
  // from layout.componentTemplates. Ungrouped nodes have nothing to match
  // against, and the recursive long-form fingerprint can be kilobyte-class
  // on deep trees, so we drop it.
  if (node.instanceGroup) {
    out.instanceGroup = node.instanceGroup;
    if (node.componentFingerprint) out.componentFingerprint = node.componentFingerprint;
  }
  if (node.componentId) out.componentId = node.componentId;
  if (node.states) out.states = node.states;
  if (node.inputMetadata) out.inputMetadata = node.inputMetadata;
  const a11y = buildAccessibility(node);
  if (a11y) out.accessibility = a11y;
  if (content && Object.keys(content).length > 0) out.content = content;
  if (children.length > 0) out.children = children;
  return out;
}

function buildAccessibility(node: ExtractedNode): AccessibilityMetadata | undefined {
  const a: AccessibilityMetadata = {};
  if (node.ariaRole) a.ariaRole = node.ariaRole;
  if (node.headingLevel) a.headingLevel = node.headingLevel;
  if (node.altText) a.altText = node.altText;
  if (node.isDecorative) a.decorative = true;
  return Object.keys(a).length > 0 ? a : undefined;
}

function describeLayout(node: ExtractedNode): AISection['layout'] {
  if (node.layout.mode === 'GRID') return 'grid';
  if (node.layout.mode === 'NONE') return 'absolute';
  const childCount = node.children.length;
  if (node.layout.mode === 'HORIZONTAL') {
    if (childCount === 2) return 'two-column';
    if (childCount === 3) return 'three-column';
    if (childCount === 4) return 'four-column';
    return `${childCount}-column`;
  }
  return 'stack';
}

const STRUCTURAL_ROLES: SemanticRole[] = [
  'section', 'hero', 'navbar', 'footer', 'card', 'pricing-card',
  'testimonial', 'form', 'menu', 'accordion', 'slider', 'grid', 'container',
];

function isStructural(node: ExtractedNode): boolean {
  if (!node.semanticRole) return false;
  return STRUCTURAL_ROLES.indexOf(node.semanticRole) !== -1;
}

function extractContent(node: ExtractedNode): AILayoutContent | undefined {
  const texts = collectTexts(node);
  const buttons = collectButtons(node);
  const image = collectFirstImage(node);

  if (texts.length === 0 && buttons.length === 0 && !image) return undefined;

  const content: AILayoutContent = {};
  // largest text → heading, second largest → subheading, rest → paragraph
  const sorted = texts.slice().sort((a, b) => (b.size ?? 0) - (a.size ?? 0));
  if (sorted[0]) content.heading = sorted[0].text;
  if (sorted[1] && sorted[1].size && sorted[0].size && sorted[1].size < sorted[0].size) {
    content.subheading = sorted[1].text;
  }
  const paragraphTexts = sorted.slice(content.subheading ? 2 : 1).map((t) => t.text);
  if (paragraphTexts.length) content.paragraph = paragraphTexts.join(' ');
  if (buttons.length) content.buttons = buttons;
  if (image) content.image = image;
  return content;
}

function collectTexts(node: ExtractedNode): { text: string; size: number | null }[] {
  const out: { text: string; size: number | null }[] = [];
  function walk(n: ExtractedNode) {
    if (n.semanticRole === 'button') return; // button text handled separately
    if (n.text && n.text.characters) {
      out.push({ text: n.text.characters.trim(), size: n.text.fontSize });
    }
    for (const c of n.children) walk(c);
  }
  // Walk children; don't include the node itself when it is text — we want
  // the section's own headings, not duplicate node-level text.
  for (const c of node.children) walk(c);
  return out.filter((t) => t.text.length > 0);
}

function collectButtons(node: ExtractedNode): { text: string; style?: string }[] {
  const out: { text: string; style?: string }[] = [];
  function walk(n: ExtractedNode) {
    if (n.semanticRole === 'button') {
      const text = findButtonLabel(n);
      const style = n.fills.some((f) => f.type === 'SOLID') ? 'primary' : 'secondary';
      out.push(text ? { text, style } : { text: n.name, style });
      return;
    }
    for (const c of n.children) walk(c);
  }
  for (const c of node.children) walk(c);
  return out;
}

function findButtonLabel(node: ExtractedNode): string | null {
  if (node.text) return node.text.characters;
  for (const c of node.children) {
    const t = findButtonLabel(c);
    if (t) return t;
  }
  return null;
}

function collectFirstImage(node: ExtractedNode): string | undefined {
  function walk(n: ExtractedNode): string | undefined {
    if ((n.semanticRole === 'image' || n.role === 'image') && n.assetId) {
      return n.assetId;
    }
    for (const c of n.children) {
      const r = walk(c);
      if (r) return r;
    }
    return undefined;
  }
  for (const c of node.children) {
    const r = walk(c);
    if (r) return r;
  }
  return undefined;
}

function inferPageType(sections: AISection[]): string {
  const purposes = sections.map((s) => s.sectionPurpose).filter(Boolean) as SectionPurpose[];
  const roles = sections.map((s) => s.role);
  if (purposes.indexOf('hero') !== -1) return 'landing-page';
  // A page that has many distinct section purposes (hero + features +
  // testimonials + cta…) is a landing page even when one of those is
  // pricing or a form. Only narrow page-type labels win when the page
  // is genuinely a single-purpose layout.
  const distinctPurposes = new Set(purposes);
  const looksLikeLanding = distinctPurposes.size >= 3;
  if (looksLikeLanding) return 'landing-page';
  if (purposes.indexOf('pricing') !== -1 || roles.indexOf('pricing-card') !== -1) return 'pricing-page';
  if (purposes.indexOf('lead-capture') !== -1 || roles.indexOf('form') !== -1) return 'form-page';
  if (purposes.indexOf('faq') !== -1) return 'faq-page';
  if (purposes.indexOf('blog-grid') !== -1) return 'blog-listing';
  // Either-or for web-page — many designs have a header without a footer
  // (or vice versa) and still are clearly multi-section marketing pages.
  if (roles.indexOf('navbar') !== -1 || roles.indexOf('footer') !== -1) return 'web-page';
  return 'page';
}

// --- Section-purpose detection ------------------------------------------

const PURPOSE_RX = {
  faq: /\b(faq|q&a|questions?)\b/i,
  cta: /\b(cta|call[-_ ]?to[-_ ]?action|get[-_ ]?started|sign[-_ ]?up)\b/i,
  socialProof: /\b(social[-_ ]?proof|trusted[-_ ]?by|partners?|clients?|brands?|press|featured[-_ ]?in)\b/i,
  trust: /\b(secure|guarantee|trust|certified|verified|badge)\b/i,
  // Narrower row-of-logos pattern: "logos", "client logos", "logo strip",
  // "as seen in", "as featured in", "press" without other content.
  trustRow: /\b(logo[s]?[-_ ]?(strip|row|grid|cloud)?|as[-_ ]?(seen|featured)[-_ ]?in)\b/i,
  // Stats section — counters of customers/numbers/results.
  stats: /\b(stats|statistics|by[-_ ]the[-_ ]numbers|metrics|numbers|results)\b/i,
  leadCapture: /\b(newsletter|subscribe|lead|signup|sign[-_ ]?up|contact[-_ ]?us|capture)\b/i,
  comparison: /\b(compare|comparison|vs\.?)\b/i,
  gallery: /\b(gallery|portfolio|showcase|images)\b/i,
  pricing: /\b(pricing|plans?|tier|subscription)\b/i,
  blog: /\b(blog|posts?|articles?|news|stories|insights?)\b/i,
  // "header" appears in names that mean the top page strip without a nav
  // (e.g. "PageHeader", "Header / Title"). The classifier emits navbar when
  // a real navigation is detected; we pick this up as a fallback.
  header: /\b(page[-_ ]?header|site[-_ ]?header|top[-_ ]?bar)\b/i,
};

// Text-content signals that indicate a blog/post grid rather than a
// feature grid: dates, author bylines, "read more" CTAs, reading time.
const BLOG_TEXT_RX = {
  // Mar 12, 2024 / 2024-03-12 / 12 March 2024
  date: /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2},?\s+\d{4}\b|\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d{4}\b/i,
  byline: /\bby\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?\b/,
  readMore: /\b(read\s+more|continue\s+reading|learn\s+more|view\s+post)\b/i,
  readingTime: /\b\d+\s*min(ute)?s?\s+read\b/i,
};

type RoleCounts = {
  form: number;
  pricingCard: number;
  testimonial: number;
  accordion: number;
  card: number;
  button: number;
  text: number;
  image: number;
  logo: number;
  input: number;
};

function countDescendants(node: ExtractedNode): RoleCounts {
  const c: RoleCounts = {
    form: 0, pricingCard: 0, testimonial: 0, accordion: 0,
    card: 0, button: 0, text: 0, image: 0, logo: 0, input: 0,
  };
  function visit(n: ExtractedNode) {
    switch (n.semanticRole) {
      case 'form': c.form += 1; break;
      case 'pricing-card': c.pricingCard += 1; break;
      case 'testimonial': c.testimonial += 1; break;
      case 'accordion': c.accordion += 1; break;
      case 'card': c.card += 1; break;
      case 'button': c.button += 1; break;
      case 'text': c.text += 1; break;
      case 'image': c.image += 1; break;
      case 'logo': c.logo += 1; break;
      case 'input': c.input += 1; break;
      default: break;
    }
    for (const child of n.children) visit(child);
  }
  for (const ch of node.children) visit(ch);
  return c;
}

export function detectSectionPurpose(node: ExtractedNode): SectionPurpose {
  const role = node.semanticRole;
  if (role === 'hero') return 'hero';
  if (role === 'navbar') return 'navbar';
  if (role === 'footer') return 'footer';

  const name = node.name.toLowerCase();
  const counts = countDescendants(node);

  // Structural header detection — top of page, short and wide, with a
  // logo plus button/menu content. Catches "Header" frames that didn't
  // match the navbar regex but clearly are the page's top strip.
  if (looksLikeStructuralHeader(node, counts)) return 'header';

  // Trust row / logo strip first — narrower than social-proof so it wins
  // when both signals fire. Requires either an explicit name or a row
  // shape (≥3 logos, no testimonials, no buttons).
  if (PURPOSE_RX.trustRow.test(name) || (counts.logo >= 3 && counts.text === 0 && counts.button === 0)) {
    return 'trust-row';
  }
  // Stats / counter section — detected on counter presence in descendants
  // or an explicit "stats / by the numbers" name.
  if (PURPOSE_RX.stats.test(name) || hasCounters(node)) {
    return 'stats';
  }
  // Form-driven intents take priority over name signals.
  if (counts.form > 0 || counts.input >= 2 || PURPOSE_RX.leadCapture.test(name)) {
    return 'lead-capture';
  }
  if (counts.pricingCard > 0 || PURPOSE_RX.pricing.test(name)) return 'pricing';
  if (counts.testimonial > 0) return 'testimonial';
  if (counts.accordion >= 2 || PURPOSE_RX.faq.test(name)) return 'faq';
  if (PURPOSE_RX.comparison.test(name)) return 'feature-comparison';
  if (PURPOSE_RX.socialProof.test(name) || (counts.logo >= 3 && counts.text <= 2)) return 'social-proof';
  if (PURPOSE_RX.trust.test(name)) return 'trust';
  if (PURPOSE_RX.header.test(name)) return 'header';
  if (PURPOSE_RX.gallery.test(name) || (counts.image >= 4 && counts.text <= 2)) return 'gallery';
  if (PURPOSE_RX.cta.test(name) || (counts.button >= 1 && counts.text <= 3 && counts.card === 0)) return 'cta';
  if (counts.card >= 3) {
    if (looksLikeBlogGrid(node, name)) return 'blog-grid';
    return 'feature-grid';
  }
  return 'content';
}

// A short, wide, page-top frame containing a logo and some buttons or
// menu items, but no big hero copy. Distinguishes a header strip from a
// hero — heroes typically have a large heading and span the viewport.
function looksLikeStructuralHeader(node: ExtractedNode, counts: RoleCounts): boolean {
  if (node.depth !== undefined && node.depth > 1) return false;
  if (!node.absoluteBounds) return false;
  const bounds = node.absoluteBounds;
  // Short relative to width; sitting near the top of the page.
  const isShort = bounds.height <= 160;
  const isWide = bounds.width >= 768;
  if (!isShort || !isWide) return false;
  // Must contain a logo OR a menu-like cluster.
  const hasLogoLike = counts.logo >= 1 || counts.image >= 1;
  if (!hasLogoLike) return false;
  // Should not contain hero-sized headings (would be a hero instead).
  if (hasHeadingLargerThan(node, 28)) return false;
  // Must have either nav children (button / text label rows) — pure-image
  // strips are trust rows, not headers.
  if (counts.button === 0 && counts.text < 2) return false;
  return true;
}

function hasHeadingLargerThan(node: ExtractedNode, threshold: number): boolean {
  let found = false;
  function walk(n: ExtractedNode) {
    if (found) return;
    if (n.text && (n.text.fontSize ?? 0) >= threshold) { found = true; return; }
    for (const c of n.children) walk(c);
  }
  for (const c of node.children) walk(c);
  return found;
}

// True when the section contains at least one parsed counter (numeric
// heading flagged by extractor.detectAndStampCounters).
function hasCounters(node: ExtractedNode): boolean {
  let found = false;
  function walk(n: ExtractedNode) {
    if (found) return;
    if (n.widgetHint === 'counter' && n.counterHint) {
      found = true;
      return;
    }
    for (const c of n.children) walk(c);
  }
  for (const c of node.children) walk(c);
  return found;
}

// Inspect the descendants' text content for blog-grid signals: at least
// two of {date, author byline, read-more, reading-time} across cards, or
// an explicit blog/posts name on the section.
function looksLikeBlogGrid(node: ExtractedNode, name: string): boolean {
  if (PURPOSE_RX.blog.test(name)) return true;
  let signals = 0;
  let hasDate = false;
  function walk(n: ExtractedNode) {
    if (n.text && n.text.characters) {
      const s = n.text.characters;
      if (BLOG_TEXT_RX.date.test(s)) { if (!hasDate) signals += 1; hasDate = true; }
      if (BLOG_TEXT_RX.byline.test(s)) signals += 1;
      if (BLOG_TEXT_RX.readMore.test(s)) signals += 1;
      if (BLOG_TEXT_RX.readingTime.test(s)) signals += 1;
    }
    for (const c of n.children) walk(c);
  }
  walk(node);
  return signals >= 2;
}

const SECTION_LIKE: SemanticRole[] = ['section', 'hero', 'navbar', 'footer'];
// Roles a Figma node might land in while still being a routable page section
// — the most common case is a generic 'container' that classifySemantic
// couldn't pin down by name. We still want sectionPurpose on these so the
// downstream router has page-level intent for every top-level chunk.
const STRUCTURAL_LIKE: SemanticRole[] = [
  'section', 'hero', 'navbar', 'footer', 'container',
  'accordion', 'slider', 'tabs', 'grid', 'form',
];

function assignSectionPurpose(node: ExtractedNode, depth: number): void {
  const role = node.semanticRole;
  // Always stamp top-level. Beyond that, also stamp structural containers
  // up to two levels deep so an artificial wrapper (single-root case)
  // doesn't strip purpose from its real sections, and a wrapper inside a
  // wrapper still gets its sections tagged.
  const isStructural = !!role && STRUCTURAL_LIKE.indexOf(role) !== -1;
  const isClassicSection = !!role && SECTION_LIKE.indexOf(role) !== -1;
  const shouldStamp = depth === 0 || isClassicSection || (isStructural && depth <= 2);
  // User overrides win — never overwrite a developer-authored tag, and
  // never overwrite an auto-tag stamped earlier in extractor (logo-strip).
  const alreadyTagged = !!node.sectionPurpose;
  if (shouldStamp && !alreadyTagged) {
    node.sectionPurpose = detectSectionPurpose(node);
    if (!node.sectionPurposeSource) node.sectionPurposeSource = 'auto';
  }
  for (const c of node.children) {
    assignSectionPurpose(c, depth + 1);
  }
}

// --- Content priority ---------------------------------------------------

function assignContentPriority(section: ExtractedNode): void {
  const sizes: number[] = [];
  function collect(n: ExtractedNode) {
    if (n.text && n.text.fontSize) sizes.push(n.text.fontSize);
    for (const c of n.children) collect(c);
  }
  collect(section);
  const sorted = sizes.slice().sort((a, b) => b - a);
  const primary = sorted[0] ?? 0;
  const secondary = sorted.find((s) => s < primary * 0.85) ?? primary * 0.7;

  function visit(n: ExtractedNode) {
    let p: ContentPriority | undefined;
    if (n.text && n.text.fontSize) {
      const fs = n.text.fontSize;
      if (primary > 0 && fs >= primary * 0.9) p = 'primary';
      else if (fs >= secondary * 0.85) p = 'secondary';
      else p = 'tertiary';
    } else if (n.semanticRole === 'button') {
      p = 'primary';
    } else if (n.isDecorative) {
      p = 'tertiary';
    } else if (n.semanticRole === 'image' || n.semanticRole === 'logo') {
      p = 'secondary';
    } else if (n.semanticRole === 'icon' || n.semanticRole === 'shape' || n.semanticRole === 'background-shape') {
      p = 'tertiary';
    }
    if (p) n.contentPriority = p;
    for (const c of n.children) visit(c);
  }
  visit(section);
}

// --- Asset manifest ------------------------------------------------------

export function buildAssetManifest(
  trees: ExtractedNode[],
  exportedAssets: Asset[],
): AssetManifestEntry[] {
  const entries: AssetManifestEntry[] = [];
  const used = new Map<string, ExtractedNode>();
  function walk(n: ExtractedNode) {
    if (n.assetId && !used.has(n.assetId)) used.set(n.assetId, n);
    for (const c of n.children) walk(c);
  }
  for (const t of trees) walk(t);

  for (const asset of exportedAssets) {
    const node = used.get(asset.id);
    const assetType = node?.assetType ?? asset.assetType ?? 'image';
    const isIconish = assetType === 'icon' || assetType === 'logo' || assetType === 'decoration';
    const iconHint = (isIconish && asset.format === 'svg') ? computeIconHint(asset.bytes) : undefined;
    entries.push({
      id: asset.id,
      filename: asset.filename,
      assetType,
      originalFormat: node?.originalFormat ?? asset.format,
      suggestedExportFormat: node?.suggestedExportFormat ?? asset.format,
      width: asset.width,
      height: asset.height,
      altText: node?.altText ?? node?.name,
      isDecorative: node?.isDecorative ?? false,
      nodeId: node?.id,
      iconHint,
      aliasIds: asset.aliasIds,
    });
  }
  return entries;
}

// Lightweight SVG path hash so downstream Claude can match against icon
// libraries (Lucide / FA / Tabler). We don't ship a dictionary in v1 —
// just expose enough signal for the agent to identify the icon.
function computeIconHint(bytes: Uint8Array): IconHint | undefined {
  const text = bytesToString(bytes);
  if (!text || text.indexOf('<svg') === -1) return undefined;
  const vbm = text.match(/viewBox\s*=\s*"([^"]+)"/);
  const viewBox = vbm ? vbm[1] : undefined;
  const paths: string[] = [];
  const re = /<path\b[^>]*\bd\s*=\s*"([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    paths.push(m[1].replace(/\s+/g, ' ').trim());
  }
  if (paths.length === 0) return undefined;
  const sorted = paths.slice().sort();
  const pathHash = djb2Hash(sorted.join('|'));
  const primaryPath = paths.reduce((a, b) => (a.length >= b.length ? a : b));
  const truncated = primaryPath.length > 256 ? primaryPath.slice(0, 256) + '…' : primaryPath;
  return {
    pathHash,
    pathCount: paths.length,
    viewBox,
    primaryPath: truncated,
  };
}

function djb2Hash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i += 1) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return 'h' + h.toString(36);
}

function bytesToString(b: Uint8Array): string {
  if (typeof TextDecoder !== 'undefined') {
    try { return new TextDecoder('utf-8').decode(b); } catch { /* fall through */ }
  }
  let s = '';
  for (let i = 0; i < b.length; i += 1) s += String.fromCharCode(b[i]);
  return s;
}

// --- Validation report ---------------------------------------------------

// Per-code cap on individual node warnings. After this many we replace the
// rest with a single rolled-up entry so validation.json stays scannable
// instead of degrading into a 3000-line firehose of "unnamed-layer" noise.
const WARNING_SAMPLE_CAP = 25;

const GENERIC_NAME_RX = /^(Frame|Group|Rectangle|Ellipse|Vector|Component|Instance|Path) ?\d*$/i;

export function buildValidationReport(
  trees: ExtractedNode[],
  tokens?: DesignTokens,
): ValidationReport {
  const raw: ValidationWarning[] = [];

  // Token-level warnings (brand color naming hygiene). Emitted first so
  // they land at the top of the report — the user can act on these
  // *before* re-running the extract.
  if (tokens) {
    for (const w of brandColorHygieneWarnings(tokens)) raw.push(w);
  }

  function walk(n: ExtractedNode) {
    // unnamed layers
    if (isDefaultName(n)) {
      raw.push({
        level: 'info',
        code: 'unnamed-layer',
        message: `Layer "${n.name}" uses the default name — consider renaming for clarity.`,
        nodeId: n.id,
        nodeName: n.name,
      });
    }
    // absolute-positioned layout
    if (n.layout.mode === 'NONE' && n.children.length > 0 && (n.semanticRole === 'section' || n.semanticRole === 'hero' || n.semanticRole === 'container')) {
      if (n.inferredLayout) {
        // We rescued the section: emit an info note so the user knows we
        // patched it, but don't flag it as a problem in Elementor.
        raw.push({
          level: 'info',
          code: 'inferred-auto-layout',
          message: `"${n.name}" had no auto-layout — inferred ${n.inferredLayout.mode.toLowerCase()} stack from child geometry.`,
          nodeId: n.id,
          nodeName: n.name,
        });
      } else {
        raw.push({
          level: 'warn',
          code: 'absolute-layout',
          message: `"${n.name}" has children but no auto-layout — children will be absolutely positioned, which is fragile in Elementor.`,
          nodeId: n.id,
          nodeName: n.name,
        });
      }
    }
    // mixed fonts in a section
    if (n.semanticRole === 'section' || n.semanticRole === 'hero') {
      const fonts = new Set<string>();
      collectFonts(n, fonts);
      if (fonts.size > 2) {
        raw.push({
          level: 'info',
          code: 'mixed-fonts',
          message: `Section "${n.name}" uses ${fonts.size} different font families.`,
          nodeId: n.id,
          nodeName: n.name,
        });
      }
    }
    // unsupported effects (background blur)
    if (n.effects) {
      for (const e of n.effects) {
        if (e.type === 'BACKGROUND_BLUR') {
          raw.push({
            level: 'warn',
            code: 'unsupported-effect',
            message: `"${n.name}" uses background-blur which is not natively supported by Elementor.`,
            nodeId: n.id,
            nodeName: n.name,
          });
        }
      }
    }
    // hidden layers (only flagged when explicitly traversed via includeHidden)
    if (n.visible === false) {
      raw.push({
        level: 'info',
        code: 'hidden-layer-skipped',
        message: `Hidden layer "${n.name}" was skipped during extraction.`,
        nodeId: n.id,
        nodeName: n.name,
      });
    }
    // large raster image
    if ((n.semanticRole === 'image' || n.role === 'image') && (n.width > 1600 || n.height > 1600)) {
      raw.push({
        level: 'warn',
        code: 'large-raster',
        message: `Image "${n.name}" is ${Math.round(n.width)}×${Math.round(n.height)} — consider downsizing.`,
        nodeId: n.id,
        nodeName: n.name,
      });
    }
    // low-confidence semantic role
    if (n.confidence !== undefined && n.confidence < 0.5 && n.semanticRole && n.semanticRole !== 'unknown') {
      raw.push({
        level: 'info',
        code: 'low-role-confidence',
        message: `Role "${n.semanticRole}" for "${n.name}" was assigned with low confidence (${n.confidence}).`,
        nodeId: n.id,
        nodeName: n.name,
      });
    }
    // missing alt text — image assets named with Figma defaults can't carry
    // useful alt copy. Surface as info so the agent knows to ask the user
    // (or generate alt from screenshot context) before publishing.
    if (n.assetId && (n.semanticRole === 'image' || n.semanticRole === 'logo' || n.role === 'image')) {
      if (!n.altText || GENERIC_NAME_RX.test(n.altText.trim())) {
        raw.push({
          level: 'info',
          code: 'missing-alt',
          message: `Image "${n.name}" has no descriptive alt text (uses the default Figma layer name).`,
          nodeId: n.id,
          nodeName: n.name,
        });
      }
    }
    // decorative-vector-cluster — the cluster collapse path stamps this
    // reason on the parent; surfacing it lets the agent decide whether to
    // keep, replace, or re-render the illustration server-side.
    if (n.roleReason && n.roleReason.indexOf('vector cluster') !== -1) {
      raw.push({
        level: 'info',
        code: 'decorative-vector-cluster',
        message: `"${n.name}" is a decorative vector cluster — flattened to a single image asset.`,
        nodeId: n.id,
        nodeName: n.name,
      });
    }
    // footer-baked-as-image — when a footer-role section has many image
    // assets but very few real text widgets, the designer probably exported
    // the whole footer as one big PNG. Flag so the agent can re-author the
    // links/columns or ask the user for source copy before publishing.
    if (n.semanticRole === 'footer') {
      const counts = countFooterChildren(n);
      const totalColumns = Math.max(1, counts.columnLike);
      const textPerColumn = counts.text / totalColumns;
      if (counts.image >= 1 && textPerColumn < 2 && counts.text < 6) {
        raw.push({
          level: 'warn',
          code: 'footer-baked-as-image',
          message: `Footer "${n.name}" looks rasterised (${counts.image} image(s), ${counts.text} text node(s)) — link text and columns may need to be re-authored.`,
          nodeId: n.id,
          nodeName: n.name,
        });
      }
    }

    for (const c of n.children) walk(c);
  }
  for (const t of trees) walk(t);

  const warnings = collapseRepeated(raw);
  const summary = { info: 0, warn: 0, error: 0 };
  for (const w of warnings) summary[w.level] += 1;

  return {
    generatedAt: new Date().toISOString(),
    warnings,
    summary,
  };
}

// Cap each warning code at WARNING_SAMPLE_CAP individual entries and roll
// the remainder into a single aggregate. Keeps validation.json useful
// when one issue (e.g. unnamed-layer) fires thousands of times.
function collapseRepeated(raw: ValidationWarning[]): ValidationWarning[] {
  const byCode = new Map<string, ValidationWarning[]>();
  for (const w of raw) {
    const arr = byCode.get(w.code);
    if (arr) arr.push(w);
    else byCode.set(w.code, [w]);
  }
  const out: ValidationWarning[] = [];
  for (const [code, arr] of byCode) {
    if (arr.length <= WARNING_SAMPLE_CAP) {
      for (const w of arr) out.push(w);
      continue;
    }
    for (let i = 0; i < WARNING_SAMPLE_CAP; i += 1) out.push(arr[i]);
    const remaining = arr.length - WARNING_SAMPLE_CAP;
    out.push({
      level: arr[0].level,
      code,
      message: `…and ${remaining} more node(s) with code "${code}" (truncated).`,
    });
  }
  return out;
}

function isDefaultName(n: ExtractedNode): boolean {
  const name = n.name;
  return /^(Frame|Group|Rectangle|Ellipse|Vector|Component|Instance) ?\d*$/i.test(name);
}

function collectFonts(n: ExtractedNode, out: Set<string>) {
  if (n.text?.fontFamily) out.add(n.text.fontFamily);
  for (const c of n.children) collectFonts(c, out);
}

// Walk every heading-flagged text node, gather their font sizes, then
// re-assign h1–h6 based on rank rather than fixed pixel thresholds. We
// only touch nodes that already had a headingLevel set in extractor.ts —
// non-heading body text is left untouched.
function reassignHeadingLevels(roots: ExtractedNode[]): void {
  const headings: ExtractedNode[] = [];
  function walk(n: ExtractedNode) {
    if (n.headingLevel && n.text?.fontSize) headings.push(n);
    for (const c of n.children) walk(c);
  }
  for (const r of roots) walk(r);
  if (headings.length === 0) return;

  const distinctSizes = Array.from(new Set(headings.map((h) => Math.round(h.text!.fontSize!)))).sort((a, b) => b - a);
  // Distinct-size buckets map to h1, h2, … in descending order; sizes past
  // h6 collapse to h6 (Elementor + WP don't ship deeper levels).
  const tiers: ('h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6')[] = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'];
  const sizeToLevel = new Map<number, typeof tiers[number]>();
  distinctSizes.forEach((size, i) => sizeToLevel.set(size, tiers[Math.min(i, tiers.length - 1)]));
  for (const h of headings) {
    const size = Math.round(h.text!.fontSize!);
    const level = sizeToLevel.get(size);
    if (level) h.headingLevel = level;
  }
}

// Sum text/image counts inside a footer plus how many direct children
// look like a column (frames with their own children). Used to estimate
// whether the footer was authored as a real layout or flattened to art.
function countFooterChildren(n: ExtractedNode): { text: number; image: number; columnLike: number } {
  let text = 0;
  let image = 0;
  let columnLike = 0;
  function walk(node: ExtractedNode) {
    if (node.semanticRole === 'text' || node.role === 'text') text += 1;
    if (node.semanticRole === 'image' || node.role === 'image') image += 1;
    for (const c of node.children) walk(c);
  }
  for (const c of n.children) {
    if (c.children.length >= 1 && (c.semanticRole === 'container' || c.semanticRole === 'section' || c.semanticRole === 'grid')) {
      columnLike += 1;
    }
    walk(c);
  }
  return { text, image, columnLike };
}

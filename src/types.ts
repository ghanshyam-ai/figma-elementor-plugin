// Shared types used by both plugin sandbox (code.ts) and UI iframe (ui.ts).
// Keep this dependency-free so both contexts can import it.

export type RGBA = { r: number; g: number; b: number; a: number };

export type SolidFill = { type: 'SOLID'; color: string; opacity: number };
export type GradientStop = { position: number; color: string };
export type GradientFill = {
  type: 'GRADIENT_LINEAR' | 'GRADIENT_RADIAL' | 'GRADIENT_ANGULAR' | 'GRADIENT_DIAMOND';
  stops: GradientStop[];
  opacity: number;
  // CSS-style angle in degrees (0deg = bottom→top per CSS gradients).
  // Only meaningful for GRADIENT_LINEAR; populated best-effort otherwise.
  angle?: number;
  // Raw 2x3 transform matrix from Figma — kept so Claude can recompute
  // anything we didn't normalise.
  transform?: number[][];
};
export type ImageFill = { type: 'IMAGE'; assetId: string; scaleMode: string; opacity: number };
export type Fill = SolidFill | GradientFill | ImageFill;

export type Padding = { top: number; right: number; bottom: number; left: number };

export type LayoutInfo = {
  mode: 'NONE' | 'HORIZONTAL' | 'VERTICAL' | 'GRID';
  primaryAlign?: string;
  counterAlign?: string;
  itemSpacing?: number;
  padding?: Padding;
  sizingHorizontal?: 'FIXED' | 'HUG' | 'FILL';
  sizingVertical?: 'FIXED' | 'HUG' | 'FILL';
  wrap?: boolean;
  // Figma constraints: how this node resizes when its parent resizes.
  // Direct map to Elementor's responsive width/position rules.
  constraints?: { horizontal: ConstraintAxis; vertical: ConstraintAxis };
  // Per-child positioning inside an auto-layout parent. ABSOLUTE means the
  // child is overlaid (not part of the flex flow) — Elementor needs to
  // emit absolute positioning for these specifically.
  layoutPositioning?: 'AUTO' | 'ABSOLUTE';
};

export type ConstraintAxis = 'MIN' | 'MAX' | 'CENTER' | 'STRETCH' | 'SCALE';

export type TextStyle = {
  characters: string;
  fontFamily: string | null;
  fontStyle: string | null;
  fontWeight: number | null;
  fontSize: number | null;
  lineHeight: { value: number; unit: 'PIXELS' | 'PERCENT' } | 'AUTO' | null;
  letterSpacing: { value: number; unit: 'PIXELS' | 'PERCENT' } | null;
  align: 'LEFT' | 'CENTER' | 'RIGHT' | 'JUSTIFIED' | null;
  verticalAlign: 'TOP' | 'CENTER' | 'BOTTOM' | null;
  textCase: string | null;
  textDecoration: string | null;
  color: string | null;
  // Inline rich-text segments. Only emitted when the text node has more
  // than one styled segment (e.g. a bolded keyword inside a paragraph).
  // The base style above still describes the dominant run; runs preserve
  // the per-character deltas Claude needs to reconstruct the prose.
  runs?: TextRun[];
};

export type TextRun = {
  start: number;
  end: number;
  text: string;
  fontFamily?: string | null;
  fontWeight?: number | null;
  fontSize?: number | null;
  color?: string | null;
  textDecoration?: string | null;
  textCase?: string | null;
  link?: { type: 'URL' | 'NODE'; value: string };
};

export type Stroke = {
  color: string;
  opacity: number;
  weight: number;
  align: 'INSIDE' | 'OUTSIDE' | 'CENTER';
};

export type ShadowEffect = {
  type: 'DROP_SHADOW' | 'INNER_SHADOW';
  color: string;
  offsetX: number;
  offsetY: number;
  radius: number;
  spread: number;
};

export type BlurEffect = {
  type: 'LAYER_BLUR' | 'BACKGROUND_BLUR';
  radius: number;
};

export type Effect = ShadowEffect | BlurEffect;

// Extended semantic role list. The mapper still treats unknown extended
// roles like containers; the AI-friendly summary uses the richer label.
export type SemanticRole =
  | 'section'
  | 'container'
  | 'text'
  | 'image'
  | 'button'
  | 'shape'
  | 'hero'
  | 'navbar'
  | 'footer'
  | 'card'
  | 'grid'
  | 'pricing-card'
  | 'testimonial'
  | 'form'
  | 'input'
  | 'icon'
  | 'logo'
  | 'menu'
  | 'accordion'
  | 'tabs'
  | 'slider'
  | 'background-shape'
  | 'unknown';

export type AssetType =
  | 'image'
  | 'icon'
  | 'logo'
  | 'background'
  | 'decoration';

export type AssetFormat = 'svg' | 'png' | 'jpg' | 'webp';

export type RoleConfidence = {
  role: SemanticRole;
  confidence: number;
  reason: string;
};

export type Bounds = { x: number; y: number; width: number; height: number };

export type ComputedStyle = {
  display?: 'flex' | 'block' | 'absolute';
  flexDirection?: 'row' | 'column';
  gap?: number;
  padding?: string;
  background?: string;
  borderRadius?: number | string;
  border?: string;
  boxShadow?: string;
  font?: string;
  color?: string;
  textAlign?: string;
  width?: number | string;
  height?: number | string;
  opacity?: number;
};

export type ResponsiveHints = {
  desktop?: string;
  tablet?: string;
  mobile?: string;
  maxWidth?: number;
  containerWidth?: number;
  sectionPadding?: Padding;
};

// Granular page-section intent — used by downstream AI to pick widgets.
// `header` is an alias for nav-bearing top bars (some teams use that label).
// `trust-row` is a row of trust badges / brand logos / "as seen in" strips —
// narrower than the umbrella `social-proof` purpose.
export type SectionPurpose =
  | 'hero'
  | 'navbar'
  | 'header'
  | 'footer'
  | 'cta'
  | 'lead-capture'
  | 'feature-comparison'
  | 'feature-grid'
  | 'blog-grid'
  | 'social-proof'
  | 'trust'
  | 'trust-row'
  | 'stats'
  | 'faq'
  | 'pricing'
  | 'testimonial'
  | 'gallery'
  | 'content'
  | 'unknown';

// Structural layout pattern — extends the loose `layout` string with
// canonical names downstream consumers can switch on.
export type LayoutPattern =
  | '1-column'
  | '2-column-grid'
  | '3-column-grid'
  | '4-column-grid'
  | 'n-column-grid'
  | 'masonry'
  | 'equal-height-cards'
  | 'asymmetric'
  | 'stack'
  | 'absolute';

export type Importance = 'low' | 'medium' | 'high';
export type ContentPriority = 'primary' | 'secondary' | 'tertiary';
export type HeadingLevel = 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6';

// Elementor widget catalog — broader than the mapper's emitted set; this is
// a *suggestion* for downstream tooling, not what the exporter writes.
export type PreferredWidget =
  | 'heading'
  | 'text-editor'
  | 'image'
  | 'image-box'
  | 'icon'
  | 'icon-box'
  | 'icon-list'
  | 'button'
  | 'spacer'
  | 'divider'
  | 'nav-menu'
  | 'form'
  | 'price-list'
  | 'price-table'
  | 'testimonial'
  | 'testimonial-carousel'
  | 'image-carousel'
  | 'slides'
  | 'accordion'
  | 'toggle'
  | 'tabs'
  | 'posts'
  | 'counter'
  | 'progress'
  | 'star-rating'
  | 'social-icons'
  | 'video'
  | 'container';

export type BreakpointHints = {
  mobileCollapse?: boolean;
  hideOnMobile?: boolean;
  stackOrder?: number;
};

export type AccessibilityMetadata = {
  ariaRole?: string;
  headingLevel?: HeadingLevel;
  altText?: string;
  decorative?: boolean;
};

// Per-state visual delta for components that expose hover/focus/active/disabled
// variants in Figma. Only the fields the variant actually changes are populated.
export type StateStyle = {
  background?: string;
  color?: string;
  borderColor?: string;
  borderWidth?: number;
  borderRadius?: number;
  boxShadow?: string;
  opacity?: number;
};

export type InteractionStates = {
  hover?: StateStyle;
  focus?: StateStyle;
  active?: StateStyle;
  disabled?: StateStyle;
};

// Form input shape hints. inputType is inferred from the node name (e.g.
// "email", "password"); placeholder is the inner text inside the input
// frame; helperText is text directly below it (sibling) when detectable.
export type InputMetadata = {
  inputType?:
    | 'text'
    | 'email'
    | 'password'
    | 'tel'
    | 'number'
    | 'url'
    | 'search'
    | 'textarea'
    | 'checkbox'
    | 'radio'
    | 'select';
  placeholder?: string;
  helperText?: string;
  label?: string;
  required?: boolean;
};

// Hint emitted on icon assets so downstream agents can match against
// icon libraries (Lucide / FA / Tabler) instead of importing the raster.
// `pathHash` is a stable hash of the path d-attribute(s); `primaryPath` is
// the longest path so Claude has a sample to reason about.
export type IconHint = {
  pathHash: string;
  primaryPath?: string;
  viewBox?: string;
  pathCount: number;
};

// Parsed numeric-heading shape for stats sections, so downstream code does
// not have to regex "500+", "75.5K+", "$1.2M", "4.8/5", "98%" itself.
//   raw    – the exact characters as authored ("75.5K+")
//   value  – the numeric portion as a plain number (75.5)
//   prefix – any non-numeric prefix ("$" in "$1.2M")
//   suffix – any non-numeric suffix ("K+", "/5", "%", "+")
//   label  – the sibling caption text that describes what's being counted
export type CounterHint = {
  raw: string;
  value: number;
  prefix?: string;
  suffix?: string;
  label?: string;
};

// Per-node widget intent override. When the developer tags a node in Figma
// via the plugin's "Tag widget" UI, we stash the chosen widget here so the
// agent treats it as authoritative (overrides our heuristic preferredWidget).
export type WidgetHint =
  | 'counter'
  | 'tabs'
  | 'accordion'
  | 'image-carousel'
  | 'testimonial-carousel'
  | 'slides'
  | 'icon-list'
  | 'icon-box'
  | 'price-table'
  | 'price-list'
  | 'progress'
  | 'star-rating'
  | 'social-icons'
  | 'nav-menu'
  | 'form'
  | 'posts'
  | 'video'
  | 'image-box'
  | 'button'
  | 'image'
  | 'heading'
  | 'text-editor'
  | 'icon';

export type ExtractedNode = {
  id: string;
  name: string;
  type: string;
  visible: boolean;
  // legacy basic role used by the Elementor mapper
  role: 'section' | 'container' | 'text' | 'image' | 'button' | 'shape' | 'unknown';
  // richer semantic role + confidence used by the AI layer
  semanticRole?: SemanticRole;
  confidence?: number;
  roleReason?: string;
  // tree position
  parentId?: string | null;
  depth?: number;
  index?: number;
  siblingCount?: number;
  // bounds
  x: number;
  y: number;
  width: number;
  height: number;
  absoluteBounds?: Bounds;
  relativeBounds?: Bounds;
  rotation?: number;
  opacity?: number;
  cornerRadius?: number | { tl: number; tr: number; br: number; bl: number };
  fills: Fill[];
  strokes: Stroke[];
  effects?: Effect[];
  layout: LayoutInfo;
  // Synthesised auto-layout for nodes whose Figma layout mode is NONE but
  // whose children stack cleanly along an axis. Mapper prefers this over
  // absolute positioning when present.
  inferredLayout?: LayoutInfo;
  text?: TextStyle;
  // referenced asset (when this node should be exported as an image widget)
  assetId?: string;
  assetType?: AssetType;
  originalFormat?: AssetFormat;
  suggestedExportFormat?: AssetFormat;
  altText?: string;
  isDecorative?: boolean;
  importance?: Importance;
  // a11y hints
  ariaRole?: string;
  headingLevel?: HeadingLevel;
  // Hierarchy confidence — relative weight of this node within its section
  contentPriority?: ContentPriority;
  // Suggested Elementor widget for this node (advisory; the mapper may pick
  // something narrower from its emitted-widget set).
  preferredWidget?: PreferredWidget;
  // Authoritative widget hint — either set by the developer via the plugin's
  // "Tag widget" UI (stored on the Figma node via pluginData), or stamped by
  // the structural detectors (counter, logo-strip, icon-list). When present
  // this should override `preferredWidget` in the downstream agent's
  // selection logic.
  widgetHint?: WidgetHint;
  // For widgetHint='counter' nodes only — parsed numeric value + label.
  counterHint?: CounterHint;
  // Source of widgetHint: 'user' = developer-tagged via plugin UI;
  // 'auto' = stamped by structural detection. Lets downstream tooling decide
  // which signals to trust (user > auto).
  widgetHintSource?: 'user' | 'auto';
  // Granular intent for top-level sections (hero, cta, social-proof, etc.).
  sectionPurpose?: SectionPurpose;
  // Source of sectionPurpose, same semantics as widgetHintSource.
  sectionPurposeSource?: 'user' | 'auto';
  // Canonical layout pattern (e.g. "3-column-grid", "masonry").
  layoutPattern?: LayoutPattern;
  // Component reuse signals
  // - componentId: Figma's main component id for INSTANCE nodes
  // - componentFingerprint: structural hash; identical fingerprints across
  //   nodes mean they can collapse to the same Elementor template.
  // - instanceGroup: cluster id assigned to sibling fingerprints in the
  //   same parent (e.g. "pricing-card-group-1").
  componentId?: string;
  componentFingerprint?: string;
  instanceGroup?: string;
  // Hover/focus/active/disabled deltas pulled from Figma component variants.
  states?: InteractionStates;
  // Form-input metadata (inputType/placeholder/helperText/label).
  inputMetadata?: InputMetadata;
  // Per-node responsive behavior hints
  breakpoints?: BreakpointHints;
  // CSS-like computed style snapshot, useful for AI consumers
  style?: ComputedStyle;
  // bound Figma style ids (resolved by tokens.ts to names)
  fillStyleId?: string;
  strokeStyleId?: string;
  textStyleId?: string;
  effectStyleId?: string;
  children: ExtractedNode[];
};

export type Asset = {
  id: string;
  filename: string;
  // Uint8Array of PNG/SVG bytes. Sent through postMessage as a transferable.
  bytes: Uint8Array;
  width: number;
  height: number;
  format: AssetFormat;
  assetType?: AssetType;
  altText?: string;
  isDecorative?: boolean;
  // Other node-derived asset ids (icon_<nodeId>) that resolved to the same
  // content. Populated by the exporter when duplicate vectors collapsed.
  aliasIds?: string[];
};

export type Screenshot = {
  filename: string;
  bytes: Uint8Array;
  width: number;
  height: number;
  // When the screenshot is a crop of a sub-section (not a top-level frame),
  // these reference the originating Figma node so the agent can look it up.
  nodeId?: string;
  nodeName?: string;
  scope?: 'frame' | 'section';
};

export type FigmaStyleToken = {
  id: string;
  name: string;
  // semantic dot-path key derived from the style name (e.g. "color.primary")
  key: string;
  type: 'PAINT' | 'TEXT' | 'EFFECT' | 'GRID';
  value: unknown;
};

export type FigmaVariableToken = {
  id: string;
  name: string;
  key: string;
  collection: string;
  resolvedType: string;
  modes: { name: string; value: unknown }[];
};

export type ColorRoleHint =
  | 'brand-primary'
  | 'brand-secondary'
  | 'accent'
  | 'text-default'
  | 'text-muted'
  | 'text-inverse'
  | 'surface'
  | 'surface-alt'
  | 'border'
  | 'overlay'
  | 'unknown';

export type ColorUsageContext = {
  // Counts of how the color appears across the tree, by structural role.
  // Claude uses these to finalise the role; the plugin only suggests via
  // `roleHint`.
  buttonBg: number;
  buttonText: number;
  textBody: number;
  textHeading: number;
  surface: number;
  border: number;
  iconStroke: number;
  total: number;
};

export type DesignTokens = {
  colors: {
    name: string;
    value: string;
    usage: number;
    styleId?: string;
    // Additional paint-style ids that resolve to the same hex. Lets the
    // agent re-apply the designer's semantic intent (e.g. "Action/Default"
    // vs "Brand/Primary") when both share a color.
    aliasStyleIds?: string[];
    roleHint?: ColorRoleHint;
    usageContext?: ColorUsageContext;
  }[];
  typography: {
    name: string;
    fontFamily: string | null;
    fontWeight: number | null;
    fontSize: number | null;
    lineHeight: number | string | null;
    letterSpacing: number | null;
    styleId?: string;
    // True when fontFamily was filled from the file's dominant family
    // because Figma reported `mixed`/null. Agents should treat the family
    // as a best guess rather than authoritative.
    fontFamilyFallback?: boolean;
  }[];
  spacing: number[];
  radii: number[];
  effects?: {
    name: string;
    // Pretty-printed shadow ("0/4 blur 16 #00000033") for human review.
    value: string;
    // Structured shadow/blur data the mapper can wire straight into
    // Elementor's box_shadow control. Absent for unsupported effect kinds.
    shadow?: {
      type: 'DROP_SHADOW' | 'INNER_SHADOW' | 'LAYER_BLUR' | 'BACKGROUND_BLUR';
      x?: number;
      y?: number;
      blur: number;
      spread?: number;
      color?: string;
    }[];
    styleId?: string;
  }[];
  styles?: FigmaStyleToken[];
  variables?: FigmaVariableToken[];
  // semantic flat lookup map: "color.primary" -> "#635BFF"
  semantic?: Record<string, string | number>;
};

export type Metadata = {
  generator: string;
  version: string;
  exportedAt: string;
  source: {
    fileName: string;
    pageName: string;
    rootIds: string[];
    rootNames: string[];
  };
  counts: {
    nodes: number;
    assets: number;
    screenshots: number;
    sections: number;
    widgets: number;
  };
};

// --- AI-friendly layout summary -----------------------------------------

export type AILayoutContent = {
  heading?: string;
  subheading?: string;
  paragraph?: string;
  buttons?: { text: string; style?: string }[];
  items?: AISection[];
  image?: string;
};

export type AISection = {
  id: string;
  role: SemanticRole;
  name?: string;
  layout?: 'single-column' | 'two-column' | 'three-column' | 'four-column' | 'grid' | 'stack' | string;
  layoutPattern?: LayoutPattern;
  bounds?: Bounds;
  responsive?: ResponsiveHints;
  breakpoints?: BreakpointHints;
  style?: ComputedStyle;
  confidence?: number;
  reason?: string;
  // Page intent — only populated on top-level sections.
  sectionPurpose?: SectionPurpose;
  // Hierarchy + visual weight
  contentPriority?: ContentPriority;
  importance?: Importance;
  isDecorative?: boolean;
  // Suggested Elementor widget for this node
  preferredWidget?: PreferredWidget;
  // Authoritative widget hint — see ExtractedNode for semantics.
  widgetHint?: WidgetHint;
  counterHint?: CounterHint;
  widgetHintSource?: 'user' | 'auto';
  sectionPurposeSource?: 'user' | 'auto';
  // Component-reuse signals (see ExtractedNode for semantics)
  componentFingerprint?: string;
  instanceGroup?: string;
  componentId?: string;
  // Hover/focus/active/disabled deltas pulled from Figma component variants.
  states?: InteractionStates;
  // Form-input metadata (only set on `input`-role sections).
  inputMetadata?: InputMetadata;
  // a11y bundle
  accessibility?: AccessibilityMetadata;
  content?: AILayoutContent;
  children?: AISection[];
};

// Pre-grouped reusable component data. Each entry collects sibling nodes
// that share a structural fingerprint so downstream agents can fold them
// into one Elementor template instead of diffing per-node fingerprints.
export type ComponentTemplate = {
  groupId: string;
  fingerprint: string;
  role: SemanticRole;
  count: number;
  nodeIds: string[];
};

export type AILayout = {
  pageType: string;
  title: string;
  sections: AISection[];
  // Optional metadata describing whether the original selection was a
  // single artificial wrapper frame that the plugin flattened into siblings.
  rootFlattenedFrom?: string;
  componentTemplates?: ComponentTemplate[];
};

// --- Asset manifest -----------------------------------------------------

export type AssetManifestEntry = {
  id: string;
  filename: string;
  assetType: AssetType;
  originalFormat: AssetFormat;
  suggestedExportFormat: AssetFormat;
  width: number;
  height: number;
  altText?: string;
  isDecorative?: boolean;
  nodeId?: string;
  iconHint?: IconHint;
  // Other assetIds that collapsed to this canonical entry. Use these when
  // mapping a widget that references a non-canonical id back to the file.
  aliasIds?: string[];
};

// --- Validation report --------------------------------------------------

export type ValidationWarning = {
  level: 'info' | 'warn' | 'error';
  code: string;
  message: string;
  nodeId?: string;
  nodeName?: string;
};

export type ValidationReport = {
  generatedAt: string;
  warnings: ValidationWarning[];
  summary: {
    info: number;
    warn: number;
    error: number;
  };
};

// --- Elementor JSON shape (subset used by exporters) ---

export type ElementorWidgetType = 'heading' | 'text-editor' | 'image' | 'button' | 'spacer' | 'divider';

export type ElementorElement = {
  id: string;
  elType: 'container' | 'widget';
  widgetType?: ElementorWidgetType;
  settings: Record<string, unknown>;
  elements: ElementorElement[];
  isInner?: boolean;
};

export type ElementorTemplate = {
  version: '0.4';
  title: string;
  type: 'page';
  content: ElementorElement[];
  page_settings: Record<string, unknown>;
};

// --- Plugin <-> UI message protocol ---

// Light-weight description of one tagged Figma node, surfaced in the
// "Tag widget" panel so the developer can see + remove existing overrides
// at a glance.
export type TaggedNodeSummary = {
  id: string;
  name: string;
  widgetHint?: WidgetHint;
  sectionPurpose?: SectionPurpose;
};

// Auto-detected widget / purpose for a node, shown alongside the override
// dropdowns so the developer sees what the heuristic *would* pick.
export type AutoSuggestion = {
  widget?: WidgetHint;
  purpose?: SectionPurpose;
  confidence?: number;
  reason?: string;
};

// Selection summary sent to the UI on every selectionchange. The tagging
// panel uses this to enable/disable the widget dropdown and reflect any
// existing overrides on the currently-selected node.
export type SelectionInfo = {
  label: string;
  nodeId?: string;
  nodeName?: string;
  // Number of nodes selected. The UI now supports multi-select tagging,
  // so this is preferred over the old isSingle boolean (kept for back-compat).
  selectionCount: number;
  isSingle: boolean;
  hasSelection: boolean;
  // Existing overrides on the currently-selected node, if any. Set only on
  // single-node selections — multi-select shows the dropdowns empty since
  // mixed overrides can't be reflected in one value.
  widgetHint?: WidgetHint;
  sectionPurpose?: SectionPurpose;
  // Heuristic-suggested widget / purpose for the currently-selected node.
  // Lets the UI show "auto: counter" alongside the override dropdown so
  // the developer can compare before tagging.
  autoSuggestion?: AutoSuggestion;
  // Full list of tagged nodes on the current page, regardless of selection.
  taggedSummary: TaggedNodeSummary[];
};

// One row in the auto-tag suggestions panel — the developer reviews these
// and decides which to apply in bulk.
export type SuggestionRow = {
  nodeId: string;
  nodeName: string;
  widget?: WidgetHint;
  purpose?: SectionPurpose;
  confidence: number;
  reason: string;
  // True when this node already has the same tag (so applying is a no-op).
  alreadyTagged: boolean;
};

export type PluginToUIMessage =
  | { type: 'init'; selection: SelectionInfo }
  | { type: 'log'; level: 'info' | 'warn' | 'error'; message: string }
  | { type: 'progress'; phase: string; value: number }
  | {
      type: 'extracted';
      data: ElementorTemplate;
      tokens: DesignTokens;
      metadata: Metadata;
      assets: Asset[];
      screenshots: Screenshot[];
      aiLayout: AILayout;
      assetManifest: AssetManifestEntry[];
      validation: ValidationReport;
      taggedSummary: TaggedNodeSummary[];
    }
  | { type: 'preflight-result'; warnings: ValidationWarning[] }
  | { type: 'suggestions'; rows: SuggestionRow[] }
  | { type: 'error'; message: string };

export type UIToPluginMessage =
  | { type: 'extract' }
  | { type: 'reselect' }
  | { type: 'close' }
  | { type: 'tag-widget'; widget: WidgetHint | null }
  | { type: 'tag-section-purpose'; purpose: SectionPurpose | null }
  | { type: 'reveal-node'; nodeId: string }
  | { type: 'preflight' }
  | { type: 'suggest-tags' }
  | { type: 'apply-suggestions'; rows: SuggestionRow[] }
  | { type: 'clear-all-tags' };

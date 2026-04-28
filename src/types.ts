// Shared types used by both plugin sandbox (code.ts) and UI iframe (ui.ts).
// Keep this dependency-free so both contexts can import it.

export type RGBA = { r: number; g: number; b: number; a: number };

export type SolidFill = { type: 'SOLID'; color: string; opacity: number };
export type GradientStop = { position: number; color: string };
export type GradientFill = {
  type: 'GRADIENT_LINEAR' | 'GRADIENT_RADIAL' | 'GRADIENT_ANGULAR' | 'GRADIENT_DIAMOND';
  stops: GradientStop[];
  opacity: number;
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
};

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
};

export type Stroke = {
  color: string;
  opacity: number;
  weight: number;
  align: 'INSIDE' | 'OUTSIDE' | 'CENTER';
};

export type ExtractedNode = {
  id: string;
  name: string;
  type: string;
  visible: boolean;
  // role assigned by extractor — guides the mapper
  role: 'section' | 'container' | 'text' | 'image' | 'button' | 'shape' | 'unknown';
  x: number;
  y: number;
  width: number;
  height: number;
  rotation?: number;
  opacity?: number;
  cornerRadius?: number | { tl: number; tr: number; br: number; bl: number };
  fills: Fill[];
  strokes: Stroke[];
  layout: LayoutInfo;
  text?: TextStyle;
  // referenced asset (when this node should be exported as an image widget)
  assetId?: string;
  children: ExtractedNode[];
};

export type Asset = {
  id: string;
  filename: string;
  // Uint8Array of PNG bytes. Sent through postMessage as a transferable.
  bytes: Uint8Array;
  width: number;
  height: number;
};

export type Screenshot = {
  filename: string;
  bytes: Uint8Array;
  width: number;
  height: number;
};

export type DesignTokens = {
  colors: { name: string; value: string; usage: number }[];
  typography: {
    name: string;
    fontFamily: string | null;
    fontWeight: number | null;
    fontSize: number | null;
    lineHeight: number | string | null;
    letterSpacing: number | null;
  }[];
  spacing: number[];
  radii: number[];
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

// --- Elementor JSON shape (subset used by exporters) ---

export type ElementorWidgetType = 'heading' | 'text-editor' | 'image' | 'button' | 'spacer';

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

export type PluginToUIMessage =
  | { type: 'init'; selectionLabel: string }
  | { type: 'log'; level: 'info' | 'warn' | 'error'; message: string }
  | { type: 'progress'; phase: string; value: number }
  | {
      type: 'extracted';
      data: ElementorTemplate;
      raw: ExtractedNode[];
      tokens: DesignTokens;
      metadata: Metadata;
      assets: Asset[];
      screenshots: Screenshot[];
    }
  | { type: 'error'; message: string };

export type UIToPluginMessage =
  | { type: 'extract' }
  | { type: 'reselect' }
  | { type: 'close' };

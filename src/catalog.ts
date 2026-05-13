// Single source of truth for the Elementor widget + section-purpose
// vocabularies the plugin exposes for tagging. Both the extractor (override
// validation) and the UI (dropdown options) consume this file so the lists
// stay aligned when Elementor adds new widgets or the team agrees on new
// section labels.
//
// Adding a new widget: append to WIDGET_CATALOG and update the WidgetHint
// type in types.ts. The UI dropdowns regenerate on next build.

import type { SectionPurpose, WidgetHint } from './types';

export type WidgetCatalogEntry = {
  value: WidgetHint;
  label: string;
  group: 'container' | 'leaf';
  // True for widgets that need an Elementor Pro license. Surfaced in the
  // UI as a small hint so the developer knows their target install must
  // support it before they pick the tag.
  pro?: boolean;
};

export const WIDGET_CATALOG: WidgetCatalogEntry[] = [
  // Containers / sections — widgets whose tree contains other widgets.
  { value: 'tabs', label: 'Tabs', group: 'container' },
  { value: 'accordion', label: 'Accordion', group: 'container' },
  { value: 'image-carousel', label: 'Image carousel', group: 'container' },
  { value: 'testimonial-carousel', label: 'Testimonial carousel', group: 'container', pro: true },
  { value: 'slides', label: 'Slides', group: 'container', pro: true },
  { value: 'icon-list', label: 'Icon list', group: 'container' },
  { value: 'price-table', label: 'Price table', group: 'container', pro: true },
  { value: 'price-list', label: 'Price list', group: 'container', pro: true },
  { value: 'form', label: 'Form', group: 'container', pro: true },
  { value: 'posts', label: 'Posts grid', group: 'container', pro: true },
  { value: 'nav-menu', label: 'Nav menu', group: 'container' },

  // Leaf widgets — terminal nodes in the Elementor tree.
  { value: 'counter', label: 'Counter', group: 'leaf' },
  { value: 'progress', label: 'Progress bar', group: 'leaf' },
  { value: 'star-rating', label: 'Star rating', group: 'leaf' },
  { value: 'social-icons', label: 'Social icons', group: 'leaf' },
  { value: 'video', label: 'Video', group: 'leaf' },
  { value: 'image-box', label: 'Image box', group: 'leaf' },
  { value: 'icon-box', label: 'Icon box', group: 'leaf' },
  { value: 'image', label: 'Image', group: 'leaf' },
  { value: 'button', label: 'Button', group: 'leaf' },
  { value: 'heading', label: 'Heading', group: 'leaf' },
  { value: 'text-editor', label: 'Text editor', group: 'leaf' },
  { value: 'icon', label: 'Icon', group: 'leaf' },
];

export type SectionPurposeCatalogEntry = {
  value: SectionPurpose;
  label: string;
};

export const SECTION_PURPOSE_CATALOG: SectionPurposeCatalogEntry[] = [
  { value: 'hero', label: 'Hero' },
  { value: 'navbar', label: 'Navbar' },
  { value: 'header', label: 'Header' },
  { value: 'footer', label: 'Footer' },
  { value: 'cta', label: 'Call to action' },
  { value: 'lead-capture', label: 'Lead capture' },
  { value: 'feature-grid', label: 'Feature grid' },
  { value: 'feature-comparison', label: 'Feature comparison' },
  { value: 'pricing', label: 'Pricing' },
  { value: 'testimonial', label: 'Testimonial' },
  { value: 'faq', label: 'FAQ' },
  { value: 'stats', label: 'Stats / counters' },
  { value: 'social-proof', label: 'Social proof' },
  { value: 'trust', label: 'Trust / certifications' },
  { value: 'trust-row', label: 'Trust row / logo strip' },
  { value: 'gallery', label: 'Gallery' },
  { value: 'blog-grid', label: 'Blog grid' },
  { value: 'content', label: 'Generic content' },
];

// Lookup sets used by extractor.applyPluginDataOverrides to validate a
// developer-authored pluginData value before stamping it on the node.
export const WIDGET_HINT_VALUES: ReadonlySet<string> = new Set(
  WIDGET_CATALOG.map((e) => e.value),
);
export const SECTION_PURPOSE_VALUES: ReadonlySet<string> = new Set(
  SECTION_PURPOSE_CATALOG.map((e) => e.value),
);

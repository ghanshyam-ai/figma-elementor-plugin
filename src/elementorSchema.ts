import type {
  ElementorElement,
  ElementorSchemaIssue,
  ElementorSchemaReport,
  ElementorTemplate,
} from './types';

// Structural + settings-key validation for the generated Elementor JSON.
// Elementor silently ignores settings keys it doesn't recognise, so a wrong
// key convention (padding vs _padding) produces a page that imports fine and
// simply loses the styling. These checks catch that class of bug offline.

export const BREAKPOINT_SUFFIXES = ['tablet', 'mobile', 'laptop', 'widescreen', 'tablet_extra', 'mobile_extra'] as const;
const SUFFIX_RX = new RegExp(`_(${BREAKPOINT_SUFFIXES.join('|')})$`);

// Widgets this plugin (or Elementor core / Pro) knows. Unknown widget types
// are only a warning: custom widgets are legitimate.
const KNOWN_WIDGETS: ReadonlySet<string> = new Set([
  'heading', 'text-editor', 'image', 'button', 'spacer', 'divider', 'counter',
  'icon-list', 'accordion', 'tabs', 'form', 'icon', 'icon-box', 'image-box',
  'image-carousel', 'testimonial', 'testimonial-carousel', 'nav-menu',
  'price-table', 'price-list', 'progress', 'social-icons', 'video', 'toggle',
  'star-rating', 'posts', 'slides', 'html', 'shortcode', 'google_maps',
  'nested-accordion', 'nested-tabs', 'icon-list',
]);

// Plugin-private metadata keys. Elementor ignores them by design.
function isMetaKey(key: string): boolean {
  return key.startsWith('_figma_') || key.startsWith('_ai_') ||
    key.startsWith('_widget_hint') || key === '_unbuilt_widget_intent';
}

// Advanced-tab keys that exist ONLY with the underscore prefix on widgets.
// Putting the bare name on a widget (or the prefixed name on a container) is
// silently dropped by Elementor.
const WIDGET_ADVANCED_BARE = ['padding', 'margin', 'position'];
const CONTAINER_ADVANCED_PREFIXED = ['_padding', '_margin', '_border_radius'];
// Widget-advanced positioning keys also emitted on absolutely positioned
// containers by applyAbsolutePosition; flagged as a warning, not an error.
const CONTAINER_POSITION_PREFIXED = ['_position', '_element_width'];

function isDimension(v: unknown): boolean {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return typeof o.unit === 'string' && ('size' in o || 'top' in o);
}

function stripSuffix(key: string): { base: string; suffix?: string } {
  const m = key.match(SUFFIX_RX);
  return m ? { base: key.slice(0, -m[0].length), suffix: m[1] } : { base: key };
}

export function validateElementorTemplate(template: ElementorTemplate): ElementorSchemaReport {
  const issues: ElementorSchemaIssue[] = [];
  const ids = new Set<string>();
  let checked = 0;

  function push(
    level: ElementorSchemaIssue['level'], code: string, message: string,
    el: ElementorElement, key?: string,
  ) {
    const settings = el.settings && !Array.isArray(el.settings) ? el.settings : {};
    const figmaId = typeof (settings as Record<string, unknown>)._figma_id === 'string'
      ? ((settings as Record<string, unknown>)._figma_id as string)
      : undefined;
    issues.push({ level, code, message, elementId: el.id, figmaId, key });
  }

  function visit(el: ElementorElement) {
    checked += 1;
    if (typeof el.id !== 'string' || !el.id) {
      push('error', 'missing-id', 'element has no id', el);
    } else if (ids.has(el.id)) {
      push('error', 'duplicate-id', `duplicate element id "${el.id}"`, el);
    } else {
      ids.add(el.id);
    }

    if (el.elType !== 'container' && el.elType !== 'widget') {
      push('error', 'bad-eltype', `elType must be "container" or "widget", got "${String(el.elType)}"`, el);
    }
    if (el.elType === 'widget') {
      if (!el.widgetType) push('error', 'missing-widget-type', 'widget has no widgetType', el);
      else if (!KNOWN_WIDGETS.has(el.widgetType)) {
        push('warn', 'unknown-widget-type', `widgetType "${el.widgetType}" is not a known Elementor widget`, el);
      }
      if (el.elements && el.elements.length > 0) {
        push('warn', 'widget-with-children', 'widgets should not carry child elements', el);
      }
    }
    if (el.elType === 'container' && el.widgetType) {
      push('error', 'container-widget-type', 'container must not set widgetType', el);
    }
    if (!Array.isArray(el.elements)) push('error', 'missing-elements', 'elements must be an array', el);

    const rawSettings = el.settings;
    if (rawSettings === undefined || rawSettings === null || typeof rawSettings !== 'object') {
      push('error', 'missing-settings', 'settings must be an object or []', el);
    } else if (!Array.isArray(rawSettings)) {
      checkSettings(el, rawSettings as Record<string, unknown>);
    }

    for (const c of el.elements ?? []) visit(c);
  }

  function checkSettings(el: ElementorElement, s: Record<string, unknown>) {
    const keys = Object.keys(s);
    for (const key of keys) {
      if (isMetaKey(key)) continue;
      const { base, suffix } = stripSuffix(key);

      if (el.elType === 'container') {
        if (CONTAINER_ADVANCED_PREFIXED.includes(base)) {
          push('error', 'container-prefixed-key',
            `container uses "${key}"; containers take the un-prefixed "${base.slice(1)}${suffix ? '_' + suffix : ''}"`,
            el, key);
        } else if (CONTAINER_POSITION_PREFIXED.includes(base)) {
          push('warn', 'container-position-key',
            `"${key}" is a widget Advanced-tab key on a container; verify the container honors it`, el, key);
        }
      } else if (el.elType === 'widget') {
        if (WIDGET_ADVANCED_BARE.includes(base)) {
          push('error', 'widget-bare-key',
            `widget uses "${key}"; widget Advanced settings take the prefixed "_${base}${suffix ? '_' + suffix : ''}"`,
            el, key);
        }
      }

      if (suffix) {
        // A responsive override must have the same shape as its desktop key.
        const desktop = s[base];
        const v = s[key];
        if (desktop !== undefined && v !== undefined) {
          const shapeA = isDimension(desktop) ? 'dimension' : typeof desktop;
          const shapeB = isDimension(v) ? 'dimension' : typeof v;
          if (shapeA !== shapeB) {
            push('error', 'responsive-shape-mismatch',
              `"${key}" is a ${shapeB} but "${base}" is a ${shapeA}`, el, key);
          }
        }
      }
    }
  }

  for (const el of template.content ?? []) visit(el);
  return { checkedElements: checked, issues };
}

// Page settings: Elementor only reads known keys; we only ever emit the
// wrapper tag today, but guard against a stray prefixed key sneaking in.
export function validatePageSettings(template: ElementorTemplate): ElementorSchemaIssue[] {
  const issues: ElementorSchemaIssue[] = [];
  const ps = template.page_settings;
  if (ps === undefined || ps === null || typeof ps !== 'object') {
    issues.push({ level: 'error', code: 'bad-page-settings', message: 'page_settings must be an object or []' });
    return issues;
  }
  if (!Array.isArray(ps)) {
    for (const key of Object.keys(ps)) {
      if (key.startsWith('_') && !isMetaKey(key)) {
        issues.push({ level: 'warn', code: 'page-settings-prefixed-key', message: `page_settings key "${key}" looks like a widget key`, key });
      }
    }
  }
  return issues;
}

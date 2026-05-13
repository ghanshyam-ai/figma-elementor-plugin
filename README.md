# Figma → Elementor Exporter

A Figma plugin that extracts a frame or page into a structured ZIP package
ready to be consumed by an Elementor-generation agent (e.g. Claude Code).

The ZIP contains:

```
export/
├── ai-layout.json     # Compact AI-friendly summary (page type + sections + content)
├── global.json        # Design tokens: colors, typography, Figma styles, variables, semantic map
├── assets.json        # Asset manifest: type / format / alt / decorative flag
├── tags.json          # Developer-authored widget + section-purpose overrides
├── validation.json    # Warnings (unnamed layers, absolute layout, mixed fonts, ...)
├── data.json          # Elementor template (containers + widgets) — preview/debug
├── metadata.json      # File / page / counts
├── screenshots/
│   └── <frame>.png    # 2× PNG of each selected frame
├── assets/
│   └── images/        # Exported image fills + rasterised graphics + SVG icons/logos
└── README.md
```

### Recommended consumption for AI agents

Prefer `ai-layout.json` + `tokens.json` + `assets.json` + screenshots over the
raw Figma tree — they cut prompt-token cost dramatically and surface
semantic intent that's lost in the raw geometry. Use `validation.json` to
decide which sections need a manual visual fallback. `data.json` is kept
as a preview/debug artifact: the long-term intent is *plugin extracts
design data only, an agent maps to Elementor*.

## Install (development)

Requires Node 18+ and the Figma desktop app.

```bash
npm install
npm run build         # bundles plugin + UI
npm run type-check    # tsc --noEmit
npm test              # node --test, no extra dev deps
```

Then in Figma desktop:

1. **Plugins → Development → Import plugin from manifest…**
2. Select `manifest.json` in this repo.
3. Run **Plugins → Development → Elementor Exporter**.

For live rebuilds while developing, run `npm run watch` in another terminal.

## Use

1. Open a Figma file and select one or more frames (or run with no
   selection to export every top-level frame on the current page).
2. (Optional) **Tag widgets & section purposes** — see below.
3. Click **Extract design** in the plugin panel.
4. When extraction finishes, click **Download ZIP**.

### Tagging widgets and section purposes

The plugin auto-detects most widgets and section purposes, but you can
override the heuristic on any node. Open **Tag widgets & sections** in
the plugin, select **one or more** Figma nodes, then:

- **Widget hint** – pick from the full Elementor widget catalog (vocab
  is defined in `src/catalog.ts`). Container widgets include tabs,
  accordion, carousels, icon-list, price-table, posts, form, nav-menu.
  Leaf widgets include counter, progress, star-rating, social-icons,
  video, image-box, image, button, heading, text-editor, icon.
- **Section purpose** – pick a granular page-section intent (hero,
  navbar, header, footer, cta, lead-capture, feature-grid, pricing,
  testimonial, faq, stats, social-proof, trust, trust-row, gallery,
  blog-grid, content).

Tags are stored on the Figma node via `setPluginData` and survive across
plugin runs and file reopens. During extraction the plugin reads these
overrides and stamps them on the AI layout / Elementor settings as
authoritative — the agent treats user tags as ground truth.

- **Multi-select tagging** – apply one tag to N nodes in a single pass.
- **`auto: <widget>` pill** – the dropdown labels show the heuristic's
  best guess next to the override; click the pill to accept it.
- **Suggest tags** – sweep every top-level frame on the page, present
  proposed widget / purpose tags with confidence scores, and let you
  accept-some / accept-all in one bulk action.
- **Preflight check** – run the brand-color hygiene check (and any
  future token-only validation) without doing a full export pass.
- **Clear all tags** – wipe every user-authored override on the page.
- **Currently tagged on this page** – running list of every override;
  click a row to jump back to the node in Figma.
- **`tags.json`** – every override is also dumped into the ZIP for
  reviewers, alongside `validation.json` / `ai-layout.json`.

### Annotations the agent should consume

The exporter emits several `_figma_*` and `_widget_hint*` annotations on
every Elementor `settings` block (in `data.json`) and on each AI section
(in `ai-layout.json`):

| Field | Meaning |
|---|---|
| `_figma_id`, `_figma_name` | Source Figma node id and layer name |
| `_ai_role`, `_ai_confidence` | Plugin-classified semantic role + confidence |
| `_figma_section_purpose` | Top-level intent (`hero`, `pricing`, `trust-row`, ...) |
| `_figma_section_purpose_source` | `user` or `auto` |
| `_ai_preferred_widget` | Heuristic Elementor widget choice |
| `_widget_hint` | Authoritative widget hint (user-tagged or counter/logo-strip auto) |
| `_widget_hint_source` | `user` or `auto` |
| `_figma_counter` | Parsed counter source `{ raw, value, prefix, suffix, label }` |
| `_figma_instance_group` | Component-template group id for repeated cards |

## Architecture

| File | Responsibility |
|---|---|
| `src/code.ts` | Plugin sandbox entry; orchestrates the pipeline. |
| `src/extractor.ts` | Walks a Figma node tree → `ExtractedNode` with semantic roles, effects, computed styles, parent/child metadata. |
| `src/tokens.ts` | Aggregates global design tokens; reads Figma local styles + variables. |
| `src/aiLayout.ts` | Builds `ai-layout.json`, `assets.json`, `validation.json`. |
| `src/mapper.ts` | Maps `ExtractedNode` → Elementor JSON (preview/debug). |
| `src/exporter.ts` | Image fills, vector → SVG/PNG, and frame screenshots via `exportAsync`. |
| `src/types.ts` | Shared types + plugin↔UI message protocol. |
| `ui/ui.html` + `ui/ui.ts` | Plugin UI. Receives data and packages the ZIP via JSZip. |

The plugin sandbox cannot create blobs or trigger downloads, so all ZIP
assembly happens in the UI iframe. Image bytes (`Uint8Array`) cross the
boundary via `figma.ui.postMessage`.

## Design choices & trade-offs

- **Auto layout first.** When a frame uses Auto Layout we emit Elementor
  `flex_*` settings. Frames without Auto Layout emit a non-flex container
  whose children get `_position: absolute` + `_offset_x`/`_offset_y` so
  pixel positions survive the import.
- **Container width is pinned to the frame.** Top-level containers set
  `content_width: 'boxed'` + `boxed_width` to the Figma frame width so
  the page lands at the same dimensions the designer intended. Inner
  containers honor Figma's FILL/HUG/FIXED sizing modes.
- **Setting-key prefixes follow Elementor's schema.** Container layout
  settings are un-prefixed (`padding`, `border_radius`, `flex_*`), but
  widget Advanced-tab settings use the underscore prefix
  (`_padding`, `_border_radius`, `_element_width`, `_position`,
  `_offset_x`). Elementor silently drops mismatched keys.
- **Element classification is semantic + structural.** Each node is assigned
  a rich semantic role (`hero`, `navbar`, `footer`, `card`, `pricing-card`,
  `testimonial`, `form`, `input`, `icon`, `logo`, `menu`, `accordion`,
  `slider`, `background-shape`, ...) plus a confidence score and reason.
  Buttons are detected both by name and by structure (rounded frame +
  text child + background + clickable size), so name-less buttons still
  get classified. The legacy six-role label (`section`, `container`,
  `text`, `image`, `button`, `shape`) is preserved for the Elementor mapper.
- **Tokens combine derived + authoritative.** When a file has Figma local
  styles or variables, they are extracted into `tokens.json` with semantic
  dot-paths (`color.primary`, `font.heading.size`, ...). Otherwise the
  tokens fall back to usage-frequency heuristics.
- **Spacing array contract.** `tokens.spacing` is an ascending-sorted
  deduplicated list of every non-zero `itemSpacing` / padding value seen
  in the file. The semantic shortcuts make the ordering contract explicit:
  - `spacing.widget_gap` → `spacing[0]` (smallest, typical inter-widget gap)
  - `spacing.section_gap` → `spacing[middle]` (inter-section gap)
  - `spacing.section_padding` → `spacing[last]` (outer hero/section padding)
- **Typography completeness.** Every distinct (family, weight, size)
  combination used in the file lands in `tokens.typography`. Entries
  whose `fontFamily` arrived as `figma.mixed`/null fall back to the
  file's most-used family, with `fontFamilyFallback: true` flagged so
  consumers know it's a best guess.
- **Icons and logos export as SVG when possible.** Frames classified as
  `icon` or `logo` (by name or by being a small square vector group) are
  exported via `exportAsync({ format: 'SVG' })`, falling back to PNG@2× if
  SVG export fails. Image fills are still rasterised PNG.
- **Hidden layers are skipped by default.** Pass `includeHidden: true`
  to the extractor if you need them. Slices, sticky notes, and connectors
  are always skipped.
- **Missing fonts are tolerated.** We never call `loadFontAsync` because
  we only read text properties; if a font is missing in Figma the file
  still opens read-only and extraction continues.

## Sample output

See [`examples/sample-output.json`](examples/sample-output.json) for a
trimmed example of `data.json`.

## Edge cases handled

- `figma.mixed` properties (fills, fontName, fontSize, line height) are
  treated as "no value" rather than crashing.
- Image fills are de-duplicated by `imageHash`.
- Vector icons / groups flagged as image-like are rasterised on the fly.
- Component instances trigger `getMainComponentAsync()` to ensure their
  properties are resolved before we read them.
- Extremely deep trees are capped at 64 levels of recursion.

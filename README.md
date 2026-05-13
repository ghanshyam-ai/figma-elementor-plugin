# Figma → Elementor Exporter

A Figma plugin that extracts a frame or page into a structured ZIP package
ready to be consumed by an Elementor-generation agent (e.g. Claude Code).

The ZIP contains:

```
export/
├── ai-layout.json     # Compact AI-friendly summary (page type + sections + content)
├── tokens.json        # Design tokens: colors, typography, Figma styles, variables, semantic map
├── global.json        # Same as tokens.json, kept for backwards-compat
├── assets.json        # Asset manifest: type / format / alt / decorative flag
├── validation.json    # Warnings (unnamed layers, absolute layout, mixed fonts, ...)
├── data.json          # Elementor template (containers + widgets) — preview/debug
├── raw.json           # Full extracted Figma node tree (semantic roles + computed styles)
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
npm run build
```

Then in Figma desktop:

1. **Plugins → Development → Import plugin from manifest…**
2. Select `manifest.json` in this repo.
3. Run **Plugins → Development → Elementor Exporter**.

For live rebuilds while developing, run `npm run watch` in another terminal.

## Use

1. Open a Figma file and select one or more frames (or run with no
   selection to export every top-level frame on the current page).
2. Click **Extract design** in the plugin panel.
3. When extraction finishes, click **Download ZIP**.

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

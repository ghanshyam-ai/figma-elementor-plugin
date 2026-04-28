# Figma → Elementor Exporter

A Figma plugin that extracts a frame or page into a structured ZIP package
ready to be consumed by an Elementor-generation agent (e.g. Claude Code).

The ZIP contains:

```
export/
├── data.json          # Elementor template (containers + widgets)
├── global.json        # Design tokens: colors, typography, spacing, radii
├── raw.json           # Full extracted Figma node tree
├── metadata.json      # File / page / counts
├── screenshots/
│   └── <frame>.png    # 2× PNG of each selected frame
├── assets/
│   └── images/        # Exported image fills + rasterised icons
└── README.md
```

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
| `src/extractor.ts` | Walks a Figma node tree → `ExtractedNode`. |
| `src/tokens.ts` | Aggregates global design tokens. |
| `src/mapper.ts` | Maps `ExtractedNode` → Elementor JSON. |
| `src/exporter.ts` | Image fills & frame screenshots via `exportAsync`. |
| `src/types.ts` | Shared types + plugin↔UI message protocol. |
| `ui/ui.html` + `ui/ui.ts` | Plugin UI. Receives data and packages the ZIP via JSZip. |

The plugin sandbox cannot create blobs or trigger downloads, so all ZIP
assembly happens in the UI iframe. Image bytes (`Uint8Array`) cross the
boundary via `figma.ui.postMessage`.

## Design choices & trade-offs

- **Auto layout first.** When a frame uses Auto Layout we emit Elementor
  `flex_*` settings rather than absolute positions; this keeps the
  generated layout responsive. Frames without Auto Layout fall back to
  fixed pixel sizing.
- **Element classification is heuristic.** Frames named `*button*` or
  `*cta*` become button widgets; rectangles/ellipses with image fills
  become image widgets; small text becomes `text-editor`, large text
  becomes `heading` with a tag (h1–h6) chosen by font size.
- **Tokens are derived, not authoritative.** We sort colors by usage and
  label the top entries `primary` / `secondary` / `accent` / `neutral-*`.
  If you have proper Figma Variables configured, prefer those instead.
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

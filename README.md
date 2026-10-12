# PageRig

A PDF viewer and editor that runs in the browser and as a desktop app (Windows, macOS, Linux) from one codebase.

## What works today

- **View:** continuous scrolling, thumbnails, zoom (steps or fit to width), jump to page, and text search with a results list.
- **Organize pages:** drag to reorder (including several at once), rotate, crop, delete, insert blank pages, insert pages from another PDF, and merge whole files.
- **Split and extract:** split every N pages or by custom ranges such as `1-3, 4, 5-`, or save just the selected pages as a new PDF.
- **Undo and redo** for every page edit.
- Files never leave your machine. Pages are copied rather than re-rendered, so text stays selectable and file size stays small.

Encrypted PDFs open for viewing; saving them comes with the security tools.

## Roadmap

1. Foundation, viewer and page management *(this release)*
2. Text and image editing, OCR, forms, fill and sign
3. Encryption and permissions, redaction and sanitizing, conversion to and from Office and images
4. Signature requests, tracking, templates and bulk send

## Development

Requires Node 22+. The desktop app also needs Rust and the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) for your OS.

```sh
npm install
npm run dev          # web app at http://localhost:1420
npm test             # unit tests
npm run build        # production web build in dist/

npm run tauri dev    # desktop app with hot reload
npm run tauri build  # desktop installers in src-tauri/target/release/bundle/
```

### Layout

| Path | What it does |
| --- | --- |
| `src/lib/document.ts` | The editable document: a list of page references (source, rotation, crop). All edits are pure functions. |
| `src/lib/export.ts` | Builds real PDFs from that list with pdf-lib. |
| `src/lib/render.ts` | Rendering and text search with pdf.js. |
| `src/lib/platform.ts` | Opening and saving files in the browser vs. the desktop app. |
| `src/components/` | Thumbnails, page canvas and dialogs. |
| `src-tauri/` | The Tauri desktop shell. |

Keyboard shortcuts: Ctrl/Cmd + O open, S save, F search, Z undo, Shift+Z or Y redo, A select all, +/- zoom. Delete removes the selected pages.

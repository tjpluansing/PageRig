# PageRig

A PDF viewer and editor that runs in the browser and as a desktop app (Windows, macOS, Linux) from one codebase.

## What works today

- **View:** continuous scrolling, thumbnails, zoom (steps or fit to width), jump to page, and text search with a results list.
- **Organize pages:** drag to reorder (including several at once), rotate, crop, delete, insert blank pages, insert pages from another PDF, and merge whole files.
- **Split and extract:** split every N pages or by custom ranges such as `1-3, 4, 5-`, or save just the selected pages as a new PDF.
- **Fill & sign:** fill in a PDF's existing form fields; add text, today's date, check marks, crosses and dots; draw, type or upload a signature and initials (remembered on this device); place stamps like APPROVED or DRAFT; add pictures. Everything can be moved and resized.
- **Edit existing content:** click any line of text to retype it (in the closest standard font), and replace or remove images. The original stays underneath, covered, unless you choose to remove covered content when saving.
- **OCR:** recognise text on scanned pages so it can be searched, selected and edited. The saved PDF gets an invisible text layer. The engine and English data are built in, so it works offline.
- **Build forms:** add fillable text boxes, checkboxes and dropdowns to any PDF. Forms stay fillable after merging, splitting and reordering.
- **Redact:** drag over anything, or redact every match of a search. When you save, everything under a redaction is removed for good: the page is saved as an image with its remaining text kept searchable.
- **Protect:** require a password to open, restrict printing, copying and editing (AES-256), and strip metadata, comments, scripts and attachments.
- **Password-protected files** open for editing in every standard encryption type. Files whose owner restricted changes need the permissions password to save.
- **Convert:** open JPG, PNG, WebP, GIF and other images as PDF pages, and Word, Excel, PowerPoint, OpenDocument, RTF, text and HTML files as PDFs. Export pages as PNG or JPEG images (zipped in the browser), or as an editable Word document or PowerPoint presentation.
- **Undo and redo** for every edit.
- Files never leave your machine, except Office files on the web app, which go to your own converter server (see below). Pages are copied rather than re-rendered, so text stays selectable and file size stays small.

## Roadmap

1. Foundation, viewer and page management *(done)*
2. Fill and sign, forms, editing existing text and images, OCR *(done)*
3. Encryption and permissions, redaction and sanitizing, conversion to and from Office and images *(done)*
4. Signature requests, tracking, templates and bulk send *(next)*

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

### Office conversion

Office files are converted with [LibreOffice](https://www.libreoffice.org/). Images need nothing extra.

- **Desktop app:** uses LibreOffice installed on the computer. It's found on the PATH or in its usual install folder; set `PAGERIG_SOFFICE` to point at `soffice` if it's somewhere else.
- **Web app:** runs the small server in `server/` and builds the app with its address:

  ```sh
  docker build -t pagerig-converter server
  docker run -p 8080:8080 -e ALLOWED_ORIGIN=https://your-pagerig-site pagerig-converter
  VITE_CONVERTER_URL=https://your-converter npm run build
  ```

  The server keeps nothing: each file is converted in a temporary folder that's deleted straight after. `MAX_MB`, `TIMEOUT_S` and `CONCURRENCY` limit file size, conversion time and parallel jobs. Without `VITE_CONVERTER_URL`, the web app still converts images, and tells people Office files need the desktop app.

Converting PDF to Word or PowerPoint keeps text editable but places it in positioned boxes, so complex layouts can need tidying. PDF to Excel and capturing web pages as PDF aren't supported yet.

### Layout

| Path | What it does |
| --- | --- |
| `src/lib/document.ts` | The editable document: a list of page references (source, rotation, crop). All edits are pure functions. |
| `src/lib/objects.ts` | Text, marks, images and form fields placed on pages, and the page/screen coordinate maths. |
| `src/lib/export.ts` | Builds real PDFs from that list with pdf-lib, drawing placed objects and filling forms. |
| `src/lib/render.ts` | Rendering, text search and finding editable text and images with pdf.js. |
| `src/lib/ocr.ts` | Text recognition for scanned pages with Tesseract. |
| `src/lib/security.ts`, `crypto.ts` | Encrypting and decrypting PDFs (RC4, AES-128, AES-256). |
| `src/lib/redact.ts`, `sanitize.ts` | Redaction and removing hidden information when saving. |
| `src/lib/convert.ts`, `office.ts` | Images to and from PDF, ZIP bundling, and Office conversion through LibreOffice. |
| `src/lib/platform.ts` | Opening and saving files in the browser vs. the desktop app. |
| `src/components/` | Thumbnails, page canvas, the on-page overlay, the Fill & sign toolbar and dialogs. |
| `src-tauri/` | The Tauri desktop shell, including the LibreOffice command (`src/office.rs`). |
| `server/` | The converter server for the web app (Node, no dependencies) and its Dockerfile. |

Keyboard shortcuts: Ctrl/Cmd + O open, S save, F search, Z undo, Shift+Z or Y redo, A select all, +/- zoom. Delete removes the selected object, or the selected pages. Esc returns to the Select tool.

Added and edited text uses the standard PDF fonts (Helvetica, Times, Courier), which cover Western European languages; other characters are saved as "?" for now.

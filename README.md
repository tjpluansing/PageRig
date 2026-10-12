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
- **Web pages:** open any public web page as a PDF, or add its pages to the document you're working on.
- **Signature requests:** place signature, initials, date, name, text and checkbox fields for one or more signers, then send. Each signer gets an emailed link, signs in the browser (in order, if you choose), and everyone receives the signed PDF with a certificate page listing who signed, when and from where. Track progress, send reminders, cancel, and reuse documents as templates, including bulk sending one template to a list of people.
- **Undo and redo** for every edit.
- Files never leave your machine, except Office files on the web app and documents you send for signature, which go to your own PageRig server (see below). Pages are copied rather than re-rendered, so text stays selectable and file size stays small.

## Roadmap

1. Foundation, viewer and page management *(done)*
2. Fill and sign, forms, editing existing text and images, OCR *(done)*
3. Encryption and permissions, redaction and sanitizing, conversion to and from Office and images *(done)*
4. Signature requests, tracking, templates and bulk send *(done)*

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

### The PageRig server

Office conversion and signature requests run on a small server in `server/`, which you host. Image conversion and everything else need no server. The Docker image bundles the web app too, so one container is a complete PageRig site:

```sh
docker build -f server/Dockerfile -t pagerig .
docker run -p 8080:8080 -v pagerig-data:/data \
  -e PUBLIC_URL=https://pagerig.example.com \
  -e SIGN_API_KEY=a-long-random-secret \
  -e SMTP_URL=smtps://user:password@smtp.example.com \
  -e MAIL_FROM="PageRig <sign@example.com>" \
  pagerig
```

Then open the site, choose **Request signatures**, and enter the server address and API key under **Sent requests → Server settings** (stored in that browser). The desktop app connects the same way.

| Setting | What it does |
| --- | --- |
| `PUBLIC_URL` | The server's public address. Signing links point here unless `APP_URL` says otherwise. |
| `APP_URL` | Where the web app is, if it isn't served by this server. |
| `SIGN_API_KEY` | Needed to send requests; without it, signing is off and only conversion runs. Signers don't need it. |
| `SMTP_URL`, `MAIL_FROM` | How signing emails are sent. Without `SMTP_URL`, emails are printed to the server log instead, which is handy for trying it out. |
| `DATA_DIR` | Where requests, documents and the SQLite database are kept (`/data` in Docker; back it up). |
| `ALLOWED_ORIGIN` | The web app's origin, if it's served from somewhere else (CORS). |
| `TRUST_PROXY` | Set to `1` behind a reverse proxy so signers' real IP addresses are recorded. |
| `CHROMIUM`, `CHROMIUM_NO_SANDBOX` | Chromium for saving web pages (set in the Docker image). Saving web pages needs the API key too. |
| `CAPTURE_ALLOW_PRIVATE` | Set to `1` to allow saving pages on private networks, such as an intranet. Off by default so the server can't be used to reach internal addresses. |
| `MAX_MB`, `TIMEOUT_S`, `CONCURRENCY` | Limits on document size, conversion time and parallel conversions. |

To run it without Docker: install LibreOffice (for conversion), then `cd server && npm install && SIGN_API_KEY=... npm start`, and build the web app with `VITE_SERVER_URL=http://your-server npm run build`. The desktop app converts Office files with LibreOffice installed on the computer instead (found on the PATH or in its usual folder, or set `PAGERIG_SOFFICE`), and saves web pages with the Chrome, Edge or Chromium installed there (or set `PAGERIG_CHROMIUM`).

How signing works: each signer's link carries a random token, of which the server keeps only a hash. Signers agree to sign electronically before finishing, and the server records when each person was emailed, opened, signed or declined, with their IP address and browser. When everyone has signed, it draws the entries into the PDF, adds a certificate page, and keeps the SHA-256 fingerprint of the result, so anyone can later check a copy is unchanged (`POST /api/verify`). This is a standard electronic signature with an audit trail, which is legally recognised for most documents in the US, UK and EU; it is not a certificate-based digital signature.

Converting PDF to Word or PowerPoint keeps text editable but places it in positioned boxes, so complex layouts can need tidying. PDF to Excel isn't supported yet.

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
| `src/lib/signing.ts` | Talking to the server's signing service; turning placed fields into a request. |
| `src/components/SignRequests.tsx`, `SignPage.tsx` | Sending, tracking and templates; the page signers use. |
| `src/lib/platform.ts` | Opening and saving files in the browser vs. the desktop app. |
| `src/components/` | Thumbnails, page canvas, the on-page overlay, the Fill & sign toolbar and dialogs. |
| `src/lib/capture.ts` | Saving web pages as PDF, on the desktop or through the server. |
| `src-tauri/` | The Tauri desktop shell, including the LibreOffice command (`src/office.rs`) and web page capture (`src/capture.rs`). |
| `server/` | The PageRig server: Office conversion, the signing service (`sign/`: storage, email, the signed PDF and certificate) and its Dockerfile. |

Keyboard shortcuts: Ctrl/Cmd + O open, S save, F search, Z undo, Shift+Z or Y redo, A select all, +/- zoom. Delete removes the selected object, or the selected pages. Esc returns to the Select tool.

Added and edited text uses the standard PDF fonts (Helvetica, Times, Courier), which cover Western European languages; other characters are saved as "?" for now.

import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { PDFDocument, EncryptedPDFError } from "pdf-lib";
import {
  addSource,
  cropPages,
  deletePages,
  emptyDoc,
  insertBlank,
  movePages,
  newId,
  rotatePages,
  setOcr,
  type DocState,
  type Source,
} from "./lib/document";
import { exportGroups, exportPdf } from "./lib/export";
import { pickPdfs, readBrowserFiles, savePdf, savePdfs, type PickedFile } from "./lib/platform";
import { displaySize, inspectPdf, pageFrame, registerSource, searchDoc, sourceFieldNames, type SearchHit } from "./lib/render";
import {
  addObject,
  makeObject,
  removeObject,
  rotateVec,
  setFieldValue,
  uniqueFieldName,
  updateObject,
  type FieldObject,
  type ImageObject,
  type MarkObject,
  type PageObject,
  type RectObject,
  type TextObject,
  TEXT_PAD,
} from "./lib/objects";
import { recognizePage } from "./lib/ocr";
import { useHistory } from "./lib/useHistory";
import { Thumbnails } from "./components/Thumbnails";
import { PageCanvas } from "./components/PageCanvas";
import { CropDialog, SplitDialog } from "./components/Dialogs";
import { PageOverlay, sizeText, type OverlayHandlers } from "./components/PageOverlay";
import { imageSize, readImageFile, SignatureDialog, type SignatureRole } from "./components/SignatureDialog";
import { STAMPS, ToolBar, type Stamp, type Tool } from "./components/ToolBar";

const PX_PER_PT = 96 / 72;
const ZOOM_STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4];

type Dialog = null | "crop" | "split";

const SIG_KEYS: Record<SignatureRole, string> = { signature: "pagerig.signature", initials: "pagerig.initials" };

function loadSaved(role: SignatureRole): string | null {
  try {
    return localStorage.getItem(SIG_KEYS[role]);
  } catch {
    return null;
  }
}

function storeSaved(role: SignatureRole, url: string) {
  try {
    localStorage.setItem(SIG_KEYS[role], url);
  } catch {
    // Storage can be unavailable (private windows); the signature still works for this session.
  }
}

export default function App() {
  const history = useHistory<DocState>(emptyDoc);
  const doc = history.state;
  const [docName, setDocName] = useState("document.pdf");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [anchor, setAnchor] = useState<string | null>(null);
  const [current, setCurrent] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [fit, setFit] = useState(true);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ kind: "error" | "info"; text: string } | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [tool, setTool] = useState<Tool>("select");
  const [stamp, setStamp] = useState<Stamp>(STAMPS[0]);
  const [picked, setPicked] = useState<{ pageId: string; objId: string } | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [signatures, setSignatures] = useState<Record<SignatureRole, string | null>>(() => ({
    signature: loadSaved("signature"),
    initials: loadSaved("initials"),
  }));
  const [sigDialog, setSigDialog] = useState<SignatureRole | null>(null);
  const [pendingImage, setPendingImage] = useState<string | null>(null);
  const [takenNames, setTakenNames] = useState<Set<string>>(new Set());

  const viewerRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const pageEls = useRef(new Map<string, HTMLDivElement>());

  const hasDoc = doc.pages.length > 0;
  const selectedPages = useMemo(() => doc.pages.filter((p) => selected.has(p.id)), [doc.pages, selected]);
  const lastSelectedIndex = useMemo(() => {
    let last = -1;
    doc.pages.forEach((p, i) => selected.has(p.id) && (last = i));
    return last;
  }, [doc.pages, selected]);

  // Drop selections that no longer exist (after delete or undo).
  useEffect(() => {
    const ids = new Set(doc.pages.map((p) => p.id));
    setSelected((s) => {
      const next = new Set([...s].filter((id) => ids.has(id)));
      return next.size === s.size ? s : next;
    });
    if (current && !ids.has(current)) setCurrent(doc.pages[0]?.id ?? null);
  }, [doc.pages, current]);

  const flash = useCallback((text: string, kind: "error" | "info" = "info") => {
    setMessage({ kind, text });
  }, []);
  useEffect(() => {
    if (!message) return;
    const t = setTimeout(() => setMessage(null), message.kind === "error" ? 8000 : 3500);
    return () => clearTimeout(t);
  }, [message]);

  // ---- Fill & sign -------------------------------------------------------

  useEffect(() => {
    let live = true;
    sourceFieldNames(doc)
      .then((names) => live && setTakenNames(names))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [doc.sources]);

  const pickedObject = useMemo(() => {
    if (!picked) return null;
    return doc.pages.find((p) => p.id === picked.pageId)?.objects?.find((o) => o.id === picked.objId) ?? null;
  }, [doc.pages, picked]);

  const chooseTool = async (next: Tool) => {
    setPicked(null);
    setEditing(null);
    if ((next === "signature" || next === "initials") && !signatures[next]) {
      setSigDialog(next);
      return;
    }
    if (next === "image") {
      const url = await pickImage();
      if (!url) return;
      setPendingImage(url);
      setTool("image");
      return;
    }
    setTool(next);
  };

  const placeObject = async (pageId: string, x: number, y: number) => {
    const page = doc.pages.find((p) => p.id === pageId);
    if (!page) return;
    const rot = pageFrame(page).rotation;
    const at = { cx: x, cy: y, rot };
    let obj: PageObject | null = null;

    const textObj = (text: string, extra: Partial<TextObject> = {}) => {
      const t = { text, fontSize: 12, color: "#000000", ...extra };
      // Place the text box with its top-left at the click, which feels natural for typing.
      const size = sizeText(t);
      const shift = rotateVec(size.w / 2, size.h / 2, -rot);
      return makeObject<TextObject>({ kind: "text", ...t, ...size, rot, cx: x + shift.x, cy: y + shift.y });
    };

    switch (tool) {
      case "text":
        obj = textObj("Text");
        break;
      case "date":
        obj = textObj(new Date().toLocaleDateString());
        break;
      case "stamp":
        obj = textObj(stamp.text, { stamp: true, color: stamp.color, fontSize: 18 });
        // Stamps are centred on the click.
        obj = { ...obj, cx: x, cy: y };
        break;
      case "check":
      case "cross":
      case "dot":
        obj = makeObject<MarkObject>({ kind: "mark", mark: tool, color: "#000000", w: 14, h: 14, ...at });
        break;
      case "signature":
      case "initials":
      case "image": {
        const src = tool === "image" ? pendingImage : signatures[tool];
        if (!src) return;
        const px = await imageSize(src);
        const width = tool === "signature" ? 150 : tool === "initials" ? 60 : Math.min(240, px.width * 0.75);
        const height = (width * px.height) / px.width;
        obj = makeObject<ImageObject>({ kind: "image", src, role: tool, w: width, h: height, ...at });
        break;
      }
      case "field-text":
        obj = makeObject<FieldObject>({ kind: "field", fieldType: "text", name: uniqueFieldName(doc, "Text", takenNames), w: 150, h: 20, ...at });
        break;
      case "field-checkbox":
        obj = makeObject<FieldObject>({ kind: "field", fieldType: "checkbox", name: uniqueFieldName(doc, "Check", takenNames), w: 14, h: 14, ...at });
        break;
      case "field-dropdown":
        obj = makeObject<FieldObject>({
          kind: "field",
          fieldType: "dropdown",
          name: uniqueFieldName(doc, "Choice", takenNames),
          options: ["Option 1", "Option 2"],
          w: 120,
          h: 20,
          ...at,
        });
        break;
      default:
        return;
    }
    const placed = obj;
    history.set((d) => addObject(d, pageId, placed));
    setPicked({ pageId, objId: placed.id });
    if (tool === "text") setEditing(placed.id);
    // Marks stay active so a column of boxes can be ticked quickly; everything else goes back to Select.
    if (!["check", "cross", "dot"].includes(tool)) setTool("select");
  };

  const overlayHandlers: OverlayHandlers = {
    mode: tool === "select" ? "select" : tool === "edit-text" || tool === "edit-image" ? tool : "place",
    selectedId: picked?.objId ?? null,
    editingId: editing,
    onSelect: (pageId, objId) => setPicked(objId ? { pageId, objId } : null),
    onEdit: setEditing,
    onPlace: placeObject,
    onChange: (pageId, objId, patch) => history.set((d) => updateObject(d, pageId, objId, patch)),
    onRemove: (pageId, objId) => {
      history.set((d) => removeObject(d, pageId, objId));
      setPicked(null);
    },
    onFieldValue: (sourceId, name, value) => history.set((d) => setFieldValue(d, sourceId, name, value)),
    onEditRun: (pageId, run) => {
      // Cover the original words and put an editable copy on top, in the closest standard font.
      const cover = makeObject<RectObject>({
        kind: "rect",
        fill: "#ffffff",
        cx: run.x + run.w / 2,
        cy: run.y + run.h / 2,
        w: run.w + 2,
        h: run.h + 2,
        rot: 0,
      });
      const t = { text: run.text, fontSize: run.fontSize, color: "#000000", font: run.font, bold: run.bold };
      const size = sizeText(t);
      const top = run.baseline - TEXT_PAD - run.fontSize * 0.93;
      const left = run.x - TEXT_PAD;
      const text = makeObject<TextObject>({ kind: "text", ...t, ...size, cx: left + size.w / 2, cy: top + size.h / 2, rot: 0 });
      history.set((d) => addObject(addObject(d, pageId, cover), pageId, text));
      setTool("select");
      setPicked({ pageId, objId: text.id });
      setEditing(text.id);
    },
    onEditImage: async (pageId, region, action) => {
      const cover = makeObject<RectObject>({
        kind: "rect",
        fill: "#ffffff",
        cx: region.x + region.w / 2,
        cy: region.y + region.h / 2,
        // Two points of margin so the old image's anti-aliased edges don't show at small sizes.
        w: region.w + 4,
        h: region.h + 4,
        rot: 0,
      });
      if (action === "remove") {
        history.set((d) => addObject(d, pageId, cover));
        setTool("select");
        setPicked({ pageId, objId: cover.id });
        return;
      }
      const src = await pickImage();
      if (!src) return;
      const px = await imageSize(src);
      // Fit inside the old image's box, keeping the new picture's proportions.
      const k = Math.min(region.w / px.width, region.h / px.height);
      const image = makeObject<ImageObject>({
        kind: "image",
        src,
        role: "image",
        cx: cover.cx,
        cy: cover.cy,
        w: px.width * k,
        h: px.height * k,
        rot: 0,
      });
      history.set((d) => addObject(addObject(d, pageId, cover), pageId, image));
      setTool("select");
      setPicked({ pageId, objId: image.id });
    },
  };

  const runOcr = async () => {
    const ids = targetIds();
    const pages = doc.pages.filter((p) => ids.has(p.id));
    if (pages.length === 0) return;
    try {
      let found = 0;
      for (let i = 0; i < pages.length; i++) {
        const label = pages.length > 1 ? ` page ${i + 1} of ${pages.length}` : "";
        setBusy(`Recognising text${label}…`);
        const lines = await recognizePage(doc, pages[i], (p) => setBusy(`Recognising text${label}… ${Math.round(p * 100)}%`));
        found += lines.length;
        const id = pages[i].id;
        history.set((d) => setOcr(d, id, lines));
      }
      flash(found ? `Recognised ${found} line${found === 1 ? "" : "s"} of text. It is now searchable and editable.` : "No text found");
    } catch (err) {
      flash(`OCR failed: ${err instanceof Error ? err.message : String(err)}`, "error");
    } finally {
      setBusy(null);
    }
  };

  const changePicked = (patch: Partial<PageObject>) => {
    if (!picked || !pickedObject) return;
    let full = patch;
    if (pickedObject.kind === "text" && "fontSize" in patch) {
      full = { ...patch, ...sizeText({ ...pickedObject, ...(patch as Partial<TextObject>) }) };
    }
    history.set((d) => updateObject(d, picked.pageId, picked.objId, full));
  };

  const deletePicked = () => {
    if (!picked) return;
    history.set((d) => removeObject(d, picked.pageId, picked.objId));
    setPicked(null);
  };

  // ---- Loading -----------------------------------------------------------

  const loadFiles = useCallback(async (files: PickedFile[]): Promise<Source[]> => {
    const sources: Source[] = [];
    for (const file of files) {
      try {
        const loaded = await openWithPassword(file);
        if (!loaded) continue;
        const source: Source = {
          id: newId("s"),
          name: file.name,
          bytes: file.bytes,
          pageCount: loaded.info.length,
          encrypted: await isEncrypted(file.bytes),
        };
        registerSource(source, loaded);
        sources.push(source);
      } catch (err) {
        flash(`Couldn't open ${file.name}: ${(err as Error).message}`, "error");
      }
    }
    return sources;
  }, [flash]);

  /** Open replaces the document; add/insert merge into it. */
  const openFiles = useCallback(
    async (files: PickedFile[], mode: "open" | "append" | "insert") => {
      if (files.length === 0) return;
      setBusy("Opening…");
      try {
        const sources = await loadFiles(files);
        if (sources.length === 0) return;
        if (mode === "open" || !hasDoc) {
          let next = emptyDoc;
          for (const s of sources) next = addSource(next, s);
          history.reset(next);
          setDocName(sources[0].name);
          setSelected(new Set());
          setCurrent(next.pages[0]?.id ?? null);
          setHits(null);
          setQuery("");
          viewerRef.current?.scrollTo({ top: 0 });
        } else {
          const at = mode === "insert" && lastSelectedIndex >= 0 ? lastSelectedIndex + 1 : doc.pages.length;
          history.set((d) => {
            let next = d;
            let pos = at;
            for (const s of sources) {
              next = addSource(next, s, pos);
              pos += s.pageCount;
            }
            return next;
          });
          const added = sources.reduce((n, s) => n + s.pageCount, 0);
          flash(`Added ${added} page${added === 1 ? "" : "s"}`);
        }
      } finally {
        setBusy(null);
      }
    },
    [loadFiles, hasDoc, history, lastSelectedIndex, doc.pages.length, flash],
  );

  // ---- Page actions ------------------------------------------------------

  const targetIds = useCallback((): Set<string> => {
    if (selected.size > 0) return selected;
    return current ? new Set([current]) : new Set();
  }, [selected, current]);

  const rotate = (delta: 90 | -90) => {
    const ids = targetIds();
    if (ids.size) history.set((d) => rotatePages(d, ids, delta));
  };

  const remove = () => {
    const ids = targetIds();
    if (ids.size === 0) return;
    if (ids.size >= doc.pages.length) {
      flash("A document needs at least one page", "error");
      return;
    }
    history.set((d) => deletePages(d, ids));
  };

  const addBlank = () => {
    const ref = lastSelectedIndex >= 0 ? doc.pages[lastSelectedIndex] : doc.pages[doc.pages.length - 1];
    const at = lastSelectedIndex >= 0 ? lastSelectedIndex + 1 : doc.pages.length;
    history.set((d) => insertBlank(d, at, ref ? displaySize(ref) : undefined));
  };

  const save = async () => {
    setBusy("Saving…");
    try {
      ensureExportable(doc);
      const ok = await savePdf(editedName(docName), await exportPdf(doc));
      if (ok) flash("Saved");
    } catch (err) {
      flash((err as Error).message, "error");
    } finally {
      setBusy(null);
    }
  };

  const extract = async () => {
    if (selectedPages.length === 0) return;
    setBusy("Extracting…");
    try {
      ensureExportable(doc);
      const bytes = await exportPdf(doc, selectedPages);
      const ok = await savePdf(stem(docName) + "-extract.pdf", bytes);
      if (ok) flash(`Extracted ${selectedPages.length} page${selectedPages.length === 1 ? "" : "s"}`);
    } catch (err) {
      flash((err as Error).message, "error");
    } finally {
      setBusy(null);
    }
  };

  const split = async (groups: number[][]) => {
    setDialog(null);
    setBusy("Splitting…");
    try {
      ensureExportable(doc);
      const files = await exportGroups(doc, groups);
      const pad = String(files.length).length;
      const ok = await savePdfs(
        files.map((bytes, i) => ({ name: `${stem(docName)}-part${String(i + 1).padStart(pad, "0")}.pdf`, bytes })),
      );
      if (ok) flash(`Split into ${files.length} files`);
    } catch (err) {
      flash((err as Error).message, "error");
    } finally {
      setBusy(null);
    }
  };

  // ---- Selection & navigation -------------------------------------------

  const selectPage = (id: string, e: MouseEvent) => {
    if (e.shiftKey && anchor) {
      const a = doc.pages.findIndex((p) => p.id === anchor);
      const b = doc.pages.findIndex((p) => p.id === id);
      const [lo, hi] = a < b ? [a, b] : [b, a];
      setSelected(new Set(doc.pages.slice(lo, hi + 1).map((p) => p.id)));
      return;
    }
    if (e.metaKey || e.ctrlKey) {
      setSelected((s) => {
        const next = new Set(s);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });
    } else {
      setSelected(new Set([id]));
    }
    setAnchor(id);
  };

  const scrollToPage = useCallback((id: string) => {
    const el = pageEls.current.get(id);
    if (el) el.scrollIntoView({ block: "start" });
    setCurrent(id);
  }, []);

  // Track which page is in view.
  const onViewerScroll = () => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    const mid = viewer.getBoundingClientRect().top + viewer.clientHeight / 3;
    let best: string | null = null;
    for (const p of doc.pages) {
      const el = pageEls.current.get(p.id);
      if (!el) continue;
      if (el.getBoundingClientRect().top <= mid) best = p.id;
      else break;
    }
    if (best && best !== current) setCurrent(best);
  };

  // ---- Zoom --------------------------------------------------------------

  const maxPageWidth = useMemo(
    () => doc.pages.reduce((m, p) => Math.max(m, displaySize(p).width), 0) || 612,
    [doc.pages],
  );

  const fitZoom = useCallback(() => {
    const w = viewerRef.current?.clientWidth ?? 800;
    return Math.max(0.1, (w - 64) / (maxPageWidth * PX_PER_PT));
  }, [maxPageWidth]);

  useEffect(() => {
    if (!fit) return;
    const update = () => setZoom(fitZoom());
    update();
    const ro = new ResizeObserver(update);
    if (viewerRef.current) ro.observe(viewerRef.current);
    return () => ro.disconnect();
  }, [fit, fitZoom, hasDoc]);

  const stepZoom = (dir: 1 | -1) => {
    setFit(false);
    setZoom((z) => {
      const next = dir > 0 ? ZOOM_STEPS.find((s) => s > z + 0.001) : [...ZOOM_STEPS].reverse().find((s) => s < z - 0.001);
      return next ?? z;
    });
  };

  // ---- Search ------------------------------------------------------------

  useEffect(() => {
    if (!query.trim() || !hasDoc) {
      setHits(null);
      return;
    }
    let cancelled = false;
    setSearching(true);
    const t = setTimeout(() => {
      searchDoc(doc, query, () => cancelled)
        .then((h) => !cancelled && setHits(h))
        .catch((err) => !cancelled && flash(`Search failed: ${(err as Error).message}`, "error"))
        .finally(() => !cancelled && setSearching(false));
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [query, doc, hasDoc, flash]);

  const hitIds = useMemo(() => new Set(hits?.map((h) => h.pageId)), [hits]);

  // ---- Keyboard shortcuts -----------------------------------------------

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      const inField = (e.target as HTMLElement)?.matches?.("input, textarea, select");
      if (mod && e.key.toLowerCase() === "o") {
        e.preventDefault();
        pickPdfs().then((f) => openFiles(f, "open"));
      } else if (mod && e.key.toLowerCase() === "s" && hasDoc) {
        e.preventDefault();
        save();
      } else if (mod && e.key.toLowerCase() === "f" && hasDoc) {
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      } else if (inField || dialog) {
        return;
      } else if (mod && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) history.redo();
        else history.undo();
      } else if (mod && e.key.toLowerCase() === "y") {
        e.preventDefault();
        history.redo();
      } else if (mod && e.key.toLowerCase() === "a" && hasDoc) {
        e.preventDefault();
        setSelected(new Set(doc.pages.map((p) => p.id)));
      } else if ((e.key === "Delete" || e.key === "Backspace") && picked) {
        e.preventDefault();
        deletePicked();
      } else if ((e.key === "Delete" || e.key === "Backspace") && selected.size > 0) {
        e.preventDefault();
        remove();
      } else if (e.key === "Escape") {
        if (tool !== "select" || picked) {
          setTool("select");
          setPicked(null);
        } else setSelected(new Set());
      } else if (mod && (e.key === "=" || e.key === "+")) {
        e.preventDefault();
        stepZoom(1);
      } else if (mod && e.key === "-") {
        e.preventDefault();
        stepZoom(-1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // ---- Drag and drop files ----------------------------------------------

  const onDrop = async (e: React.DragEvent) => {
    if (!e.dataTransfer.files.length) return;
    e.preventDefault();
    setDragOver(false);
    const files = await readBrowserFiles(e.dataTransfer.files);
    if (files.length === 0) flash("Only PDF files can be opened", "error");
    else openFiles(files, hasDoc ? "append" : "open");
  };

  // ---- Render ------------------------------------------------------------

  const currentIndex = doc.pages.findIndex((p) => p.id === current);
  const sel = selected.size;
  const target = sel || (current ? 1 : 0);

  return (
    <div
      className={`app${dragOver ? " drag-over" : ""}`}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes("Files")) {
          e.preventDefault();
          setDragOver(true);
        }
      }}
      onDragLeave={(e) => e.currentTarget === e.target && setDragOver(false)}
      onDrop={onDrop}
    >
      <header className="toolbar">
        <div className="brand">
          <img src="/favicon.svg" alt="" width={20} height={20} />
          PageRig
        </div>
        <button onClick={() => pickPdfs().then((f) => openFiles(f, "open"))} title="Open (Ctrl+O)">
          Open
        </button>
        <button disabled={!hasDoc} onClick={() => pickPdfs().then((f) => openFiles(f, "append"))} title="Merge other PDFs onto the end">
          Merge files
        </button>
        <button className="primary" disabled={!hasDoc} onClick={save} title="Save (Ctrl+S)">
          Save
        </button>
        <span className="sep" />
        <button disabled={!history.canUndo} onClick={history.undo} title="Undo (Ctrl+Z)" aria-label="Undo">
          ↶
        </button>
        <button disabled={!history.canRedo} onClick={history.redo} title="Redo (Ctrl+Shift+Z)" aria-label="Redo">
          ↷
        </button>
        <span className="sep" />
        <button disabled={!hasDoc} onClick={() => stepZoom(-1)} aria-label="Zoom out" title="Zoom out">
          −
        </button>
        <span className="zoom-label">{Math.round(zoom * 100)}%</span>
        <button disabled={!hasDoc} onClick={() => stepZoom(1)} aria-label="Zoom in" title="Zoom in">
          +
        </button>
        <button disabled={!hasDoc} className={fit ? "active" : ""} onClick={() => setFit(true)}>
          Fit width
        </button>
        <span className="spacer" />
        {hasDoc && (
          <span className="page-nav">
            Page{" "}
            <input
              aria-label="Current page"
              value={currentIndex + 1}
              onChange={(e) => {
                const n = Number(e.target.value);
                if (n >= 1 && n <= doc.pages.length) scrollToPage(doc.pages[n - 1].id);
              }}
              type="number"
              min={1}
              max={doc.pages.length}
            />{" "}
            of {doc.pages.length}
          </span>
        )}
        <input
          ref={searchRef}
          className="search"
          type="search"
          placeholder="Search text (Ctrl+F)"
          value={query}
          disabled={!hasDoc}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && hits?.[0] && scrollToPage(hits[0].pageId)}
        />
      </header>
      {hasDoc && (
        <ToolBar
          tool={tool}
          onTool={chooseTool}
          stamp={stamp}
          onStamp={setStamp}
          hasSignature={{ signature: !!signatures.signature, initials: !!signatures.initials }}
          onRedoSignature={setSigDialog}
          selected={pickedObject}
          onChange={changePicked}
          onDelete={deletePicked}
          onOcr={runOcr}
        />
      )}

      {!hasDoc ? (
        <main className="empty">
          <div className="drop-card">
            <h1>Open a PDF to get started</h1>
            <p>Drop PDF files anywhere in this window, or choose them from your computer. Dropping several merges them.</p>
            <button className="primary big" onClick={() => pickPdfs().then((f) => openFiles(f, "open"))}>
              Choose PDF files
            </button>
          </div>
        </main>
      ) : (
        <div className="workspace">
          <aside className="sidebar">
            <div className="page-actions" role="toolbar" aria-label="Page actions">
              <div className="selection-label">
                {sel ? `${sel} selected` : current ? `Page ${currentIndex + 1}` : ""}
                {sel > 0 && (
                  <button className="link" onClick={() => setSelected(new Set())}>
                    Clear
                  </button>
                )}
              </div>
              <button disabled={!target} onClick={() => rotate(-90)} title="Rotate left">⟲ Left</button>
              <button disabled={!target} onClick={() => rotate(90)} title="Rotate right">⟳ Right</button>
              <button disabled={!target} onClick={() => setDialog("crop")}>Crop</button>
              <button disabled={!target} onClick={remove} title="Delete (Del)">Delete</button>
              <button onClick={addBlank} title="Insert a blank page after the selection">+ Blank</button>
              <button onClick={() => pickPdfs().then((f) => openFiles(f, "insert"))} title="Insert pages from another PDF after the selection">
                + From file
              </button>
              <button disabled={!sel} onClick={extract} title="Save the selected pages as a new PDF">Extract</button>
              <button disabled={doc.pages.length < 2} onClick={() => setDialog("split")}>Split…</button>
            </div>
            <Thumbnails
              doc={doc}
              selected={selected}
              current={current}
              onSelect={selectPage}
              onOpen={scrollToPage}
              onMove={(ids, to) => history.set((d) => movePages(d, ids, to))}
            />
            <p className="hint">Drag to reorder. Shift or Ctrl-click to select several.</p>
          </aside>

          <main className="viewer" ref={viewerRef} onScroll={onViewerScroll}>
            {doc.pages.map((page, i) => {
              const w = Math.round(displaySize(page).width * zoom * PX_PER_PT);
              return (
                <div
                  key={page.id}
                  ref={(el) => {
                    if (el) pageEls.current.set(page.id, el);
                    else pageEls.current.delete(page.id);
                  }}
                  className={`page${hitIds.has(page.id) ? " hit" : ""}${selected.has(page.id) ? " selected" : ""}`}
                  data-testid="page"
                >
                  <PageCanvas doc={doc} page={page} width={w}>
                    <PageOverlay doc={doc} page={page} scale={w / displaySize(page).width} handlers={overlayHandlers} />
                  </PageCanvas>
                  <div className="page-number">{i + 1}</div>
                </div>
              );
            })}
          </main>

          {hits !== null && (
            <aside className="results" aria-label="Search results">
              <div className="results-head">
                {searching
                  ? "Searching…"
                  : hits.length === 0
                    ? "No matches"
                    : `${hits.reduce((n, h) => n + h.count, 0)} matches on ${hits.length} page${hits.length === 1 ? "" : "s"}`}
                <button className="link" onClick={() => setQuery("")}>
                  Close
                </button>
              </div>
              <ul>
                {hits.map((h) => (
                  <li key={h.pageId}>
                    <button onClick={() => scrollToPage(h.pageId)}>
                      <strong>Page {h.pageNumber}</strong>
                      <span>{highlight(h.snippet, query)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </aside>
          )}
        </div>
      )}

      {dialog === "crop" && (
        <CropDialog
          doc={doc}
          page={doc.pages.find((p) => targetIds().has(p.id))!}
          count={targetIds().size}
          onClose={() => setDialog(null)}
          onApply={(crop) => {
            const ids = targetIds();
            history.set((d) => cropPages(d, ids, crop));
            setDialog(null);
          }}
        />
      )}
      {dialog === "split" && (
        <SplitDialog pageCount={doc.pages.length} onSplit={split} onClose={() => setDialog(null)} />
      )}

      {sigDialog && (
        <SignatureDialog
          role={sigDialog}
          onClose={() => setSigDialog(null)}
          onDone={(url, remember) => {
            if (remember) storeSaved(sigDialog, url);
            setSignatures((s) => ({ ...s, [sigDialog]: url }));
            setTool(sigDialog);
            setSigDialog(null);
          }}
        />
      )}

      {busy && <div className="busy">{busy}</div>}
      {message && (
        <div className={`toast ${message.kind}`} role={message.kind === "error" ? "alert" : "status"}>
          {message.text}
        </div>
      )}
      {dragOver && <div className="drop-overlay">Drop PDFs to {hasDoc ? "merge them in" : "open"}</div>}
    </div>
  );
}

async function openWithPassword(file: PickedFile) {
  let password: string | undefined;
  for (;;) {
    try {
      return await inspectPdf(file.bytes, password);
    } catch (err) {
      if ((err as Error).name !== "PasswordException") throw err;
      const entered = window.prompt(
        password === undefined ? `${file.name} is password protected. Enter the password:` : "Wrong password. Try again:",
      );
      if (entered === null) return null;
      password = entered;
    }
  }
}

async function isEncrypted(bytes: Uint8Array): Promise<boolean> {
  try {
    await PDFDocument.load(bytes, { updateMetadata: false });
    return false;
  } catch (err) {
    if (err instanceof EncryptedPDFError) return true;
    throw err;
  }
}

function ensureExportable(doc: DocState) {
  const locked = Object.values(doc.sources).find((s) => s.encrypted);
  if (locked) {
    throw new Error(
      `${locked.name} is encrypted. PageRig can view it, but saving encrypted files arrives with the security tools.`,
    );
  }
}

function stem(name: string) {
  return name.replace(/\.pdf$/i, "");
}

function editedName(name: string) {
  return `${stem(name)}-edited.pdf`;
}

function highlight(text: string, query: string) {
  const q = query.trim();
  if (!q) return text;
  const parts = text.split(new RegExp(`(${q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "ig"));
  return parts.map((part, i) => (i % 2 === 1 ? <mark key={i}>{part}</mark> : part));
}


/** Ask for an image file; resolves to a PNG/JPEG data URL, or null if cancelled. */
function pickImage(): Promise<string | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/png,image/jpeg,image/webp";
    input.onchange = () => readImageFile(input.files?.[0]).then(resolve, () => resolve(null));
    input.oncancel = () => resolve(null);
    input.click();
  });
}

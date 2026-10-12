import { useEffect, useRef, useState, type CSSProperties, type PointerEvent } from "react";
import type { DocState, PageRef } from "../lib/document";
import {
  LINE_HEIGHT,
  MARK_GLYPHS,
  TEXT_PAD,
  fromDisplay,
  measureText,
  rotateVec,
  screenAngle,
  toDisplay,
  type FieldValue,
  type PageFrame,
  type PageObject,
  type TextObject,
} from "../lib/objects";
import { formWidgets, pageFrame, type FormWidget } from "../lib/render";

export interface OverlayHandlers {
  /** A placement tool is active; clicks on the page call onPlace. */
  placing: boolean;
  selectedId: string | null;
  editingId: string | null;
  onSelect: (pageId: string, objId: string | null) => void;
  onEdit: (objId: string | null) => void;
  onPlace: (pageId: string, x: number, y: number) => void;
  onChange: (pageId: string, objId: string, patch: Partial<PageObject>) => void;
  onRemove: (pageId: string, objId: string) => void;
  onFieldValue: (sourceId: string, name: string, value: FieldValue) => void;
}

interface Props {
  doc: DocState;
  page: PageRef;
  /** CSS pixels per PDF point. */
  scale: number;
  /** Thumbnails show objects but don't react to the mouse. */
  handlers?: OverlayHandlers;
}

/** Placed objects and fillable form fields, drawn on top of a rendered page. */
export function PageOverlay({ doc, page, scale, handlers }: Props) {
  const frame = pageFrame(page);
  const widgets = useWidgets(doc, page);
  const interactive = !!handlers;

  const onBackgroundPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (!handlers || e.target !== e.currentTarget) return;
    if (handlers.placing) {
      // Keep focus where it lands next (e.g. the new text box) instead of on the page.
      e.preventDefault();
      const rect = e.currentTarget.getBoundingClientRect();
      const p = fromDisplay(frame, (e.clientX - rect.left) / scale, (e.clientY - rect.top) / scale);
      handlers.onPlace(page.id, p.x, p.y);
    } else {
      handlers.onSelect(page.id, null);
    }
  };

  return (
    <div
      className={`overlay${interactive ? " interactive" : ""}${handlers?.placing ? " placing" : ""}`}
      onPointerDown={onBackgroundPointerDown}
    >
      {widgets.map((w) => (
        <Widget key={w.id} doc={doc} page={page} widget={w} frame={frame} scale={scale} handlers={handlers} />
      ))}
      {(page.objects ?? []).map((o) => (
        <ObjectView key={o.id} page={page} obj={o} frame={frame} scale={scale} handlers={handlers} />
      ))}
    </div>
  );
}

function useWidgets(doc: DocState, page: PageRef) {
  const [widgets, setWidgets] = useState<FormWidget[]>([]);
  const source = page.sourceId ? doc.sources[page.sourceId] : null;
  useEffect(() => {
    let live = true;
    formWidgets(doc, page)
      .then((w) => live && setWidgets(w))
      .catch(() => live && setWidgets([]));
    return () => {
      live = false;
    };
    // Widgets depend only on which source page this is.
  }, [source, page.sourceIndex]);
  return widgets;
}

// ---- Placed objects --------------------------------------------------------

interface ObjectProps {
  page: PageRef;
  obj: PageObject;
  frame: PageFrame;
  scale: number;
  handlers?: OverlayHandlers;
}

type Gesture = { kind: "move" | "resize"; startX: number; startY: number; dx: number; dy: number };

function ObjectView({ page, obj, frame, scale: s, handlers }: ObjectProps) {
  const [gesture, setGesture] = useState<Gesture | null>(null);
  const selected = handlers?.selectedId === obj.id;
  const editing = handlers?.editingId === obj.id && obj.kind === "text";
  const angle = screenAngle(frame, obj);

  // Live geometry while dragging; committed to the document on release.
  let { cx, cy, w, h } = obj;
  if (gesture) ({ cx, cy, w, h } = applyGesture(obj, frame, gesture, s));
  const centre = toDisplay(frame, cx, cy);

  const style: CSSProperties = {
    left: centre.x * s - (w * s) / 2,
    top: centre.y * s - (h * s) / 2,
    width: w * s,
    height: h * s,
    transform: angle ? `rotate(${angle}deg)` : undefined,
  };

  const start = (kind: Gesture["kind"]) => (e: PointerEvent) => {
    if (!handlers || handlers.placing || editing) return;
    e.stopPropagation();
    handlers.onSelect(page.id, obj.id);
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    setGesture({ kind, startX: e.clientX, startY: e.clientY, dx: 0, dy: 0 });
  };
  const move = (e: PointerEvent) => {
    if (gesture) setGesture({ ...gesture, dx: e.clientX - gesture.startX, dy: e.clientY - gesture.startY });
  };
  const end = () => {
    if (!gesture || !handlers) return;
    if (Math.abs(gesture.dx) + Math.abs(gesture.dy) > 2) {
      const next = applyGesture(obj, frame, gesture, s);
      const patch: Partial<PageObject> = { ...next };
      if (obj.kind === "text" && gesture.kind === "resize") {
        // Resizing text scales the font.
        (patch as Partial<TextObject>).fontSize = Math.max(4, Math.round(obj.fontSize * (next.h / obj.h) * 2) / 2);
      }
      handlers.onChange(page.id, obj.id, patch);
    }
    setGesture(null);
  };

  return (
    <div
      className={`obj obj-${obj.kind}${selected ? " selected" : ""}${obj.kind === "text" && obj.stamp ? " stamp" : ""}`}
      style={style}
      data-testid="object"
      onPointerDown={start("move")}
      onPointerMove={move}
      onPointerUp={end}
      onDoubleClick={() => obj.kind === "text" && handlers?.onEdit(obj.id)}
    >
      <ObjectBody obj={obj} scale={s} editing={editing} page={page} handlers={handlers} />
      {selected && !editing && (
        <div
          className="resize-handle"
          onPointerDown={start("resize")}
          onPointerMove={move}
          onPointerUp={end}
          aria-label="Resize"
        />
      )}
    </div>
  );
}

function ObjectBody({ obj, scale: s, editing, page, handlers }: { obj: PageObject; scale: number; editing: boolean; page: PageRef; handlers?: OverlayHandlers }) {
  switch (obj.kind) {
    case "text": {
      const style: CSSProperties = {
        fontSize: obj.fontSize * s,
        lineHeight: LINE_HEIGHT,
        padding: TEXT_PAD * s,
        color: obj.color,
        borderColor: obj.color,
      };
      if (editing && handlers) {
        return <TextEditor obj={obj} style={style} onDone={(text) => commitText(page, obj, text, handlers)} />;
      }
      return (
        <div className="obj-text-body" style={style}>
          {obj.stamp ? obj.text.toUpperCase() : obj.text}
        </div>
      );
    }
    case "image":
      return <img src={obj.src} alt={obj.role} draggable={false} />;
    case "mark":
      return (
        <span className="obj-mark-body" style={{ fontSize: Math.min(obj.w, obj.h) * 0.9 * s, color: obj.color }}>
          {MARK_GLYPHS[obj.mark]}
        </span>
      );
    case "field":
      return (
        <div className="obj-field-body" style={{ fontSize: Math.max(6, Math.min(11, obj.h * 0.55) * s) }}>
          {obj.fieldType === "checkbox" ? "" : obj.name}
          {obj.fieldType === "dropdown" && <span className="caret">▾</span>}
        </div>
      );
  }
}

function TextEditor({ obj, style, onDone }: { obj: TextObject; style: CSSProperties; onDone: (text: string) => void }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [value, setValue] = useState(obj.text);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  return (
    <textarea
      ref={ref}
      className="obj-text-editor"
      style={{ ...style, textTransform: obj.stamp ? "uppercase" : undefined }}
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => onDone(value)}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Escape" || (e.key === "Enter" && (e.metaKey || e.ctrlKey))) ref.current?.blur();
      }}
      aria-label="Text"
    />
  );
}

let measureCtx: CanvasRenderingContext2D | null = null;
/** Width of a line of text in points at the given font size (canvas px == pt here). */
export function textWidth(text: string, fontSize: number, bold = false): number {
  measureCtx ??= document.createElement("canvas").getContext("2d");
  if (!measureCtx) return text.length * fontSize * 0.55;
  measureCtx.font = `${bold ? "bold " : ""}${fontSize}px Helvetica, Arial, sans-serif`;
  return measureCtx.measureText(text).width;
}

export function sizeText(obj: Pick<TextObject, "text" | "fontSize" | "stamp">) {
  const text = obj.stamp ? obj.text.toUpperCase() : obj.text;
  const size = measureText(text, obj.fontSize, (l) => textWidth(l, obj.fontSize, obj.stamp));
  return obj.stamp ? { w: size.w + obj.fontSize, h: size.h + obj.fontSize * 0.4 } : size;
}

function commitText(page: PageRef, obj: TextObject, text: string, handlers: OverlayHandlers) {
  handlers.onEdit(null);
  if (!text.trim()) {
    handlers.onRemove(page.id, obj.id);
    return;
  }
  if (text === obj.text) return;
  // Grow or shrink from the top-left corner so the text doesn't jump.
  const size = sizeText({ ...obj, text });
  const shift = rotateVec((size.w - obj.w) / 2, (size.h - obj.h) / 2, -obj.rot);
  handlers.onChange(page.id, obj.id, { text, ...size, cx: obj.cx + shift.x, cy: obj.cy + shift.y });
}

/** New centre and size of an object after a drag of (dx, dy) screen pixels. */
function applyGesture(obj: PageObject, frame: PageFrame, g: Gesture, s: number) {
  if (g.kind === "move") {
    const d = rotateVec(g.dx / s, g.dy / s, -frame.rotation);
    return { cx: obj.cx + d.x, cy: obj.cy + d.y, w: obj.w, h: obj.h };
  }
  // Resize from the bottom-right corner in the object's own frame, keeping the top-left fixed.
  const angle = screenAngle(frame, obj);
  const local = rotateVec(g.dx / s, g.dy / s, -angle);
  let w = Math.max(6, obj.w + local.x);
  let h = Math.max(6, obj.h + local.y);
  if (obj.kind === "image" || obj.kind === "mark" || obj.kind === "text") {
    const k = Math.max(w / obj.w, h / obj.h);
    w = obj.w * k;
    h = obj.h * k;
  }
  const shiftScreen = rotateVec((w - obj.w) / 2, (h - obj.h) / 2, angle);
  const shift = rotateVec(shiftScreen.x, shiftScreen.y, -frame.rotation);
  return { cx: obj.cx + shift.x, cy: obj.cy + shift.y, w, h };
}

// ---- Existing form fields -------------------------------------------------

interface WidgetProps {
  doc: DocState;
  page: PageRef;
  widget: FormWidget;
  frame: PageFrame;
  scale: number;
  handlers?: OverlayHandlers;
}

function Widget({ doc, page, widget: w, frame, scale: s, handlers }: WidgetProps) {
  const a = toDisplay(frame, w.x, w.y);
  const b = toDisplay(frame, w.x + w.w, w.y + w.h);
  const left = Math.min(a.x, b.x) * s;
  const top = Math.min(a.y, b.y) * s;
  const width = Math.abs(b.x - a.x) * s;
  const height = Math.abs(b.y - a.y) * s;
  const stored = page.sourceId ? doc.fieldValues[page.sourceId]?.[w.name] : undefined;
  const value = stored ?? w.value;
  const fontSize = Math.max(6, (w.fontSize || Math.min(12, w.h * 0.65)) * s);
  const style: CSSProperties = { left, top, width, height, fontSize };
  const set = (v: FieldValue) => page.sourceId && handlers?.onFieldValue(page.sourceId, w.name, v);
  const disabled = !handlers || w.readOnly || handlers.placing;
  const common = { className: `field field-${w.type}`, style, disabled, title: w.name, "aria-label": w.name };

  switch (w.type) {
    case "text":
      return w.multiline ? (
        <textarea {...common} value={String(value)} onChange={(e) => set(e.target.value)} />
      ) : (
        <input {...common} type="text" value={String(value)} onChange={(e) => set(e.target.value)} />
      );
    case "checkbox":
      return <input {...common} type="checkbox" checked={value === true} onChange={(e) => set(e.target.checked)} />;
    case "radio":
      return (
        <input
          {...common}
          type="radio"
          name={`${page.id}:${w.name}`}
          checked={value === w.exportValue}
          onChange={() => w.exportValue && set(w.exportValue)}
        />
      );
    case "dropdown":
    case "list":
      return (
        <select {...common} value={String(value)} onChange={(e) => set(e.target.value)}>
          <option value="" />
          {w.options?.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      );
    default:
      return null;
  }
}

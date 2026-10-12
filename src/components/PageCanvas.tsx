import { useEffect, useRef, useState } from "react";
import type { DocState, PageRef } from "../lib/document";
import { displaySize, renderPage } from "../lib/render";

interface Props {
  doc: DocState;
  page: PageRef;
  width: number;
  /** Extra margin around the viewport in which pages start rendering early. */
  rootMargin?: string;
}

/** A page that renders itself only once it scrolls near the viewport. */
export function PageCanvas({ doc, page, width, rootMargin = "600px" }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [visible, setVisible] = useState(false);
  const [rendered, setRendered] = useState(false);
  const size = displaySize(page);
  const height = (width * size.height) / size.width;
  const source = page.sourceId ? doc.sources[page.sourceId] : null;

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const io = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting), { rootMargin });
    io.observe(el);
    return () => io.disconnect();
  }, [rootMargin]);

  useEffect(() => {
    if (!visible || !canvasRef.current) return;
    let cancelled = false;
    // Debounce so zooming doesn't queue a render per step.
    const timer = setTimeout(() => {
      renderPage(doc, page, canvasRef.current!, width, () => cancelled)
        .then(() => !cancelled && setRendered(true))
        .catch((err) => !cancelled && console.error("Render failed", err));
    }, 60);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // Page refs are immutable, so identity tells us when to re-render.
  }, [visible, page, width, source]);

  return (
    <div ref={wrapRef} className="page-canvas" style={{ width, height }}>
      {!rendered && <div className="page-placeholder" />}
      <canvas ref={canvasRef} style={{ width, height, display: rendered ? "block" : "none" }} />
    </div>
  );
}

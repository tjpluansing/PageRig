import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { pagesForSource, type DocState, type PageRef } from "../lib/document";
import { SIGN_FIELD_LABELS, screenAngle, toDisplay } from "../lib/objects";
import { displaySize, inspectPdf, pageFrame, registerSource } from "../lib/render";
import { asPngDataUrl, signer, type FieldEntry, type SignerField, type SignerView } from "../lib/signing";
import { PageCanvas } from "./PageCanvas";
import { SignatureDialog, type SignatureRole } from "./SignatureDialog";

type Phase = { kind: "loading" } | { kind: "error"; text: string } | { kind: "ready" } | { kind: "done"; completed: boolean } | { kind: "declined" };

/** The page a signer lands on from their emailed link. */
export function SignPage({ token }: { token: string }) {
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  const [view, setView] = useState<SignerView | null>(null);
  const [doc, setDoc] = useState<DocState | null>(null);
  const [values, setValues] = useState<Record<string, FieldEntry>>({});
  const [ink, setInk] = useState<Record<SignatureRole, string | null>>({ signature: null, initials: null });
  const [drawing, setDrawing] = useState<{ role: SignatureRole; fieldId: string } | null>(null);
  const [consent, setConsent] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [width, setWidth] = useState(() => Math.min(860, window.innerWidth - 32));
  const fieldEls = useRef(new Map<string, HTMLElement>());

  useEffect(() => {
    document.title = "Sign · PageRig";
    const onResize = () => setWidth(Math.min(860, window.innerWidth - 32));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const v = await signer.view(token);
        setView(v);
        if (v.status !== "sent" || v.signer.status === "signed" || v.signer.status === "declined") {
          setPhase(v.signer.status === "signed" || v.status === "completed" ? { kind: "done", completed: v.status === "completed" } : { kind: "ready" });
        }
        const bytes = await signer.pdf(token);
        const loaded = await inspectPdf(bytes);
        const source = { id: "signing", name: `${v.title}.pdf`, bytes, pageCount: loaded.info.length };
        registerSource(source, loaded);
        setDoc({ sources: { [source.id]: source }, pages: pagesForSource(source), fieldValues: {} });
        // Dates fill themselves in with today's date, and names with the signer's name.
        const today = new Date().toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" });
        const initial: Record<string, FieldEntry> = {};
        for (const f of v.fields) {
          if (f.type === "date") initial[f.id] = today;
          if (f.type === "name") initial[f.id] = v.signer.name;
        }
        setValues(initial);
        setPhase((p) => (p.kind === "loading" ? { kind: "ready" } : p));
      } catch (err) {
        setPhase({ kind: "error", text: (err as Error).message });
      }
    })();
  }, [token]);

  const open = view && view.status === "sent" && (view.signer.status === "sent" || view.signer.status === "viewed") && phase.kind === "ready";
  const fieldsByPage = useMemo(() => {
    const map = new Map<number, SignerField[]>();
    for (const f of view?.fields ?? []) map.set(f.page, [...(map.get(f.page) ?? []), f]);
    return map;
  }, [view]);
  const isFilled = (f: SignerField) => !!values[f.id];
  const missing = (view?.fields ?? []).filter((f) => f.required && !isFilled(f));

  const fill = async (f: SignerField) => {
    if (!open) return;
    if (f.type === "signature" || f.type === "initials") {
      if (values[f.id]) return setValues({ ...values, [f.id]: "" });
      const saved = ink[f.type];
      if (saved) setValues({ ...values, [f.id]: saved });
      else setDrawing({ role: f.type, fieldId: f.id });
    } else if (f.type === "checkbox") setValues({ ...values, [f.id]: !values[f.id] });
  };

  const nextField = () => {
    const f = missing[0];
    if (f) fieldEls.current.get(f.id)?.scrollIntoView({ behavior: "smooth", block: "center" });
  };

  const finish = async () => {
    setSending(true);
    setError(null);
    try {
      const res = await signer.sign(token, values);
      setPhase({ kind: "done", completed: res.status === "completed" });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSending(false);
    }
  };

  const decline = async () => {
    const reason = window.prompt("Decline to sign? The sender will be told. Reason (optional):");
    if (reason === null) return;
    try {
      await signer.decline(token, reason);
      setPhase({ kind: "declined" });
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const downloadSigned = async () => {
    try {
      const bytes = await signer.pdf(token);
      const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: "application/pdf" }));
      const a = Object.assign(document.createElement("a"), { href: url, download: `${view?.title ?? "document"} (signed).pdf` });
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  if (phase.kind === "loading") return <Notice title="Opening the document…" />;
  if (phase.kind === "error") return <Notice title="This link can't be used" text={phase.text} />;
  if (!view) return null;
  if (phase.kind === "declined") return <Notice title="You declined to sign" text={`We've let ${view.senderName || "the sender"} know.`} />;
  if (phase.kind === "done") {
    return (
      <Notice
        title={phase.completed ? "Everyone has signed" : "Thanks, you've signed"}
        text={
          phase.completed
            ? "The signed document has been emailed to everyone. You can also download it now."
            : "You'll get the signed copy by email once everyone has signed."
        }
      >
        {phase.completed && (
          <button className="primary" onClick={downloadSigned}>
            Download signed PDF
          </button>
        )}
      </Notice>
    );
  }
  if (view.status === "voided") return <Notice title="This request was cancelled" text={view.voidReason ?? `${view.senderName || "The sender"} cancelled it.`} />;
  if (view.status === "expired") return <Notice title="This request has expired" text={`Ask ${view.senderName || "the sender"} to send it again.`} />;
  if (view.status === "declined") return <Notice title="This request was declined" text="Someone declined to sign, so it can't be completed." />;

  return (
    <div className="sign-page">
      <header className="sign-header">
        <div className="brand">
          <img src="/favicon.svg" alt="" width={20} height={20} />
          PageRig
        </div>
        <div className="sign-title">
          <strong>{view.title}</strong>
          <span className="muted small">
            From {view.senderName || "the sender"}
            {view.senderEmail ? ` (${view.senderEmail})` : ""} · Signing as {view.signer.name}
          </span>
        </div>
        <span className="spacer" />
        <button onClick={decline}>Decline</button>
      </header>
      {view.message && <p className="sign-message">{view.message}</p>}

      <main className="sign-doc">
        {doc?.pages.map((page) => (
          <div key={page.id} className="sign-page-wrap">
            <PageCanvas doc={doc} page={page} width={width}>
              <div className="overlay">
                {(fieldsByPage.get(page.sourceIndex) ?? []).map((f) => (
                  <FieldBox
                    key={f.id}
                    page={page}
                    field={f}
                    scale={width / displaySize(page).width}
                    value={values[f.id]}
                    onFill={() => fill(f)}
                    onText={(v) => setValues({ ...values, [f.id]: v })}
                    refEl={(el) => (el ? fieldEls.current.set(f.id, el) : fieldEls.current.delete(f.id))}
                  />
                ))}
              </div>
            </PageCanvas>
          </div>
        ))}
      </main>

      <footer className="sign-footer">
        <span className="muted">{missing.length ? `${missing.length} required field${missing.length === 1 ? "" : "s"} left` : "All required fields are filled in"}</span>
        {missing.length > 0 && <button onClick={nextField}>Next field</button>}
        <span className="spacer" />
        <label className="check-inline consent">
          <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />I agree to sign electronically, and that my electronic signature is as binding as a handwritten one.
        </label>
        <button className="primary" disabled={!consent || missing.length > 0 || sending} onClick={finish}>
          {sending ? "Signing…" : "Finish"}
        </button>
      </footer>
      {error && (
        <div className="toast error" role="alert">
          {error}
        </div>
      )}

      {drawing && (
        <SignatureDialog
          role={drawing.role}
          onClose={() => setDrawing(null)}
          onDone={async (url) => {
            const png = await asPngDataUrl(url);
            setInk({ ...ink, [drawing.role]: png });
            setValues({ ...values, [drawing.fieldId]: png });
            setDrawing(null);
          }}
        />
      )}
    </div>
  );
}

interface FieldProps {
  page: PageRef;
  field: SignerField;
  scale: number;
  value: FieldEntry | undefined;
  onFill: () => void;
  onText: (value: string) => void;
  refEl: (el: HTMLElement | null) => void;
}

function FieldBox({ page, field: f, scale: s, value, onFill, onText, refEl }: FieldProps) {
  const frame = pageFrame(page);
  const centre = toDisplay(frame, f.cx, f.cy);
  const angle = screenAngle(frame, { ...f, rot: f.rot as 0 | 90 | 180 | 270 });
  const style: CSSProperties = {
    left: centre.x * s - (f.w * s) / 2,
    top: centre.y * s - (f.h * s) / 2,
    width: f.w * s,
    height: f.h * s,
    transform: angle ? `rotate(${angle}deg)` : undefined,
    fontSize: Math.max(8, Math.min(14, f.h * 0.6) * s),
  };
  const filled = !!value;
  const cls = `sign-field t-${f.type}${filled ? " filled" : ""}${f.required ? " required" : ""}`;
  const label = `${f.label || SIGN_FIELD_LABELS[f.type]}${f.required ? "" : " (optional)"}`;

  if (f.type === "text" || f.type === "name") {
    return <input ref={refEl} className={cls} style={style} placeholder={label} aria-label={label} value={String(value ?? "")} onChange={(e) => onText(e.target.value)} />;
  }
  if (f.type === "date") {
    return (
      <div ref={refEl} className={cls} style={style} title="Filled in with today's date">
        {String(value ?? "")}
      </div>
    );
  }
  return (
    <button ref={refEl} className={cls} style={style} onClick={onFill} aria-label={label} aria-pressed={filled}>
      {f.type === "checkbox" ? (filled ? "✔" : "") : filled ? <img src={String(value)} alt={SIGN_FIELD_LABELS[f.type]} draggable={false} /> : <span>Click to {f.type === "signature" ? "sign" : "initial"}</span>}
    </button>
  );
}

function Notice({ title, text, children }: { title: string; text?: string; children?: ReactNode }) {
  return (
    <main className="empty">
      <div className="drop-card">
        <h1>{title}</h1>
        {text && <p>{text}</p>}
        {children}
      </div>
    </main>
  );
}

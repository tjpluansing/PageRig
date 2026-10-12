import { useCallback, useEffect, useState } from "react";
import {
  loadSettings,
  parseRecipients,
  saveSettings,
  signing,
  type EnvelopeDetails,
  type EnvelopeSummary,
  type Recipient,
  type SendRequest,
  type ServerSettings,
  type SignerStatus,
  type TemplateSummary,
} from "../lib/signing";
import { signerColor } from "../lib/objects";
import { Modal } from "./Dialogs";

// ---- Settings ---------------------------------------------------------------------

interface SettingsProps {
  onClose: () => void;
  onSaved: (settings: ServerSettings) => void;
}

/** The PageRig server's address and API key, and who requests come from. */
export function ServerSettingsDialog({ onClose, onSaved }: SettingsProps) {
  const [s, setS] = useState<ServerSettings>(loadSettings);
  const [check, setCheck] = useState<{ ok: boolean; text: string } | null>(null);
  const [checking, setChecking] = useState(false);
  const set = (patch: Partial<ServerSettings>) => {
    setS({ ...s, ...patch });
    setCheck(null);
  };
  const emailOk = !s.senderEmail || /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/.test(s.senderEmail);

  const test = async () => {
    setChecking(true);
    try {
      const settings = { ...s, url: s.url.replace(/\/+$/, "") };
      const config = await signing.config(settings);
      if (!config.signing) setCheck({ ok: false, text: "Connected. Office conversion works, but signature requests are turned off on this server (SIGN_API_KEY isn't set)." });
      else {
        await signing.check(settings);
        setCheck({ ok: true, text: "Connected. You can send signature requests." });
      }
    } catch (err) {
      setCheck({ ok: false, text: (err as Error).message });
    } finally {
      setChecking(false);
    }
  };

  return (
    <Modal title="Server settings" onClose={onClose}>
      <p className="muted">The PageRig server converts Office files and sends documents for signature.</p>
      <div className="form-grid">
        <label>
          Server address
          <input value={s.url} placeholder="https://pagerig.example.com" onChange={(e) => set({ url: e.target.value.trim() })} />
        </label>
        <label>
          API key
          <input type="password" value={s.apiKey} placeholder="Needed to send signature requests" onChange={(e) => set({ apiKey: e.target.value.trim() })} autoComplete="off" />
        </label>
        <label>
          Your name
          <input value={s.senderName} placeholder="Shown to signers" onChange={(e) => set({ senderName: e.target.value })} />
        </label>
        <label>
          Your email
          <input type="email" value={s.senderEmail} placeholder="Gets replies and the signed copy" onChange={(e) => set({ senderEmail: e.target.value.trim() })} />
        </label>
      </div>
      {!emailOk && <p className="form-error">That email address doesn't look right.</p>}
      {check && <p className={check.ok ? "form-ok" : "form-error"}>{check.text}</p>}
      <div className="modal-actions">
        <button disabled={!s.url || checking} onClick={test}>
          {checking ? "Checking…" : "Test connection"}
        </button>
        <span className="spacer" />
        <button onClick={onClose}>Cancel</button>
        <button
          className="primary"
          disabled={!emailOk}
          onClick={() => {
            saveSettings(s);
            onSaved(loadSettings());
          }}
        >
          Save
        </button>
      </div>
    </Modal>
  );
}

// ---- Sending ----------------------------------------------------------------------

export interface SendChoice {
  request: SendRequest;
  /** Also keep the document and fields as a template under this name. */
  templateName: string | null;
}

interface SendProps {
  title: string;
  signerCount: number;
  onSend: (choice: SendChoice) => void;
  onSaveTemplate: (name: string) => void;
  onSettings: () => void;
  onClose: () => void;
}

const EXPIRY = [
  { days: 0, label: "Never" },
  { days: 7, label: "In 7 days" },
  { days: 14, label: "In 14 days" },
  { days: 30, label: "In 30 days" },
  { days: 90, label: "In 90 days" },
];

const REMIND = [
  { days: 0, label: "Off" },
  { days: 2, label: "Every 2 days" },
  { days: 3, label: "Every 3 days" },
  { days: 7, label: "Every week" },
];

function RemindSelect({ value, onChange }: { value: number; onChange: (days: number) => void }) {
  return (
    <label className="inline-field" title="Emails a fresh link to anyone who hasn't signed yet, up to 5 times">
      Automatic reminders{" "}
      <select value={value} onChange={(e) => onChange(Number(e.target.value))}>
        {REMIND.map((x) => (
          <option key={x.days} value={x.days}>
            {x.label}
          </option>
        ))}
      </select>
    </label>
  );
}

const EMAIL = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;

/** Who signs, the email they get, and sending. */
export function SendDialog({ title: initialTitle, signerCount, onSend, onSaveTemplate, onSettings, onClose }: SendProps) {
  const settings = loadSettings();
  const [title, setTitle] = useState(initialTitle);
  const [signers, setSigners] = useState<Recipient[]>(() => Array.from({ length: signerCount }, () => ({ name: "", email: "" })));
  const [ordered, setOrdered] = useState(false);
  const [message, setMessage] = useState("");
  const [expires, setExpires] = useState(14);
  const [remind, setRemind] = useState(3);
  const [saveTemplate, setSaveTemplate] = useState(false);
  const [templateName, setTemplateName] = useState(initialTitle);

  const setSigner = (i: number, patch: Partial<Recipient>) => setSigners(signers.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  const ready = settings.url && settings.apiKey;
  let problem: string | null = null;
  if (!title.trim()) problem = "Give the request a title.";
  else if (signers.some((s) => !s.name.trim() || !s.email.trim())) problem = "Enter a name and email for every signer.";
  else if (signers.some((s) => !EMAIL.test(s.email.trim()))) problem = "Check the email addresses.";
  else if (saveTemplate && !templateName.trim()) problem = "Give the template a name.";

  return (
    <Modal title="Send for signature" onClose={onClose}>
      {!ready && (
        <p className="form-error">
          Sending needs a PageRig server and its API key.{" "}
          <button className="link" onClick={onSettings}>
            Open server settings
          </button>
        </p>
      )}
      <div className="form-grid">
        <label>
          Title
          <input value={title} onChange={(e) => setTitle(e.target.value)} />
        </label>
      </div>
      <fieldset className="protect-section">
        <legend className="strong">Signers</legend>
        {signers.map((s, i) => (
          <div key={i} className="signer-row">
            <span className="signer-dot" style={{ background: signerColor(i) }} aria-hidden />
            {ordered && <span className="muted">{i + 1}.</span>}
            <input placeholder={`Signer ${i + 1} name`} aria-label={`Signer ${i + 1} name`} value={s.name} onChange={(e) => setSigner(i, { name: e.target.value })} />
            <input type="email" placeholder="Email" aria-label={`Signer ${i + 1} email`} value={s.email} onChange={(e) => setSigner(i, { email: e.target.value.trim() })} />
          </div>
        ))}
        {signers.length > 1 && (
          <label className="check-row">
            <input type="checkbox" checked={ordered} onChange={(e) => setOrdered(e.target.checked)} />
            Sign in this order (each person is emailed after the one before signs)
          </label>
        )}
      </fieldset>
      <fieldset className="protect-section">
        <legend className="strong">Email</legend>
        <textarea className="message-input" placeholder="Message to signers (optional)" value={message} onChange={(e) => setMessage(e.target.value)} rows={3} />
        <label className="inline-field">
          Link expires{" "}
          <select value={expires} onChange={(e) => setExpires(Number(e.target.value))}>
            {EXPIRY.map((x) => (
              <option key={x.days} value={x.days}>
                {x.label}
              </option>
            ))}
          </select>
        </label>
        <RemindSelect value={remind} onChange={setRemind} />
        {!settings.senderEmail && <p className="muted small">Add your email in server settings to get replies and the signed copy.</p>}
      </fieldset>
      <label className="check-row">
        <input type="checkbox" checked={saveTemplate} onChange={(e) => setSaveTemplate(e.target.checked)} />
        Also save as a template
      </label>
      {saveTemplate && <input className="template-name" aria-label="Template name" value={templateName} onChange={(e) => setTemplateName(e.target.value)} />}

      {problem && <p className="form-error">{problem}</p>}
      <div className="modal-actions">
        <button disabled={!ready || !templateName.trim()} onClick={() => onSaveTemplate(templateName.trim() || title.trim())} title="Save the document and its fields to reuse later, without sending">
          Save as template only
        </button>
        <span className="spacer" />
        <button onClick={onClose}>Cancel</button>
        <button
          className="primary"
          disabled={!ready || !!problem}
          onClick={() =>
            onSend({
              request: {
                title: title.trim(),
                message: message.trim(),
                ordered,
                expiresDays: expires || null,
                remindDays: remind || null,
                signers: signers.map((s) => ({ name: s.name.trim(), email: s.email.trim() })),
              },
              templateName: saveTemplate ? templateName.trim() : null,
            })
          }
        >
          Send
        </button>
      </div>
    </Modal>
  );
}

// ---- Tracking and templates -------------------------------------------------------

interface RequestsProps {
  onClose: () => void;
  onSettings: () => void;
  onDownload: (name: string, bytes: Uint8Array) => void;
  flash: (text: string, kind?: "error" | "info") => void;
}

const STATUS_LABELS: Record<string, string> = {
  sent: "Waiting",
  completed: "Completed",
  declined: "Declined",
  voided: "Cancelled",
  expired: "Expired",
};

const SIGNER_LABELS: Record<SignerStatus, string> = {
  waiting: "Not sent yet",
  sent: "Emailed",
  viewed: "Opened",
  signed: "Signed",
  declined: "Declined",
};

const EVENT_LABELS: Record<string, string> = {
  created: "Created",
  sent: "Emailed",
  viewed: "Opened by",
  signed: "Signed by",
  declined: "Declined by",
  reminded: "Reminder sent to",
  voided: "Cancelled",
  completed: "Completed",
  expired: "Expired",
};

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "");

/** Sent requests with their progress, and saved templates. */
export function RequestsDialog({ onClose, onSettings, onDownload, flash }: RequestsProps) {
  const [tab, setTab] = useState<"sent" | "templates">("sent");
  const [envelopes, setEnvelopes] = useState<EnvelopeSummary[] | null>(null);
  const [templates, setTemplates] = useState<TemplateSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<EnvelopeDetails | null>(null);
  const [using, setUsing] = useState<{ template: TemplateSummary; bulk: boolean } | null>(null);
  const [working, setWorking] = useState(false);
  const settings = loadSettings();
  const ready = !!(settings.url && settings.apiKey);

  const refresh = useCallback(async () => {
    if (!ready) return;
    setError(null);
    try {
      const [e, t] = await Promise.all([signing.list(), signing.templates()]);
      setEnvelopes(e);
      setTemplates(t);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [ready]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const act = async (fn: () => Promise<unknown>, done?: string) => {
    setWorking(true);
    try {
      await fn();
      if (done) flash(done);
      await refresh();
      if (open) setOpen(await signing.details(open.id).catch(() => null));
    } catch (err) {
      flash((err as Error).message, "error");
    } finally {
      setWorking(false);
    }
  };

  const download = (e: EnvelopeSummary) =>
    act(async () => onDownload(`${e.title}${e.status === "completed" ? " (signed)" : ""}.pdf`, await signing.pdf(e.id)));

  if (!ready) {
    return (
      <Modal title="Signature requests" onClose={onClose}>
        <p>Connect a PageRig server to send documents for signature and track them here.</p>
        <div className="modal-actions">
          <span className="spacer" />
          <button onClick={onClose}>Close</button>
          <button className="primary" onClick={onSettings}>
            Server settings
          </button>
        </div>
      </Modal>
    );
  }

  if (using) {
    return <UseTemplateDialog template={using.template} bulk={using.bulk} onClose={() => setUsing(null)} onDone={(text) => (setUsing(null), flash(text), refresh())} />;
  }

  return (
    <Modal title="Signature requests" onClose={onClose}>
      <div className="tabs" role="tablist">
        <button role="tab" aria-selected={tab === "sent"} className={tab === "sent" ? "active" : ""} onClick={() => setTab("sent")}>
          Sent
        </button>
        <button role="tab" aria-selected={tab === "templates"} className={tab === "templates" ? "active" : ""} onClick={() => setTab("templates")}>
          Templates
        </button>
        <span className="spacer" />
        <button className="link" onClick={() => act(async () => {})} disabled={working}>
          Refresh
        </button>
      </div>
      {error && <p className="form-error">{error}</p>}

      {tab === "sent" && (
        <div className="request-list">
          {envelopes?.length === 0 && <p className="muted">Nothing sent yet. Open a PDF, choose Request signatures, place fields and send.</p>}
          {envelopes?.map((e) => (
            <div key={e.id} className="request-row">
              <div className="request-head">
                <strong>{e.title}</strong>
                <span className={`status status-${e.status}`}>{STATUS_LABELS[e.status] ?? e.status}</span>
                <span className="muted small">{when(e.createdAt)}</span>
                {e.status === "sent" && e.remindDays ? <span className="muted small">· reminds every {e.remindDays === 7 ? "week" : `${e.remindDays} days`}</span> : null}
              </div>
              <div className="request-signers">
                {e.signers.map((s, i) => (
                  <span key={i} className={`signer-status s-${s.status}`} title={s.email}>
                    {s.name}: {SIGNER_LABELS[s.status]}
                  </span>
                ))}
              </div>
              <div className="request-actions">
                <button onClick={() => download(e)} disabled={working}>
                  {e.status === "completed" ? "Download signed" : "Download"}
                </button>
                {e.status === "sent" && (
                  <>
                    <button disabled={working} onClick={() => act(() => signing.remind(e.id), "Reminder sent")}>
                      Remind
                    </button>
                    <button
                      disabled={working}
                      onClick={() => {
                        const reason = window.prompt("Cancel this request? Signers' links will stop working. Reason (optional):");
                        if (reason !== null) act(() => signing.cancel(e.id, reason), "Request cancelled");
                      }}
                    >
                      Cancel request
                    </button>
                  </>
                )}
                <button disabled={working} onClick={() => act(async () => setOpen(open?.id === e.id ? null : await signing.details(e.id)))}>
                  {open?.id === e.id ? "Hide history" : "History"}
                </button>
                {e.status !== "sent" && (
                  <button
                    disabled={working}
                    onClick={() => window.confirm(`Delete "${e.title}" and its documents from the server?`) && act(() => signing.remove(e.id), "Deleted")}
                  >
                    Delete
                  </button>
                )}
              </div>
              {open?.id === e.id && (
                <ol className="history">
                  {open.events.map((ev, i) => (
                    <li key={i}>
                      <span className="muted small">{when(ev.at)}</span> {EVENT_LABELS[ev.kind] ?? ev.kind}
                      {ev.signer !== null && open.signers[ev.signer] ? ` ${open.signers[ev.signer].name}` : ""}
                      {ev.detail && ev.kind !== "created" ? `: ${ev.detail}` : ""}
                    </li>
                  ))}
                  {open.finalSha256 && <li className="muted small">Signed file fingerprint (SHA-256): {open.finalSha256}</li>}
                </ol>
              )}
            </div>
          ))}
        </div>
      )}

      {tab === "templates" && (
        <div className="request-list">
          {templates?.length === 0 && <p className="muted">No templates yet. Tick "Also save as a template" when sending, or use "Save as template only".</p>}
          {templates?.map((t) => (
            <div key={t.id} className="request-row">
              <div className="request-head">
                <strong>{t.name}</strong>
                <span className="muted small">
                  {t.roles.length} signer{t.roles.length === 1 ? "" : "s"} · {t.fieldCount} field{t.fieldCount === 1 ? "" : "s"}
                </span>
              </div>
              <div className="request-actions">
                <button className="primary" onClick={() => setUsing({ template: t, bulk: false })}>
                  Send…
                </button>
                {t.roles.length === 1 && <button onClick={() => setUsing({ template: t, bulk: true })}>Bulk send…</button>}
                <button
                  disabled={working}
                  onClick={() => window.confirm(`Delete the template "${t.name}"?`) && act(() => signing.removeTemplate(t.id), "Template deleted")}
                >
                  Delete
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
      <div className="modal-actions">
        <button className="link" onClick={onSettings}>
          Server settings
        </button>
        <span className="spacer" />
        <button onClick={onClose}>Close</button>
      </div>
    </Modal>
  );
}

interface UseTemplateProps {
  template: TemplateSummary;
  bulk: boolean;
  onClose: () => void;
  onDone: (message: string) => void;
}

/** Send a template to named signers, or to a list of people (one request each). */
function UseTemplateDialog({ template, bulk, onClose, onDone }: UseTemplateProps) {
  const [signers, setSigners] = useState<Recipient[]>(() => template.roles.map(() => ({ name: "", email: "" })));
  const [list, setList] = useState("");
  const [message, setMessage] = useState(template.message);
  const [remind, setRemind] = useState(3);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const parsed = bulk ? parseRecipients(list) : null;

  let problem: string | null = null;
  if (bulk) {
    if (!parsed!.recipients.length) problem = "Add at least one person.";
    else if (parsed!.problems.length) problem = parsed!.problems.slice(0, 3).join(". ");
    else if (parsed!.recipients.length > 500) problem = "Bulk send is limited to 500 people at a time.";
  } else if (signers.some((s) => !s.name.trim() || !EMAIL.test(s.email.trim()))) problem = "Enter a name and a valid email for every signer.";

  const send = async () => {
    setSending(true);
    setError(null);
    try {
      if (bulk) {
        const res = await signing.bulkSend(template.id, parsed!.recipients, { message, remindDays: remind || null });
        onDone(`Sent ${res.created} request${res.created === 1 ? "" : "s"}`);
      } else {
        await signing.sendTemplate(template.id, { signers: signers.map((s) => ({ name: s.name.trim(), email: s.email.trim() })), message, remindDays: remind || null });
        onDone("Sent");
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSending(false);
    }
  };

  const loadCsv = async (file: File | undefined) => {
    if (file) setList(await file.text());
  };

  return (
    <Modal title={bulk ? `Bulk send: ${template.name}` : `Send: ${template.name}`} onClose={onClose}>
      {bulk ? (
        <>
          <p className="muted">Each person gets their own copy to sign. One per line, as "name, email", or choose a CSV file.</p>
          <textarea className="message-input" rows={8} aria-label="Recipients" placeholder={"Ada Lovelace, ada@example.com\nAlan Turing, alan@example.com"} value={list} onChange={(e) => setList(e.target.value)} />
          <label className="inline-field">
            <input type="file" accept=".csv,text/csv,text/plain" onChange={(e) => loadCsv(e.target.files?.[0])} />
          </label>
          {parsed && parsed.recipients.length > 0 && <p className="muted small">{parsed.recipients.length} people</p>}
        </>
      ) : (
        template.roles.map((role, i) => (
          <div key={i} className="signer-row">
            <span className="signer-dot" style={{ background: signerColor(i) }} aria-hidden />
            <span className="muted">{role}</span>
            <input placeholder="Name" aria-label={`${role} name`} value={signers[i].name} onChange={(e) => setSigners(signers.map((s, j) => (j === i ? { ...s, name: e.target.value } : s)))} />
            <input type="email" placeholder="Email" aria-label={`${role} email`} value={signers[i].email} onChange={(e) => setSigners(signers.map((s, j) => (j === i ? { ...s, email: e.target.value.trim() } : s)))} />
          </div>
        ))
      )}
      <textarea className="message-input" rows={2} placeholder="Message (optional)" value={message} onChange={(e) => setMessage(e.target.value)} />
      <RemindSelect value={remind} onChange={setRemind} />
      {(error || problem) && <p className="form-error">{error ?? problem}</p>}
      <div className="modal-actions">
        <span className="spacer" />
        <button onClick={onClose}>Back</button>
        <button className="primary" disabled={!!problem || sending} onClick={send}>
          {sending ? "Sending…" : "Send"}
        </button>
      </div>
    </Modal>
  );
}

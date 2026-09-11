"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Download, ExternalLink, FileText, X } from "lucide-react";
import { Alert, Button } from "@/components/ui";
import {
  fetchHistoricalDocument,
  listApplicationSnapshots,
  type ApplicationSnapshot
} from "@/lib/api";

function safeExternalUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch {
    return null;
  }
}

function dateLabel(value: string | null | undefined): string {
  if (!value) return "Date not recorded";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Date not recorded";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(date);
}

function confirmationLabel(value: string): string | null {
  if (value === "strong_evidence" || value === "extension_confirmed" || value === "auto_apply_confirmed") {
    return "Submission confirmed automatically";
  }
  if (value === "user_confirmed" || value === "manual") return "Confirmed by you";
  return null;
}

function artifactFormat(filename: string | null): "docx" | "pdf" {
  return filename?.toLowerCase().endsWith(".pdf") ? "pdf" : "docx";
}

export function ApplicationMemoryDialog({
  trackerId,
  cachedSnapshots,
  onLoaded,
  onClose
}: {
  trackerId: number;
  cachedSnapshots?: ApplicationSnapshot[];
  onLoaded: (trackerId: number, snapshots: ApplicationSnapshot[]) => void;
  onClose: () => void;
}) {
  const [snapshots, setSnapshots] = useState<ApplicationSnapshot[] | null>(cachedSnapshots ?? null);
  const [selectedId, setSelectedId] = useState<number | null>(cachedSnapshots?.at(-1)?.id ?? null);
  const [error, setError] = useState("");
  const [artifactMessage, setArtifactMessage] = useState("");
  const [descriptionOpen, setDescriptionOpen] = useState(false);
  const [loadVersion, setLoadVersion] = useState(0);
  const closeRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
      if (event.key === "Tab") {
        const focusable = Array.from(
          dialogRef.current?.querySelectorAll<HTMLElement>(
            'a[href], button:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
          ) ?? []
        );
        const first = focusable[0];
        const last = focusable.at(-1);
        if (!first || !last) return;
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", onKeyDown);
      returnFocusRef.current?.focus();
    };
  }, [onClose]);

  useEffect(() => {
    if (cachedSnapshots) {
      return;
    }
    let active = true;
    void listApplicationSnapshots(trackerId)
      .then(({ snapshots: loaded }) => {
        if (!active) return;
        setSnapshots(loaded);
        setSelectedId(loaded.at(-1)?.id ?? null);
        onLoaded(trackerId, loaded);
      })
      .catch((caught: unknown) => {
        if (active) setError(caught instanceof Error ? caught.message : "Could not load application details.");
      });
    return () => {
      active = false;
    };
  }, [cachedSnapshots, loadVersion, onLoaded, trackerId]);

  const snapshot = useMemo(
    () => snapshots?.find((item) => item.id === selectedId) ?? snapshots?.at(-1) ?? null,
    [selectedId, snapshots]
  );

  async function artifactAction(
    artifact: ApplicationSnapshot["resume"],
    kind: "resume" | "cover letter",
    mode: "view" | "download"
  ) {
    if (!artifact.document_id) return;
    setArtifactMessage(`Preparing ${kind}…`);
    try {
      const format = artifactFormat(artifact.filename);
      const response = await fetchHistoricalDocument(artifact.document_id, format);
      if (!response.ok) throw new Error("unavailable");
      const objectUrl = URL.createObjectURL(await response.blob());
      if (mode === "view") {
        window.open(objectUrl, "_blank", "noopener,noreferrer");
      } else {
        const link = document.createElement("a");
        link.href = objectUrl;
        link.download = artifact.filename || `historical-${kind.replace(" ", "-")}.${format}`;
        link.click();
      }
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
      setArtifactMessage("");
    } catch {
      setArtifactMessage(`This historical ${kind} is currently unavailable.`);
    }
  }

  return (
    <div className="fixed inset-0 z-[70] overflow-y-auto bg-black/50 p-3 sm:p-6" onMouseDown={onClose}>
      <section
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="application-memory-title"
        className="mx-auto my-2 w-full max-w-3xl overflow-hidden rounded-card border border-line-default bg-surface-card shadow-xl sm:my-8"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="sticky top-0 z-10 flex items-start justify-between gap-4 border-b border-line-default bg-surface-card px-4 py-4 sm:px-6">
          <div className="min-w-0">
            <p className="text-xs font-semibold uppercase tracking-wide text-foreground-muted">Historical record</p>
            <h2 id="application-memory-title" className="mt-1 text-xl font-semibold text-foreground">
              Application details
            </h2>
          </div>
          <Button ref={closeRef} size="icon" variant="ghost" aria-label="Close application details" onClick={onClose}>
            <X aria-hidden className="h-5 w-5" />
          </Button>
        </header>

        <div className="max-h-[calc(100vh-8rem)] overflow-y-auto px-4 py-5 sm:px-6">
          {!snapshots && !error ? <p role="status" aria-busy="true">Loading application details…</p> : null}
          {error ? (
            <Alert tone="danger" title="Application details unavailable">
              <p>{error}</p>
              <Button className="mt-3" variant="secondary" onClick={() => {
                setSnapshots(null);
                setError("");
                setLoadVersion((version) => version + 1);
              }}>
                Retry
              </Button>
            </Alert>
          ) : null}
          {snapshots?.length === 0 ? <Alert tone="info">No historical application details are available.</Alert> : null}

          {snapshot ? (
            <div className="min-w-0 grid gap-7">
              {snapshots && snapshots.length > 1 ? (
                <div role="group" aria-label="Application attempts" className="flex flex-wrap gap-2">
                  {snapshots.map((attempt) => (
                    <Button
                      key={attempt.id}
                      variant={attempt.id === snapshot.id ? "primary" : "secondary"}
                      aria-pressed={attempt.id === snapshot.id}
                      onClick={() => {
                        setSelectedId(attempt.id);
                        setDescriptionOpen(false);
                      }}
                    >
                      Attempt {attempt.attempt_number} · {dateLabel(attempt.applied_at)}
                    </Button>
                  ))}
                </div>
              ) : null}

              <section aria-labelledby="memory-application-heading">
                <h3 id="memory-application-heading" className="text-base font-semibold text-foreground">Application</h3>
                <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-2">
                  <div><dt className="text-foreground-muted">Role</dt><dd className="break-words font-medium">{snapshot.job_title}</dd></div>
                  <div><dt className="text-foreground-muted">Company</dt><dd className="break-words font-medium">{snapshot.company_name}</dd></div>
                  <div><dt className="text-foreground-muted">Applied</dt><dd>{dateLabel(snapshot.applied_at)}</dd></div>
                  {confirmationLabel(snapshot.confirmation_source) ? <div><dt className="text-foreground-muted">Confirmation</dt><dd>{confirmationLabel(snapshot.confirmation_source)}</dd></div> : null}
                </dl>
                {safeExternalUrl(snapshot.job_url || snapshot.source_url) ? (
                  <a className="ds-focus-ring mt-3 inline-flex items-center gap-1 rounded-control text-sm font-semibold text-foreground-link underline" href={safeExternalUrl(snapshot.job_url || snapshot.source_url)!} target="_blank" rel="noopener noreferrer">
                    Historical job link <ExternalLink aria-hidden className="h-4 w-4" />
                  </a>
                ) : null}
              </section>

              <MemoryArtifact
                heading={snapshot.resume_used && snapshot.resume_provenance === "upload_verified" ? "Resume used" : snapshot.resume.document_id ? "Resume selected for this application" : "Resume"}
                empty="No resume recorded for this attempt"
                artifact={snapshot.resume}
                kind="resume"
                onAction={artifactAction}
              />

              <section aria-labelledby="memory-cover-heading">
                <h3 id="memory-cover-heading" className="text-base font-semibold text-foreground">Cover letter</h3>
                {snapshot.cover_letter_mode === "file" && snapshot.cover_letter.document_id ? (
                  <MemoryArtifact heading="Cover letter used" empty="No cover letter used" artifact={snapshot.cover_letter} kind="cover letter" onAction={artifactAction} nested />
                ) : snapshot.cover_letter_mode === "pasted_text" && snapshot.cover_letter_text_snapshot ? (
                  <div className="mt-3"><p className="text-sm font-medium">Cover letter used</p><pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-field bg-surface-subtle p-4 font-sans text-sm">{snapshot.cover_letter_text_snapshot}</pre></div>
                ) : <p className="mt-2 text-sm text-foreground-muted">No cover letter used</p>}
              </section>

              <section aria-labelledby="memory-description-heading">
                <h3 id="memory-description-heading" className="text-base font-semibold text-foreground">Job description</h3>
                {snapshot.job_description_snapshot ? (
                  <><Button className="mt-3 h-auto max-w-full whitespace-normal py-2 text-left" variant="secondary" aria-expanded={descriptionOpen} onClick={() => setDescriptionOpen((open) => !open)}>{descriptionOpen ? "Hide" : "View"} job description at time of application</Button>{descriptionOpen ? <pre className="mt-3 max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-field bg-surface-subtle p-4 font-sans text-sm">{snapshot.job_description_snapshot}</pre> : null}</>
                ) : <p className="mt-2 text-sm text-foreground-muted">No job description was recorded for this attempt.</p>}
              </section>

              <section aria-labelledby="memory-answers-heading">
                <h3 id="memory-answers-heading" className="text-base font-semibold text-foreground">Application answers</h3>
                {snapshot.answers.length ? <dl className="mt-3 grid gap-3">{snapshot.answers.map((answer) => <div key={answer.canonical_key}><dt className="break-words text-sm text-foreground-muted">{answer.canonical_key.replaceAll("_", " ")}</dt><dd className="break-words text-sm">{answer.display_value}</dd></div>)}</dl> : <p className="mt-2 text-sm text-foreground-muted">Application answers were not recorded for this attempt.</p>}
              </section>
              {artifactMessage ? <p role="status" className="text-sm text-foreground-muted">{artifactMessage}</p> : null}
            </div>
          ) : null}
        </div>
      </section>
    </div>
  );
}

function MemoryArtifact({ heading, empty, artifact, kind, onAction, nested = false }: {
  heading: string;
  empty: string;
  artifact: ApplicationSnapshot["resume"];
  kind: "resume" | "cover letter";
  onAction: (artifact: ApplicationSnapshot["resume"], kind: "resume" | "cover letter", mode: "view" | "download") => void;
  nested?: boolean;
}) {
  return (
    <section className="min-w-0" aria-label={nested ? undefined : heading}>
      {!nested ? <h3 className="text-base font-semibold text-foreground">{heading}</h3> : null}
      {artifact.document_id ? <div className="mt-3 min-w-0"><p className="block max-w-full truncate text-sm font-medium" title={artifact.filename || heading}>{artifact.filename || "Historical document"}</p><div className="mt-3 grid gap-2 sm:flex sm:flex-wrap"><Button className="w-full justify-center sm:w-auto" variant="secondary" onClick={() => onAction(artifact, kind, "view")}><FileText aria-hidden className="h-4 w-4" />View {kind}</Button><Button className="w-full justify-center sm:w-auto" variant="secondary" onClick={() => onAction(artifact, kind, "download")}><Download aria-hidden className="h-4 w-4" />Download {kind}</Button></div></div> : <p className="mt-2 text-sm text-foreground-muted">{empty}</p>}
    </section>
  );
}

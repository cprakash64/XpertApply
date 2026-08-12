"use client";

import { useState } from "react";
import { Plus } from "lucide-react";
import { Button } from "@/components/Button";
import {
  blankAward,
  blankCertification,
  yearRange,
  type AwardRecord,
  type CertificationRecord
} from "@/lib/careerRecords";
import type { ProfileEditorState } from "@/lib/profileEditorData";
import { EditorShell } from "./EditorShell";
import { ConfirmDialog, EmptyRecords, Field, RecordCard, SaveBar, Toggle } from "./primitives";

/**
 * Certifications & Awards.
 *
 * Two record types in one section because they answer the same question — "what
 * has been formally recognized?" — and neither is big enough to justify its own
 * screen. They are still stored in separate tables and edited as separate
 * lists, so nothing is conflated.
 *
 * Fields are exactly what the `Certification` and `Award` tables already store.
 * A credential ID, a certification description and an award URL are *not*
 * offered, because those columns do not exist and inventing a control that
 * silently discards what the user typed would be worse than omitting it.
 *
 * "Does not expire" is a real state rather than a stored flag: the expiration
 * column is nullable, and empty already means exactly that. The toggle clears
 * the date, which is the same thing the database records.
 */
export function CredentialsEditor({ editor }: { editor: ProfileEditorState }) {
  const { data, loading, loadError, reload, save, setCareer, saveCareer, dirty } = editor;
  const [open, setOpen] = useState<{ kind: "cert" | "award"; index: number } | null>(null);
  const [pendingDelete, setPendingDelete] = useState<{ kind: "cert" | "award"; index: number } | null>(
    null
  );
  /**
   * Certifications whose expiry field the user has opened up.
   *
   * An empty expiration date means "does not expire", so that alone cannot
   * distinguish "no expiry" from "about to type one". This tracks the second
   * case; it is pure UI state and is never persisted.
   */
  const [enteringExpiry, setEnteringExpiry] = useState<Set<number>>(new Set());

  const certifications = data?.career.certifications ?? [];
  const awards = data?.career.awards ?? [];

  function updateCert(index: number, patch: Partial<CertificationRecord>) {
    setCareer((current) => ({
      ...current,
      certifications: current.certifications.map((item, position) =>
        position === index ? { ...item, ...patch } : item
      )
    }));
  }

  function updateAward(index: number, patch: Partial<AwardRecord>) {
    setCareer((current) => ({
      ...current,
      awards: current.awards.map((item, position) =>
        position === index ? { ...item, ...patch } : item
      )
    }));
  }

  function confirmDelete() {
    if (!pendingDelete) return;
    const { kind, index } = pendingDelete;
    setCareer((current) =>
      kind === "cert"
        ? { ...current, certifications: current.certifications.filter((_, i) => i !== index) }
        : { ...current, awards: current.awards.filter((_, i) => i !== index) }
    );
    setPendingDelete(null);
    setOpen(null);
  }

  /** True when this certification is currently marked as never expiring. */
  function noExpiry(record: CertificationRecord, index: number): boolean {
    return record.expiration_date === "" && !enteringExpiry.has(index);
  }

  const pendingName =
    pendingDelete?.kind === "cert"
      ? certifications[pendingDelete.index]?.name
      : pendingDelete
        ? awards[pendingDelete.index]?.name
        : "";

  return (
    <EditorShell loading={loading} loadError={loadError} onRetry={reload}>
      {data && (
        <div className="grid gap-6">
          {/* ---------------------------------------------------------- */}
          <section>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-sm font-semibold">Certifications</h2>
              <Button
                type="button"
                variant="secondary"
                onClick={() => {
                  setCareer((current) => ({
                    ...current,
                    certifications: [...current.certifications, blankCertification()]
                  }));
                  setOpen({ kind: "cert", index: certifications.length });
                }}
              >
                <Plus className="h-4 w-4" aria-hidden /> Add certification
              </Button>
            </div>

            {certifications.length === 0 ? (
              <EmptyRecords
                text="No certifications yet."
                actionLabel="Add certification"
                onAdd={() => {
                  setCareer((current) => ({
                    ...current,
                    certifications: [...current.certifications, blankCertification()]
                  }));
                  setOpen({ kind: "cert", index: 0 });
                }}
              />
            ) : (
              <ul className="mt-3 grid gap-3">
                {certifications.map((record, index) => (
                  <li key={index}>
                    <RecordCard
                      expanded={open?.kind === "cert" && open.index === index}
                      onToggle={() =>
                        setOpen((current) =>
                          current?.kind === "cert" && current.index === index
                            ? null
                            : { kind: "cert", index }
                        )
                      }
                      onDelete={() => setPendingDelete({ kind: "cert", index })}
                      deleteLabel="Delete certification"
                      menuLabel={`Actions for ${record.name || "this certification"}`}
                      summary={
                        <div className="min-w-0">
                          <p className="truncate text-sm font-semibold">
                            {record.name || "Untitled certification"}
                          </p>
                          <p className="mt-0.5 truncate text-xs text-[var(--text-muted)]">
                            {[record.issuer, certificationPeriod(record)]
                              .filter(Boolean)
                              .join(" · ")}
                          </p>
                        </div>
                      }
                    >
                      <div className="grid gap-3 sm:grid-cols-2">
                        <Field
                          label="Name"
                          value={record.name}
                          placeholder="AWS Certified Machine Learning"
                          onChange={(value) => updateCert(index, { name: value })}
                        />
                        <Field
                          label="Issuing organization"
                          value={record.issuer}
                          placeholder="Amazon Web Services"
                          onChange={(value) => updateCert(index, { issuer: value })}
                        />
                        <Field
                          label="Issue date"
                          type="date"
                          value={record.issue_date}
                          onChange={(value) => updateCert(index, { issue_date: value })}
                        />
                        <div>
                          <Field
                            label="Expiration date"
                            type="date"
                            value={record.expiration_date}
                            disabled={noExpiry(record, index)}
                            onChange={(value) => updateCert(index, { expiration_date: value })}
                          />
                          <div className="mt-2">
                            <Toggle
                              label="Does not expire"
                              checked={noExpiry(record, index)}
                              onChange={(checked) => {
                                setEnteringExpiry((current) => {
                                  const next = new Set(current);
                                  if (checked) next.delete(index);
                                  else next.add(index);
                                  return next;
                                });
                                // Ticking clears the stored date, which is
                                // exactly how "no expiry" is represented.
                                if (checked) updateCert(index, { expiration_date: "" });
                              }}
                            />
                          </div>
                        </div>
                        <div className="sm:col-span-2">
                          <Field
                            label="Credential URL"
                            type="url"
                            value={record.credential_url}
                            placeholder="https://..."
                            onChange={(value) => updateCert(index, { credential_url: value })}
                          />
                        </div>
                      </div>
                    </RecordCard>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {/* ---------------------------------------------------------- */}
          <section>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-sm font-semibold">Awards & honours</h2>
              <Button
                type="button"
                variant="secondary"
                onClick={() => {
                  setCareer((current) => ({
                    ...current,
                    awards: [...current.awards, blankAward()]
                  }));
                  setOpen({ kind: "award", index: awards.length });
                }}
              >
                <Plus className="h-4 w-4" aria-hidden /> Add award
              </Button>
            </div>

            {awards.length === 0 ? (
              <EmptyRecords
                text="No awards yet."
                actionLabel="Add award"
                onAdd={() => {
                  setCareer((current) => ({ ...current, awards: [...current.awards, blankAward()] }));
                  setOpen({ kind: "award", index: 0 });
                }}
              />
            ) : (
              <ul className="mt-3 grid gap-3">
                {awards.map((record, index) => (
                  <li key={index}>
                    <RecordCard
                      expanded={open?.kind === "award" && open.index === index}
                      onToggle={() =>
                        setOpen((current) =>
                          current?.kind === "award" && current.index === index
                            ? null
                            : { kind: "award", index }
                        )
                      }
                      onDelete={() => setPendingDelete({ kind: "award", index })}
                      deleteLabel="Delete award"
                      menuLabel={`Actions for ${record.name || "this award"}`}
                      summary={
                        <div className="min-w-0">
                          <p className="truncate text-sm font-semibold">
                            {record.name || "Untitled award"}
                          </p>
                          <p className="mt-0.5 truncate text-xs text-[var(--text-muted)]">
                            {[record.issuer, yearRange(record.date, "")].filter(Boolean).join(" · ")}
                          </p>
                        </div>
                      }
                    >
                      <div className="grid gap-3 sm:grid-cols-2">
                        <Field
                          label="Name"
                          value={record.name}
                          placeholder="Dean's List"
                          onChange={(value) => updateAward(index, { name: value })}
                        />
                        <Field
                          label="Issuing organization"
                          value={record.issuer}
                          placeholder="Arizona State University"
                          onChange={(value) => updateAward(index, { issuer: value })}
                        />
                        <Field
                          label="Date"
                          type="date"
                          value={record.date}
                          onChange={(value) => updateAward(index, { date: value })}
                        />
                        <div className="sm:col-span-2">
                          <Field
                            label="Description"
                            value={record.description}
                            placeholder="What it was awarded for"
                            onChange={(value) => updateAward(index, { description: value })}
                          />
                        </div>
                      </div>
                    </RecordCard>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      )}

      <ConfirmDialog
        open={pendingDelete !== null}
        title={pendingDelete?.kind === "cert" ? "Delete certification?" : "Delete award?"}
        body={`“${pendingName || "This record"}” will be removed when you save.`}
        confirmLabel="Delete"
        onConfirm={confirmDelete}
        onCancel={() => setPendingDelete(null)}
      />

      <SaveBar state={save} dirty={dirty} onSave={() => void saveCareer()} onCancel={reload} />
    </EditorShell>
  );
}

/** "2025" / "2023 — 2026" / "2023 — No expiry". */
function certificationPeriod(record: CertificationRecord): string {
  const issued = yearRange(record.issue_date, "");
  if (!issued) return record.expiration_date ? yearRange(record.expiration_date, "") : "";
  if (!record.expiration_date) return issued;
  return `${issued} — ${yearRange(record.expiration_date, "")}`;
}

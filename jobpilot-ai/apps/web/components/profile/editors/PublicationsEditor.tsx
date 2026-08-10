"use client";

import { useState } from "react";
import { Plus } from "lucide-react";
import { Button } from "@/components/Button";
import { blankPublication, yearRange, type PublicationRecord } from "@/lib/careerRecords";
import type { ProfileEditorState } from "@/lib/profileEditorData";
import { isValidOptionalUrl } from "@/lib/profileUrls";
import { EditorShell } from "./EditorShell";
import {
  ConfirmDialog,
  EmptyRecords,
  Field,
  RecordCard,
  SaveBar,
  TagField
} from "./primitives";

/**
 * Publications.
 *
 * Same shape as every other career section: collapsed summary cards, one open
 * at a time, delete behind a confirmation, explicit Save/Cancel. The section is
 * genuinely optional — a candidate with no papers is not an incomplete
 * candidate, which is why nothing here feeds profile completion or autofill
 * readiness.
 *
 * Authors are a plain tag list of whatever the user types. The user's own name
 * is never added for them, and no citation metadata is fetched: every value on
 * this screen is something a person entered.
 */
export function PublicationsEditor({ editor }: { editor: ProfileEditorState }) {
  const { data, loading, loadError, reload, save, setCareer, saveCareer, dirty } = editor;
  const [openIndex, setOpenIndex] = useState<number | null>(null);
  const [pendingDelete, setPendingDelete] = useState<number | null>(null);

  const records = data?.career.publications ?? [];
  const invalidUrls = records.filter(
    (record) => record.url.trim() !== "" && !isValidOptionalUrl(record.url)
  ).length;

  function update(index: number, patch: Partial<PublicationRecord>) {
    setCareer((current) => ({
      ...current,
      publications: current.publications.map((item, position) =>
        position === index ? { ...item, ...patch } : item
      )
    }));
  }

  function add() {
    setCareer((current) => ({
      ...current,
      publications: [...current.publications, blankPublication()]
    }));
    setOpenIndex(records.length);
  }

  function confirmDelete() {
    if (pendingDelete === null) return;
    setCareer((current) => ({
      ...current,
      publications: current.publications.filter((_, index) => index !== pendingDelete)
    }));
    setPendingDelete(null);
    setOpenIndex(null);
  }

  return (
    <EditorShell loading={loading} loadError={loadError} onRetry={reload}>
      {data && (
        <div>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-[var(--text-muted)]">
              Papers, articles, and other published work.
            </p>
            <Button type="button" variant="secondary" onClick={add}>
              <Plus className="h-4 w-4" aria-hidden /> Add publication
            </Button>
          </div>

          {records.length === 0 ? (
            <EmptyRecords
              text="No publications yet. Share research, articles, or papers when relevant."
              actionLabel="Add publication"
              onAdd={add}
            />
          ) : (
            <ul className="mt-3 grid gap-3">
              {records.map((record, index) => {
                const badUrl = record.url.trim() !== "" && !isValidOptionalUrl(record.url);
                return (
                  <li key={index}>
                    <RecordCard
                      expanded={openIndex === index}
                      onToggle={() => setOpenIndex((current) => (current === index ? null : index))}
                      onDelete={() => setPendingDelete(index)}
                      deleteLabel="Delete publication"
                      menuLabel={`Actions for ${record.title || "this publication"}`}
                      summary={
                        <div className="min-w-0">
                          <p className="truncate text-sm font-semibold">
                            {record.title || "Untitled publication"}
                          </p>
                          <p className="mt-0.5 truncate text-xs text-[var(--text-muted)]">
                            {[record.venue, yearRange(record.publication_date, "")]
                              .filter(Boolean)
                              .join(" · ")}
                          </p>
                        </div>
                      }
                    >
                      <div className="grid gap-3 sm:grid-cols-2">
                        <div className="sm:col-span-2">
                          <Field
                            label="Title"
                            value={record.title}
                            placeholder="Efficient Video Event Detection at the Edge"
                            onChange={(value) => update(index, { title: value })}
                          />
                        </div>
                        <Field
                          label="Publication / venue"
                          value={record.venue}
                          placeholder="IEEE, arXiv, ACM…"
                          onChange={(value) => update(index, { venue: value })}
                        />
                        <Field
                          label="Publication date"
                          type="date"
                          value={record.publication_date}
                          onChange={(value) => update(index, { publication_date: value })}
                        />
                        <div className="sm:col-span-2">
                          <TagField
                            label="Authors"
                            values={record.authors}
                            placeholder="Add an author"
                            hint="Listed exactly as they appear on the work. Nothing is added for you."
                            onChange={(value) => update(index, { authors: value })}
                          />
                        </div>
                        <Field
                          label="URL"
                          type="url"
                          value={record.url}
                          placeholder="https://..."
                          error={badUrl ? "Must start with http:// or https://." : undefined}
                          onChange={(value) => update(index, { url: value })}
                        />
                        <Field
                          label="DOI"
                          value={record.doi}
                          placeholder="10.1109/EXAMPLE.2025.12345"
                          hint="Stored as an identifier, not a link."
                          onChange={(value) => update(index, { doi: value })}
                        />
                        <div className="sm:col-span-2">
                          <Field
                            label="Short description"
                            value={record.description}
                            placeholder="One line on what the work covers"
                            onChange={(value) => update(index, { description: value })}
                          />
                        </div>
                      </div>
                    </RecordCard>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}

      <ConfirmDialog
        open={pendingDelete !== null}
        title="Delete publication?"
        body={`“${
          (pendingDelete !== null && records[pendingDelete]?.title) || "This publication"
        }” will be removed when you save.`}
        confirmLabel="Delete"
        onConfirm={confirmDelete}
        onCancel={() => setPendingDelete(null)}
      />

      {invalidUrls > 0 && (
        <p role="alert" className="mt-4 text-sm text-[var(--danger)]">
          Fix the highlighted link{invalidUrls === 1 ? "" : "s"} before saving.
        </p>
      )}

      <SaveBar
        state={save}
        dirty={dirty}
        disabled={invalidUrls > 0}
        onSave={() => void saveCareer()}
        onCancel={reload}
      />
    </EditorShell>
  );
}

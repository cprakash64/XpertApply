"use client";

import { useState } from "react";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui";
import {
  blankExperience,
  yearRange,
  type ExperienceRecord
} from "@/lib/careerRecords";
import type { ProfileEditorState } from "@/lib/profileEditorData";
import { EditorShell } from "./EditorShell";
import {
  BulletList,
  ConfirmDialog,
  EmptyRecords,
  Field,
  RecordCard,
  SaveBar,
  TagField,
  Toggle
} from "./primitives";

/** Technologies shown in the collapsed summary before "+N". */
const SUMMARY_TECH_LIMIT = 4;

/**
 * Experience editor.
 *
 * Previously every role rendered its full form at once, so a five-role history
 * was a wall of inputs. Now each role is a compact summary, at most one is open
 * at a time, and Delete lives in the per-record menu behind a confirmation
 * instead of a permanent coral button on every card.
 */
export function ExperienceEditor({ editor }: { editor: ProfileEditorState }) {
  const { data, loading, loadError, reload, save, setCareer, saveCareer, dirty } = editor;
  const [openIndex, setOpenIndex] = useState<number | null>(null);
  const [pendingDelete, setPendingDelete] = useState<number | null>(null);

  const records = data?.career.experience ?? [];

  function update(index: number, next: ExperienceRecord) {
    setCareer((current) => ({
      ...current,
      experience: current.experience.map((item, itemIndex) =>
        itemIndex === index ? next : item
      )
    }));
  }

  function add() {
    setCareer((current) => ({ ...current, experience: [...current.experience, blankExperience()] }));
    // Open the new record straight away — it is empty, so there is nothing to
    // review and the user's intent is unambiguous.
    setOpenIndex(records.length);
  }

  function duplicate(index: number) {
    // Safe because an Experience row carries no server-generated identity: the
    // career endpoint replaces the whole list, so a copy is just another entry.
    setCareer((current) => {
      const copy = { ...current.experience[index] };
      const next = [...current.experience];
      next.splice(index + 1, 0, copy);
      return { ...current, experience: next };
    });
    setOpenIndex(index + 1);
  }

  function remove(index: number) {
    setCareer((current) => ({
      ...current,
      experience: current.experience.filter((_, itemIndex) => itemIndex !== index)
    }));
    setOpenIndex(null);
    setPendingDelete(null);
  }

  return (
    <EditorShell loading={loading} loadError={loadError} onRetry={reload}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-foreground-muted">
          {records.length === 0
            ? "No roles yet."
            : `${records.length} role${records.length === 1 ? "" : "s"}.`}{" "}
          Open one to edit it.
        </p>
        <Button type="button" variant="secondary" onClick={add}>
          <Plus className="h-4 w-4" aria-hidden /> Add role
        </Button>
      </div>

      {records.length === 0 ? (
        <div className="mt-4">
          <EmptyRecords
            text="Add the roles you want employers to see."
            actionLabel="Add your first role"
            onAdd={add}
          />
        </div>
      ) : (
        <ul className="mt-4 grid gap-3">
          {records.map((record, index) => (
            <RecordCard
              key={index}
              expanded={openIndex === index}
              // Only one open at a time: opening a record closes the previous.
              onToggle={() => setOpenIndex(openIndex === index ? null : index)}
              onDelete={() => setPendingDelete(index)}
              onDuplicate={() => duplicate(index)}
              deleteLabel="Delete experience"
              menuLabel={`Actions for ${record.company || "this role"}`}
              summary={<ExperienceSummary record={record} />}
            >
              <ExperienceFields record={record} onChange={(next) => update(index, next)} />
            </RecordCard>
          ))}
        </ul>
      )}

      <SaveBar
        state={save}
        dirty={dirty}
        onSave={() => void saveCareer()}
        onCancel={reload}
      />

      <ConfirmDialog
        open={pendingDelete !== null}
        title="Delete this experience?"
        body={
          pendingDelete !== null
            ? `“${records[pendingDelete]?.title || records[pendingDelete]?.company || "This role"}” will be removed when you save.`
            : ""
        }
        confirmLabel="Delete experience"
        onConfirm={() => pendingDelete !== null && remove(pendingDelete)}
        onCancel={() => setPendingDelete(null)}
      />
    </EditorShell>
  );
}

function ExperienceSummary({ record }: { record: ExperienceRecord }) {
  const dates = yearRange(record.start_date, record.end_date, record.currently_working);
  const meta = [record.location, dates].filter(Boolean).join(" · ");
  const shown = record.technologies.slice(0, SUMMARY_TECH_LIMIT);
  const remaining = record.technologies.length - shown.length;

  return (
    <span className="block min-w-0">
      <span className="block truncate text-sm font-semibold">
        {record.company || "Untitled company"}
      </span>
      {record.title && (
        <span className="mt-0.5 block truncate text-sm text-foreground-secondary">
          {record.title}
        </span>
      )}
      {meta && <span className="mt-1 block truncate text-xs text-foreground-muted">{meta}</span>}
      {shown.length > 0 && (
        <span className="mt-1.5 block truncate text-xs text-foreground-muted">
          {shown.join(" · ")}
          {remaining > 0 && <span className="ml-1.5 font-medium">+{remaining}</span>}
        </span>
      )}
    </span>
  );
}

function ExperienceFields({
  record,
  onChange
}: {
  record: ExperienceRecord;
  onChange: (record: ExperienceRecord) => void;
}) {
  return (
    <div className="grid min-w-0 gap-4">
      <div className="grid min-w-0 gap-4 sm:grid-cols-2">
        <Field
          label="Company"
          value={record.company}
          onChange={(value) => onChange({ ...record, company: value })}
        />
        <Field
          label="Role / title"
          value={record.title}
          onChange={(value) => onChange({ ...record, title: value })}
        />
        <Field
          label="Location"
          value={record.location}
          placeholder="Phoenix, AZ"
          onChange={(value) => onChange({ ...record, location: value })}
        />
        <Field
          label="Start date"
          type="date"
          value={record.start_date}
          onChange={(value) => onChange({ ...record, start_date: value })}
        />
        <Field
          label="End date"
          type="date"
          value={record.currently_working ? "" : record.end_date}
          // Disabled rather than hidden so the relationship between the two
          // controls is visible; the stored value is cleared so the record
          // cannot say both "current" and "ended in 2023".
          disabled={record.currently_working}
          hint={record.currently_working ? "Not needed while this is your current role." : undefined}
          onChange={(value) => onChange({ ...record, end_date: value })}
        />
        <div className="flex items-end pb-1">
          <Toggle
            label="I currently work here"
            checked={record.currently_working}
            onChange={(value) =>
              onChange({
                ...record,
                currently_working: value,
                end_date: value ? "" : record.end_date
              })
            }
          />
        </div>
      </div>

      <BulletList
        label="What you did"
        values={record.bullets}
        rows={5}
        hint="One bullet per line. Paste from an existing resume and the lines are kept as written."
        onChange={(values) => onChange({ ...record, bullets: values })}
      />
      <BulletList
        label="Measurable impact"
        values={record.measurable_impact}
        rows={3}
        hint="One per line — results with a number where you have one."
        onChange={(values) => onChange({ ...record, measurable_impact: values })}
      />
      <TagField
        label="Technologies"
        values={record.technologies}
        placeholder="Python, FastAPI, AWS"
        hint="Press Enter, or paste a comma-separated list."
        onChange={(values) => onChange({ ...record, technologies: values })}
      />
    </div>
  );
}

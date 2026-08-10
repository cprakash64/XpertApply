"use client";

import { useState } from "react";
import { Plus } from "lucide-react";
import { Button } from "@/components/Button";
import { blankEducation, yearRange, type EducationRecord } from "@/lib/careerRecords";
import type { ProfileEditorState } from "@/lib/profileEditorData";
import { EditorShell } from "./EditorShell";
import {
  ConfirmDialog,
  EmptyRecords,
  Field,
  RecordCard,
  SaveBar,
  SelectField,
  TagField
} from "./primitives";

const DEGREE_OPTIONS = [
  "High School Diploma",
  "Associate's Degree",
  "Bachelor's Degree",
  "Master's Degree",
  "Doctoral Degree",
  "Other"
] as const;

const GPA_SCALES = ["4.0", "5.0", "10.0", "100"] as const;

/**
 * Education editor. Honors and coursework are real stored fields, but they are
 * detail — the collapsed card shows school, degree, minor, dates and GPA, and
 * the rest appears when you open the record.
 */
export function EducationEditor({ editor }: { editor: ProfileEditorState }) {
  const { data, loading, loadError, reload, save, setCareer, saveCareer, dirty } = editor;
  const [openIndex, setOpenIndex] = useState<number | null>(null);
  const [pendingDelete, setPendingDelete] = useState<number | null>(null);

  const records = data?.career.education ?? [];

  function update(index: number, next: EducationRecord) {
    setCareer((current) => ({
      ...current,
      education: current.education.map((item, itemIndex) => (itemIndex === index ? next : item))
    }));
  }

  function add() {
    setCareer((current) => ({ ...current, education: [...current.education, blankEducation()] }));
    setOpenIndex(records.length);
  }

  function duplicate(index: number) {
    setCareer((current) => {
      const next = [...current.education];
      next.splice(index + 1, 0, { ...current.education[index] });
      return { ...current, education: next };
    });
    setOpenIndex(index + 1);
  }

  function remove(index: number) {
    setCareer((current) => ({
      ...current,
      education: current.education.filter((_, itemIndex) => itemIndex !== index)
    }));
    setOpenIndex(null);
    setPendingDelete(null);
  }

  return (
    <EditorShell loading={loading} loadError={loadError} onRetry={reload}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-[var(--text-muted)]">
          {records.length === 0
            ? "No schools yet."
            : `${records.length} school${records.length === 1 ? "" : "s"}.`}{" "}
          Open one to edit it.
        </p>
        <Button type="button" variant="secondary" onClick={add}>
          <Plus className="h-4 w-4" aria-hidden /> Add education
        </Button>
      </div>

      {records.length === 0 ? (
        <div className="mt-4">
          <EmptyRecords
            text="Add your schools and degrees."
            actionLabel="Add your first school"
            onAdd={add}
          />
        </div>
      ) : (
        <ul className="mt-4 grid gap-3">
          {records.map((record, index) => (
            <RecordCard
              key={index}
              expanded={openIndex === index}
              onToggle={() => setOpenIndex(openIndex === index ? null : index)}
              onDelete={() => setPendingDelete(index)}
              onDuplicate={() => duplicate(index)}
              deleteLabel="Delete education"
              menuLabel={`Actions for ${record.school || "this school"}`}
              summary={<EducationSummary record={record} />}
            >
              <EducationFields record={record} onChange={(next) => update(index, next)} />
            </RecordCard>
          ))}
        </ul>
      )}

      <SaveBar state={save} dirty={dirty} onSave={() => void saveCareer()} onCancel={reload} />

      <ConfirmDialog
        open={pendingDelete !== null}
        title="Delete this education entry?"
        body={
          pendingDelete !== null
            ? `“${records[pendingDelete]?.school || "This school"}” will be removed when you save.`
            : ""
        }
        confirmLabel="Delete education"
        onConfirm={() => pendingDelete !== null && remove(pendingDelete)}
        onCancel={() => setPendingDelete(null)}
      />
    </EditorShell>
  );
}

function EducationSummary({ record }: { record: EducationRecord }) {
  const degreeLine = [record.degree, record.major].filter(Boolean).join(" · ");
  const dates = yearRange(record.start_date, record.end_date);
  return (
    <span className="block min-w-0">
      <span className="block truncate text-sm font-semibold">
        {record.school || "Untitled school"}
      </span>
      {degreeLine && (
        <span className="mt-0.5 block truncate text-sm text-[var(--text-secondary)]">
          {degreeLine}
        </span>
      )}
      {record.minor && (
        <span className="mt-0.5 block truncate text-xs text-[var(--text-muted)]">
          Minor: {record.minor}
        </span>
      )}
      <span className="mt-1 block truncate text-xs text-[var(--text-muted)]">
        {[
          dates,
          // Only shown when the user chose to record one.
          record.gpa.trim()
            ? `GPA ${record.gpa}${record.gpa_scale.trim() ? `/${record.gpa_scale}` : ""}`
            : ""
        ]
          .filter(Boolean)
          .join(" · ")}
      </span>
    </span>
  );
}

function EducationFields({
  record,
  onChange
}: {
  record: EducationRecord;
  onChange: (record: EducationRecord) => void;
}) {
  return (
    <div className="grid min-w-0 gap-4">
      <div className="grid min-w-0 gap-4 sm:grid-cols-2">
        <Field
          label="School"
          value={record.school}
          onChange={(value) => onChange({ ...record, school: value })}
        />
        <SelectField
          label="Degree"
          value={record.degree}
          options={DEGREE_OPTIONS}
          onChange={(value) => onChange({ ...record, degree: value })}
        />
        <Field
          label="Major"
          value={record.major}
          onChange={(value) => onChange({ ...record, major: value })}
        />
        <Field
          label="Minor"
          value={record.minor}
          onChange={(value) => onChange({ ...record, minor: value })}
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
          value={record.end_date}
          hint="Leave blank if you are still studying."
          onChange={(value) => onChange({ ...record, end_date: value })}
        />
        <Field
          label="GPA"
          value={record.gpa}
          placeholder="3.8"
          hint="Optional — leave blank to keep it off your profile."
          onChange={(value) => onChange({ ...record, gpa: value })}
        />
        <SelectField
          label="GPA scale"
          value={record.gpa_scale || "4.0"}
          options={GPA_SCALES}
          onChange={(value) => onChange({ ...record, gpa_scale: value })}
        />
      </div>
      <TagField
        label="Honors"
        values={record.honors}
        placeholder="Dean's List"
        hint="Press Enter, or paste a comma-separated list."
        onChange={(values) => onChange({ ...record, honors: values })}
      />
      <TagField
        label="Relevant coursework"
        values={record.coursework}
        placeholder="Machine Learning"
        hint="Press Enter, or paste a comma-separated list."
        onChange={(values) => onChange({ ...record, coursework: values })}
      />
    </div>
  );
}

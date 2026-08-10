"use client";

import { useState } from "react";
import { ExternalLink, Plus } from "lucide-react";
import { Button } from "@/components/Button";
import { blankProject, yearRange, type ProjectRecord } from "@/lib/careerRecords";
import type { ProfileEditorState } from "@/lib/profileEditorData";
import { isValidOptionalUrl } from "@/lib/profileUrls";
import { EditorShell } from "./EditorShell";
import {
  BulletList,
  ConfirmDialog,
  EmptyRecords,
  Field,
  RecordCard,
  SaveBar,
  TagField,
  TextArea
} from "./primitives";

const SUMMARY_TECH_LIMIT = 4;

/**
 * Projects editor. The collapsed card shows the name, technologies, a one-line
 * description and any links — deliberately no textareas, which is what made the
 * old always-expanded list so heavy.
 */
export function ProjectsEditor({ editor }: { editor: ProfileEditorState }) {
  const { data, loading, loadError, reload, save, setCareer, saveCareer, dirty } = editor;
  const [openIndex, setOpenIndex] = useState<number | null>(null);
  const [pendingDelete, setPendingDelete] = useState<number | null>(null);

  const records = data?.career.projects ?? [];

  function update(index: number, next: ProjectRecord) {
    setCareer((current) => ({
      ...current,
      projects: current.projects.map((item, itemIndex) => (itemIndex === index ? next : item))
    }));
  }

  function add() {
    setCareer((current) => ({ ...current, projects: [...current.projects, blankProject()] }));
    setOpenIndex(records.length);
  }

  function duplicate(index: number) {
    setCareer((current) => {
      const next = [...current.projects];
      next.splice(index + 1, 0, { ...current.projects[index] });
      return { ...current, projects: next };
    });
    setOpenIndex(index + 1);
  }

  function remove(index: number) {
    setCareer((current) => ({
      ...current,
      projects: current.projects.filter((_, itemIndex) => itemIndex !== index)
    }));
    setOpenIndex(null);
    setPendingDelete(null);
  }

  return (
    <EditorShell loading={loading} loadError={loadError} onRetry={reload}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-[var(--text-muted)]">
          {records.length === 0
            ? "No projects yet."
            : `${records.length} project${records.length === 1 ? "" : "s"}.`}{" "}
          Open one to edit it.
        </p>
        <Button type="button" variant="secondary" onClick={add}>
          <Plus className="h-4 w-4" aria-hidden /> Add project
        </Button>
      </div>

      {records.length === 0 ? (
        <div className="mt-4">
          <EmptyRecords
            text="Projects are strong evidence when your experience is short."
            actionLabel="Add your first project"
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
              deleteLabel="Delete project"
              menuLabel={`Actions for ${record.name || "this project"}`}
              summary={<ProjectSummary record={record} />}
            >
              <ProjectFields record={record} onChange={(next) => update(index, next)} />
            </RecordCard>
          ))}
        </ul>
      )}

      <SaveBar state={save} dirty={dirty} onSave={() => void saveCareer()} onCancel={reload} />

      <ConfirmDialog
        open={pendingDelete !== null}
        title="Delete this project?"
        body={
          pendingDelete !== null
            ? `“${records[pendingDelete]?.name || "This project"}” will be removed when you save.`
            : ""
        }
        confirmLabel="Delete project"
        onConfirm={() => pendingDelete !== null && remove(pendingDelete)}
        onCancel={() => setPendingDelete(null)}
      />
    </EditorShell>
  );
}

function ProjectSummary({ record }: { record: ProjectRecord }) {
  const shown = record.technologies.slice(0, SUMMARY_TECH_LIMIT);
  const remaining = record.technologies.length - shown.length;
  const blurb = record.description || record.bullets[0] || "";
  const dates = yearRange(record.start_date, record.end_date);

  return (
    <span className="block min-w-0">
      <span className="block truncate text-sm font-semibold">{record.name || "Untitled project"}</span>
      {shown.length > 0 && (
        <span className="mt-0.5 block truncate text-xs text-[var(--text-muted)]">
          {shown.join(" · ")}
          {remaining > 0 && <span className="ml-1.5 font-medium">+{remaining}</span>}
        </span>
      )}
      {blurb && (
        <span className="mt-1 block truncate text-sm text-[var(--text-secondary)]">{blurb}</span>
      )}
      {dates && <span className="mt-1 block truncate text-xs text-[var(--text-muted)]">{dates}</span>}
      {record.links.length > 0 && (
        <span className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1">
          {record.links.slice(0, 3).map((link) => (
            <span
              key={link}
              className="inline-flex max-w-full items-center gap-1 truncate text-xs text-[var(--text-muted)]"
            >
              <ExternalLink className="h-3 w-3 shrink-0" aria-hidden />
              <span className="truncate">{linkLabel(link)}</span>
            </span>
          ))}
        </span>
      )}
    </span>
  );
}

/** "github.com/me/luna" reads better in a summary than the full URL. */
function linkLabel(link: string): string {
  try {
    const url = new URL(link);
    return `${url.hostname.replace(/^www\./, "")}${url.pathname === "/" ? "" : url.pathname}`;
  } catch {
    return link;
  }
}

function ProjectFields({
  record,
  onChange
}: {
  record: ProjectRecord;
  onChange: (record: ProjectRecord) => void;
}) {
  const invalidLinks = record.links.filter((link) => !isValidOptionalUrl(link));
  return (
    <div className="grid min-w-0 gap-4">
      <div className="grid min-w-0 gap-4 sm:grid-cols-2">
        <Field
          label="Project name"
          value={record.name}
          onChange={(value) => onChange({ ...record, name: value })}
        />
        <div className="hidden sm:block" aria-hidden />
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
          hint="Leave blank if this is ongoing."
          onChange={(value) => onChange({ ...record, end_date: value })}
        />
      </div>
      <TextArea
        label="Description"
        value={record.description}
        rows={3}
        hint="One or two sentences on what it is and why it mattered."
        onChange={(value) => onChange({ ...record, description: value })}
      />
      <BulletList
        label="Highlights"
        values={record.bullets}
        rows={4}
        onChange={(values) => onChange({ ...record, bullets: values })}
      />
      <TagField
        label="Technologies"
        values={record.technologies}
        placeholder="FastAPI, OpenCV"
        hint="Press Enter, or paste a comma-separated list."
        onChange={(values) => onChange({ ...record, technologies: values })}
      />
      <div>
        <TagField
          label="Links"
          values={record.links}
          placeholder="https://github.com/you/project"
          hint="Repository, demo, or write-up."
          onChange={(values) => onChange({ ...record, links: values })}
        />
        {invalidLinks.length > 0 && (
          <p role="alert" className="mt-1 text-xs text-[var(--danger)]">
            {invalidLinks.length === 1 ? "This link does not" : "These links do not"} start with
            http:// or https://: {invalidLinks.join(", ")}
          </p>
        )}
      </div>
    </div>
  );
}

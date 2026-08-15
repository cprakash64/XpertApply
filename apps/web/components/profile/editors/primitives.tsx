"use client";

import { useEffect, useId, useRef, useState } from "react";
import {
  AlertTriangle,
  Check,
  ChevronDown,
  Loader2,
  MoreHorizontal,
  Plus,
  X
} from "lucide-react";
import { Button } from "@/components/Button";
import type { SaveState } from "@/lib/profileEditorData";

/**
 * Building blocks for the focused profile editors.
 *
 * The organising idea is progressive disclosure: reviewing your profile should
 * be reading, not scrolling past a dozen open forms. So a record is a compact
 * summary until you choose to edit it, and only one record is open at a time.
 */

/* --------------------------------------------------------------------- */
/* Collapsible record card                                               */
/* --------------------------------------------------------------------- */

/**
 * One record: a summary you can read, or an open editor.
 *
 * Semantics matter here. The summary's expand control is a real `<button>`
 * carrying `aria-expanded` and `aria-controls`, and the body it controls is a
 * region labelled by it — so a screen reader announces the state rather than
 * the user discovering it by trial. Focus moves into the open editor, and back
 * to the trigger on close, so keyboard users are never dropped at the top of
 * the page.
 */
export function RecordCard({
  summary,
  expanded,
  onToggle,
  onDelete,
  onDuplicate,
  deleteLabel,
  menuLabel,
  children
}: {
  summary: React.ReactNode;
  expanded: boolean;
  onToggle: () => void;
  onDelete: () => void;
  onDuplicate?: () => void;
  deleteLabel: string;
  menuLabel: string;
  children: React.ReactNode;
}) {
  const bodyId = useId();
  const triggerId = useId();
  const bodyRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const wasExpanded = useRef(expanded);

  useEffect(() => {
    if (expanded && !wasExpanded.current) {
      // Opening: put focus on the first control inside so typing starts here.
      bodyRef.current?.querySelector<HTMLElement>("input, textarea, select")?.focus();
    } else if (!expanded && wasExpanded.current) {
      // Closing: hand focus back to the control that closed it.
      triggerRef.current?.focus();
    }
    wasExpanded.current = expanded;
  }, [expanded]);

  return (
    <li className="rounded-2xl border border-line bg-white transition duration-150 hover:border-[var(--border-strong)]">
      <div className="flex items-start gap-2 p-4">
        <button
          ref={triggerRef}
          id={triggerId}
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          aria-controls={bodyId}
          className="focus-ring -m-1 flex min-w-0 flex-1 items-start gap-3 rounded-xl p-1 text-left"
        >
          <span className="min-w-0 flex-1">{summary}</span>
          <ChevronDown
            aria-hidden
            className={`mt-1 h-4 w-4 shrink-0 text-[var(--text-muted)] transition-transform duration-150 ${
              expanded ? "rotate-180" : ""
            }`}
          />
        </button>
        <RecordMenu
          label={menuLabel}
          onEdit={expanded ? undefined : onToggle}
          onDuplicate={onDuplicate}
          onDelete={onDelete}
          deleteLabel={deleteLabel}
        />
      </div>

      {/* Kept unmounted while collapsed: this is what stops the page rendering
          a dozen full forms (and dozens of empty textareas) at once. */}
      {expanded && (
        <div
          id={bodyId}
          ref={bodyRef}
          role="region"
          aria-labelledby={triggerId}
          className="border-t border-line p-4"
        >
          {children}
        </div>
      )}
    </li>
  );
}

/**
 * The per-record overflow menu.
 *
 * Delete lives in here rather than as a permanent coral button on every card:
 * a destructive action repeated down the page is both visually dominant and
 * easy to hit by accident.
 */
function RecordMenu({
  label,
  onEdit,
  onDuplicate,
  onDelete,
  deleteLabel
}: {
  label: string;
  onEdit?: () => void;
  onDuplicate?: () => void;
  onDelete: () => void;
  deleteLabel: string;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: MouseEvent) {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setOpen(false);
        buttonRef.current?.focus();
      }
    }
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div ref={wrapRef} className="relative shrink-0">
      <button
        ref={buttonRef}
        type="button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="focus-ring grid h-8 w-8 place-items-center rounded-lg text-[var(--text-muted)] transition hover:bg-panel hover:text-ink"
      >
        <MoreHorizontal className="h-4 w-4" aria-hidden />
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 z-20 mt-1 w-52 overflow-hidden rounded-xl border border-line bg-white py-1 shadow-card"
        >
          {onEdit && (
            <MenuItem onSelect={() => { setOpen(false); onEdit(); }}>Edit</MenuItem>
          )}
          {onDuplicate && (
            <MenuItem onSelect={() => { setOpen(false); onDuplicate(); }}>Duplicate</MenuItem>
          )}
          <MenuItem
            destructive
            onSelect={() => { setOpen(false); onDelete(); }}
          >
            {deleteLabel}
          </MenuItem>
        </div>
      )}
    </div>
  );
}

function MenuItem({
  children,
  onSelect,
  destructive = false
}: {
  children: React.ReactNode;
  onSelect: () => void;
  destructive?: boolean;
}) {
  return (
    <button
      role="menuitem"
      type="button"
      onClick={onSelect}
      className={`focus-ring block w-full px-3 py-2 text-left text-sm transition hover:bg-panel ${
        destructive ? "text-[var(--danger)]" : "text-ink"
      }`}
    >
      {children}
    </button>
  );
}

/* --------------------------------------------------------------------- */
/* Destructive confirmation                                              */
/* --------------------------------------------------------------------- */

/**
 * Modal confirmation for a delete.
 *
 * `role="alertdialog"` with a labelled title and description, Escape to
 * dismiss, focus moved to the safe (Cancel) control on open and returned to the
 * opener on close. Cancel is focused rather than Confirm so a stray Enter
 * cannot delete a record.
 */
export function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel,
  onConfirm,
  onCancel
}: {
  open: boolean;
  title: string;
  body: string;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const titleId = useId();
  const bodyId = useId();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const opener = useRef<Element | null>(null);

  useEffect(() => {
    if (!open) return;
    opener.current = document.activeElement;
    cancelRef.current?.focus();
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onCancel();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      (opener.current as HTMLElement | null)?.focus?.();
    };
  }, [open, onCancel]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-[var(--overlay)] p-4">
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={bodyId}
        className="w-full max-w-md rounded-2xl border border-line bg-white p-5 shadow-card"
      >
        <div className="flex items-start gap-3">
          <span
            aria-hidden
            className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-[var(--danger-surface)] text-[var(--danger)]"
          >
            <AlertTriangle className="h-4 w-4" />
          </span>
          <div className="min-w-0">
            <h2 id={titleId} className="text-base font-semibold">{title}</h2>
            <p id={bodyId} className="mt-1 text-sm text-[var(--text-muted)]">{body}</p>
          </div>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          {/* A native button so the ref can land on the element itself —
              Button's props do not include one. */}
          <button
            ref={cancelRef}
            type="button"
            onClick={onCancel}
            className="focus-ring inline-flex h-10 items-center justify-center rounded-md border border-line bg-white px-4 text-sm font-medium text-ink transition hover:bg-panel"
          >
            Cancel
          </button>
          <Button type="button" variant="danger" onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}

/* --------------------------------------------------------------------- */
/* Save affordance                                                       */
/* --------------------------------------------------------------------- */

/**
 * Section-level Save/Cancel plus its status.
 *
 * "Saved" is rendered only from a resolved server response — never optimistically
 * — so the word always means the change is persisted. `aria-live="polite"`
 * announces the transition without stealing focus mid-edit.
 */
export function SaveBar({
  state,
  dirty,
  onSave,
  onCancel,
  saveLabel = "Save changes",
  disabled = false
}: {
  state: SaveState;
  dirty: boolean;
  onSave: () => void;
  onCancel: () => void;
  saveLabel?: string;
  /** Blocks Save while the section holds a value the server would reject. */
  disabled?: boolean;
}) {
  return (
    <div className="mt-6 flex flex-col gap-3 border-t border-line pt-4 sm:flex-row sm:items-center sm:justify-between">
      <p aria-live="polite" className="min-h-5 text-sm">
        {state.status === "saving" && (
          <span className="inline-flex items-center gap-2 text-[var(--text-muted)]">
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> Saving…
          </span>
        )}
        {state.status === "saved" && (
          <span className="inline-flex items-center gap-2 text-pine">
            <Check className="h-3.5 w-3.5" aria-hidden /> Saved
          </span>
        )}
        {state.status === "error" && (
          <span className="inline-flex items-center gap-2 text-[var(--danger)]">
            <AlertTriangle className="h-3.5 w-3.5" aria-hidden />
            Error saving — {state.message}
          </span>
        )}
        {state.status === "idle" && dirty && (
          <span className="text-[var(--text-muted)]">Unsaved changes</span>
        )}
      </p>
      <div className="flex shrink-0 gap-2">
        <Button type="button" variant="secondary" onClick={onCancel} disabled={state.status === "saving"}>
          Cancel
        </Button>
        <Button type="button" onClick={onSave} disabled={disabled || state.status === "saving"}>
          {state.status === "saving" ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
          ) : null}
          {state.status === "error" ? "Retry" : saveLabel}
        </Button>
      </div>
    </div>
  );
}

/* --------------------------------------------------------------------- */
/* Fields                                                                */
/* --------------------------------------------------------------------- */

export function Field({
  label,
  value,
  onChange,
  type = "text",
  placeholder,
  error,
  hint,
  disabled = false,
  className = ""
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: string;
  placeholder?: string;
  error?: string;
  hint?: string;
  disabled?: boolean;
  className?: string;
}) {
  const id = useId();
  const messageId = useId();
  return (
    <div className={`min-w-0 ${className}`}>
      <label htmlFor={id} className="block text-sm font-medium">
        {label}
      </label>
      <input
        id={id}
        type={type}
        value={value}
        disabled={disabled}
        placeholder={placeholder}
        aria-invalid={error ? true : undefined}
        aria-describedby={error || hint ? messageId : undefined}
        onChange={(event) => onChange(event.target.value)}
        className={`mt-1.5 h-10 w-full rounded-xl border bg-[var(--input-background)] px-3 text-sm transition disabled:bg-[var(--disabled-background)] disabled:text-[var(--text-muted)] ${
          error ? "border-[var(--danger-border)]" : "border-line"
        }`}
      />
      {(error || hint) && (
        <p
          id={messageId}
          className={`mt-1 text-xs ${error ? "text-[var(--danger)]" : "text-[var(--text-muted)]"}`}
        >
          {error || hint}
        </p>
      )}
    </div>
  );
}

export function SelectField({
  label,
  value,
  options,
  onChange,
  error,
  className = ""
}: {
  label: string;
  value: string;
  options: readonly (readonly [string, string])[] | readonly string[];
  onChange: (value: string) => void;
  error?: string;
  className?: string;
}) {
  const id = useId();
  const errorId = useId();
  // Accepts either plain strings or [value, label] pairs, so a caller with a
  // coded option set (work authorization) and one with a simple list (GPA
  // scale) can both use this control.
  const pairs: [string, string][] = options.map((option) =>
    typeof option === "string" ? [option, option] : [option[0], option[1]]
  );
  return (
    <div className={`min-w-0 ${className}`}>
      <label htmlFor={id} className="block text-sm font-medium">
        {label}
      </label>
      <select
        id={id}
        value={value}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
        onChange={(event) => onChange(event.target.value)}
        className={`mt-1.5 h-10 w-full rounded-xl border bg-[var(--input-background)] px-3 text-sm ${
          error ? "border-[var(--danger-border)]" : "border-line"
        }`}
      >
        {pairs.map(([optionValue, optionLabel]) => (
          <option key={optionValue} value={optionValue}>
            {optionLabel}
          </option>
        ))}
      </select>
      {error && (
        <p id={errorId} className="mt-1 text-xs text-[var(--danger)]">
          {error}
        </p>
      )}
    </div>
  );
}

export function TextArea({
  label,
  value,
  onChange,
  rows = 3,
  placeholder,
  hint
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  rows?: number;
  placeholder?: string;
  hint?: string;
}) {
  const id = useId();
  const hintId = useId();
  return (
    <div className="min-w-0">
      <label htmlFor={id} className="block text-sm font-medium">
        {label}
      </label>
      <textarea
        id={id}
        rows={rows}
        value={value}
        placeholder={placeholder}
        aria-describedby={hint ? hintId : undefined}
        onChange={(event) => onChange(event.target.value)}
        className="mt-1.5 w-full rounded-xl border border-line bg-[var(--input-background)] px-3 py-2 text-sm"
      />
      {hint && (
        <p id={hintId} className="mt-1 text-xs text-[var(--text-muted)]">
          {hint}
        </p>
      )}
    </div>
  );
}

/**
 * A list of prose lines (bullets, impact statements) edited as one textarea.
 *
 * One line per entry is far easier to write and reorder than a stack of single
 * -line inputs with add/remove buttons, and it makes pasting from an existing
 * resume work. Blank lines are dropped on the way out, so the stored list never
 * gains empty strings.
 */
export function BulletList({
  label,
  values,
  onChange,
  hint = "One per line.",
  rows = 4
}: {
  label: string;
  values: string[];
  onChange: (values: string[]) => void;
  hint?: string;
  rows?: number;
}) {
  const id = useId();
  const hintId = useId();
  return (
    <div className="min-w-0">
      <label htmlFor={id} className="block text-sm font-medium">
        {label}
      </label>
      <textarea
        id={id}
        rows={rows}
        value={values.join("\n")}
        aria-describedby={hintId}
        onChange={(event) =>
          onChange(
            event.target.value
              .split("\n")
              .map((line) => line.replace(/^\s*[-•]\s*/, "").trim())
              .filter(Boolean)
          )
        }
        className="mt-1.5 w-full rounded-xl border border-line bg-[var(--input-background)] px-3 py-2 text-sm leading-6"
      />
      <p id={hintId} className="mt-1 text-xs text-[var(--text-muted)]">
        {hint}
      </p>
    </div>
  );
}

/**
 * Free-form tag entry: type and press Enter, or paste a comma-separated list.
 *
 * Values are only ever added or removed as whole strings — nothing here edits
 * the text of a tag the user typed.
 */
export function TagField({
  label,
  values,
  onChange,
  placeholder,
  hint
}: {
  label: string;
  values: string[];
  onChange: (values: string[]) => void;
  placeholder?: string;
  hint?: string;
}) {
  const [input, setInput] = useState("");
  const id = useId();
  const hintId = useId();

  function commit(raw: string) {
    const additions = raw
      .split(/[,\n]/)
      .map((item) => item.trim())
      .filter(Boolean);
    if (additions.length === 0) return;
    const next = [...values];
    for (const addition of additions) {
      if (!next.some((existing) => existing.toLowerCase() === addition.toLowerCase())) {
        next.push(addition);
      }
    }
    onChange(next);
    setInput("");
  }

  return (
    <div className="min-w-0">
      <label htmlFor={id} className="block text-sm font-medium">
        {label}
      </label>
      <div className="mt-1.5 flex gap-2">
        <input
          id={id}
          value={input}
          placeholder={placeholder}
          aria-describedby={hint ? hintId : undefined}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              commit(input);
            }
            // Backspace on an empty box removes the last tag — the standard
            // token-field behaviour.
            if (event.key === "Backspace" && input === "" && values.length > 0) {
              onChange(values.slice(0, -1));
            }
          }}
          onPaste={(event) => {
            const pasted = event.clipboardData.getData("text");
            if (/[,\n]/.test(pasted)) {
              event.preventDefault();
              commit(pasted);
            }
          }}
          className="h-10 min-w-0 flex-1 rounded-xl border border-line bg-[var(--input-background)] px-3 text-sm"
        />
        <Button type="button" variant="secondary" onClick={() => commit(input)}>
          <Plus className="h-4 w-4" aria-hidden /> Add
        </Button>
      </div>
      {hint && (
        <p id={hintId} className="mt-1 text-xs text-[var(--text-muted)]">
          {hint}
        </p>
      )}
      <TagList values={values} onRemove={(value) => onChange(values.filter((item) => item !== value))} />
    </div>
  );
}

export function TagList({
  values,
  onRemove
}: {
  values: string[];
  onRemove: (value: string) => void;
}) {
  if (values.length === 0) return null;
  return (
    <ul className="mt-2 flex flex-wrap gap-1.5">
      {values.map((value) => (
        <li
          key={value}
          className="inline-flex max-w-full items-center gap-1.5 rounded-lg border border-line bg-panel px-2 py-1 text-xs text-[var(--text-secondary)]"
        >
          <span className="truncate">{value}</span>
          <button
            type="button"
            onClick={() => onRemove(value)}
            aria-label={`Remove ${value}`}
            className="focus-ring shrink-0 rounded text-[var(--text-muted)] transition hover:text-[var(--danger)]"
          >
            <X className="h-3 w-3" aria-hidden />
          </button>
        </li>
      ))}
    </ul>
  );
}

/** A labelled checkbox. */
export function Toggle({
  label,
  checked,
  onChange,
  hint
}: {
  label: string;
  checked: boolean;
  onChange: (value: boolean) => void;
  hint?: string;
}) {
  const id = useId();
  const hintId = useId();
  return (
    <div className="min-w-0">
      <div className="flex items-center gap-2">
        <input
          id={id}
          type="checkbox"
          checked={checked}
          aria-describedby={hint ? hintId : undefined}
          onChange={(event) => onChange(event.target.checked)}
          className="h-4 w-4 rounded border-line accent-[var(--accent)]"
        />
        <label htmlFor={id} className="text-sm font-medium">
          {label}
        </label>
      </div>
      {hint && (
        <p id={hintId} className="mt-1 text-xs text-[var(--text-muted)]">
          {hint}
        </p>
      )}
    </div>
  );
}

/** Grouping heading inside a form (Identity / Contact / Location). */
export function FieldGroup({
  title,
  description,
  children
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <fieldset className="min-w-0 rounded-2xl border border-line bg-white p-5">
      <legend className="px-1 text-sm font-semibold">{title}</legend>
      {description && <p className="mt-1 text-xs text-[var(--text-muted)]">{description}</p>}
      <div className="mt-4 grid min-w-0 gap-4 sm:grid-cols-2">{children}</div>
    </fieldset>
  );
}

/** The "no records yet" prompt. */
export function EmptyRecords({ text, actionLabel, onAdd }: { text: string; actionLabel: string; onAdd: () => void }) {
  return (
    <div className="rounded-2xl border border-dashed border-line bg-panel px-5 py-8 text-center">
      <p className="text-sm text-[var(--text-muted)]">{text}</p>
      <Button type="button" className="mx-auto mt-3" onClick={onAdd}>
        <Plus className="h-4 w-4" aria-hidden /> {actionLabel}
      </Button>
    </div>
  );
}

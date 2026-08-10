"use client";

import { useMemo, useState } from "react";
import { Check, Plus, Search, X } from "lucide-react";
import { Button } from "@/components/Button";
import { roleGroups, targetLevelOptions } from "@/lib/profileCatalog";
import { searchLocations } from "@/lib/locations";
import type { ProfileEditorState } from "@/lib/profileEditorData";
import type { ProfileForm } from "@/lib/profileForm";
import { EditorShell } from "./EditorShell";
import { SaveBar } from "./primitives";

const WORKPLACE_OPTIONS: [ProfileForm["remote_preference"], string][] = [
  ["everything", "Any workplace"],
  ["remote", "Remote"],
  ["hybrid", "Hybrid"],
  ["onsite", "On-site"]
];

/**
 * Job preferences — the section the wizard calls "Job targets".
 *
 * The user-facing name is "Job preferences" everywhere here; the wire fields
 * (`target_roles`, `target_levels`, `preferred_locations`, `remote_preference` /
 * `work_preference`) are untouched, so nothing about the API or the extension's
 * view of the profile changes.
 *
 * The old screen rendered the entire catalog of roles, levels and locations as
 * permanently visible chips, so the handful the user had actually chosen were
 * lost among dozens they had not. Here the selections come first and the
 * catalog only appears after Add/Edit.
 */
export function PreferencesEditor({ editor }: { editor: ProfileEditorState }) {
  const { data, loading, loadError, reload, save, setForm, saveProfile, dirty } = editor;
  const form = data?.form;

  return (
    <EditorShell loading={loading} loadError={loadError} onRetry={reload}>
      {form && (
        <div className="grid gap-4">
          <SelectionCard
            title="Target roles"
            description="The roles EZJobFind matches you against."
            selected={form.target_roles}
            catalog={roleGroups}
            allowCustom
            addLabel="Add role"
            searchPlaceholder="Search roles, or type your own title"
            emptyHint="No target roles yet — matching works much better with at least one."
            onChange={(values) => setForm((current) => ({ ...current, target_roles: values }))}
          />

          <SelectionCard
            title="Target level"
            description="Seniority you want to be matched at."
            selected={form.target_levels}
            catalog={[{ label: "Level", options: targetLevelOptions }]}
            addLabel="Edit levels"
            searchPlaceholder="Search levels"
            emptyHint="No levels selected."
            onChange={(values) => setForm((current) => ({ ...current, target_levels: values }))}
          />

          {/* Locations are WHERE, workplace is HOW. "Remote" is deliberately
              not offered here — it lives in Workplace below. */}
          <SelectionCard
            title="Locations"
            description="Countries, regions, or cities you want to work in."
            selected={form.preferred_locations}
            catalog={[]}
            search={searchLocations}
            allowCustom
            addLabel="Edit locations"
            searchPlaceholder="Search any country or city, or type your own"
            emptyHint="No preferred locations yet."
            onChange={(values) =>
              setForm((current) => ({ ...current, preferred_locations: values }))
            }
          />

          <fieldset className="rounded-2xl border border-line bg-white p-4">
            <legend className="px-1 text-sm font-semibold">Workplace</legend>
            <p className="mt-1 text-xs text-[var(--text-muted)]">
              How you want to work day to day.
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              {WORKPLACE_OPTIONS.map(([value, label]) => {
                const active = form.remote_preference === value;
                return (
                  <label
                    key={value}
                    className={`focus-within:ring-2 focus-within:ring-[var(--focus-ring)] inline-flex cursor-pointer items-center gap-2 rounded-xl border px-3 py-2 text-sm transition ${
                      active
                        ? "border-pine bg-[var(--success-surface)] font-semibold text-pine"
                        : "border-line text-[var(--text-secondary)] hover:border-[var(--border-strong)]"
                    }`}
                  >
                    <input
                      type="radio"
                      name="workplace"
                      value={value}
                      checked={active}
                      onChange={() =>
                        setForm((current) => ({ ...current, remote_preference: value }))
                      }
                      className="sr-only"
                    />
                    {/* A tick, not just colour: selection must not be conveyed
                        by hue alone. */}
                    <Check
                      aria-hidden
                      className={`h-3.5 w-3.5 ${active ? "opacity-100" : "opacity-0"}`}
                    />
                    {label}
                  </label>
                );
              })}
            </div>
          </fieldset>
        </div>
      )}

      <SaveBar state={save} dirty={dirty} onSave={() => void saveProfile()} onCancel={reload} />
    </EditorShell>
  );
}

/**
 * Selected values first; the catalog only after the user asks for it.
 *
 * A stored value that is not in the catalog — a custom job title, an unusual
 * location — is rendered exactly like any other selection and is never dropped.
 */
function SelectionCard({
  title,
  description,
  selected,
  catalog,
  addLabel,
  searchPlaceholder,
  emptyHint,
  allowCustom = false,
  search,
  onChange
}: {
  title: string;
  description: string;
  selected: string[];
  catalog: { label: string; options: readonly string[] }[];
  /**
   * Dynamic result source, used instead of `catalog` when supplied. The global
   * location vocabulary is far too large to render as static groups, so it is
   * queried per keystroke instead.
   */
  search?: (query: string, options: { exclude: string[] }) => { value: string }[];
  addLabel: string;
  searchPlaceholder: string;
  emptyHint: string;
  allowCustom?: boolean;
  onChange: (values: string[]) => void;
}) {
  const [picking, setPicking] = useState(false);
  const [query, setQuery] = useState("");

  const term = query.trim().toLowerCase();
  const groups = useMemo(() => {
    if (search) {
      // The search source already ranks and caps its results, and it offers the
      // raw query itself as a custom option, so it needs no further filtering.
      const options = search(query, { exclude: selected }).map((item) => item.value);
      return options.length > 0 ? [{ label: "Results", options }] : [];
    }
    return catalog
      .map((group) => ({
        ...group,
        options: group.options.filter((option) => option.toLowerCase().includes(term))
      }))
      .filter((group) => group.options.length > 0);
  }, [catalog, term, search, query, selected]);

  const exactExists =
    !query.trim() ||
    groups.some((group) => group.options.some((option) => option.toLowerCase() === term)) ||
    selected.some((value) => value.toLowerCase() === term);

  function toggle(option: string) {
    onChange(
      selected.includes(option)
        ? selected.filter((item) => item !== option)
        : [...selected, option]
    );
  }

  function addCustom() {
    const value = query.trim();
    if (!value || selected.some((item) => item.toLowerCase() === value.toLowerCase())) return;
    onChange([...selected, value]);
    setQuery("");
  }

  return (
    <section className="rounded-2xl border border-line bg-white p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold">{title}</h2>
          <p className="mt-0.5 text-xs text-[var(--text-muted)]">{description}</p>
        </div>
        <Button
          type="button"
          variant="secondary"
          aria-expanded={picking}
          onClick={() => setPicking((value) => !value)}
        >
          {picking ? "Done" : (<><Plus className="h-4 w-4" aria-hidden /> {addLabel}</>)}
        </Button>
      </div>

      {selected.length > 0 ? (
        <ul className="mt-3 flex flex-wrap gap-1.5">
          {selected.map((value) => (
            <li
              key={value}
              className="inline-flex max-w-full items-center gap-1.5 rounded-lg border border-pine bg-[var(--success-surface)] px-2 py-1 text-xs font-medium text-pine"
            >
              <span className="truncate">{value}</span>
              <button
                type="button"
                aria-label={`Remove ${value}`}
                onClick={() => onChange(selected.filter((item) => item !== value))}
                className="focus-ring shrink-0 rounded transition hover:text-[var(--danger)]"
              >
                <X className="h-3 w-3" aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-3 text-xs text-[var(--text-muted)]">{emptyHint}</p>
      )}

      {picking && (
        <div className="mt-4 border-t border-line pt-3">
          <label htmlFor={`${title}-search`} className="sr-only">
            {searchPlaceholder}
          </label>
          <div className="relative">
            <Search
              aria-hidden
              className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--text-muted)]"
            />
            <input
              id={`${title}-search`}
              value={query}
              placeholder={searchPlaceholder}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && allowCustom) {
                  event.preventDefault();
                  addCustom();
                }
              }}
              className="h-10 w-full rounded-xl border border-line bg-[var(--input-background)] pl-9 pr-3 text-sm"
            />
          </div>

          {allowCustom && query.trim() && !exactExists && (
            <button
              type="button"
              onClick={addCustom}
              className="focus-ring mt-2 inline-flex items-center gap-1 rounded-lg border border-dashed border-line px-2.5 py-1.5 text-xs font-medium text-pine"
            >
              <Plus className="h-3 w-3" aria-hidden /> Add “{query.trim()}”
            </button>
          )}

          <div className="mt-3 grid max-h-72 gap-3 overflow-y-auto">
            {groups.map((group) => (
              <div key={group.label}>
                <h3 className="text-xs font-medium uppercase tracking-[0.08em] text-[var(--text-muted)]">
                  {group.label}
                </h3>
                <ul className="mt-1.5 flex flex-wrap gap-1.5">
                  {group.options.map((option) => {
                    const active = selected.includes(option);
                    return (
                      <li key={option}>
                        <button
                          type="button"
                          aria-pressed={active}
                          onClick={() => toggle(option)}
                          className={`focus-ring inline-flex items-center gap-1 rounded-lg border px-2 py-1 text-xs transition ${
                            active
                              ? "border-pine bg-[var(--success-surface)] font-medium text-pine"
                              : "border-line text-[var(--text-secondary)] hover:border-[var(--border-strong)]"
                          }`}
                        >
                          {/* Selection is marked, not just tinted. */}
                          {active ? (
                            <Check className="h-3 w-3" aria-hidden />
                          ) : (
                            <Plus className="h-3 w-3" aria-hidden />
                          )}
                          {option}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
            {groups.length === 0 && (
              <p className="text-xs text-[var(--text-muted)]">
                Nothing in the catalog matches “{query.trim()}”.
                {allowCustom ? " You can still add it as your own." : ""}
              </p>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

"use client";

import { useMemo, useState } from "react";
import { Plus, Search, X } from "lucide-react";
import { Button } from "@/components/ui";
import { skillSuggestions } from "@/lib/profileCatalog";
import type { ProfileEditorState } from "@/lib/profileEditorData";
import { groupSkills } from "@/lib/skillGroups";
import { EditorShell } from "./EditorShell";
import { SaveBar } from "./primitives";

/** Skills listed inside a group before "+N more". */
const PREVIEW_PER_GROUP = 5;

/**
 * Skills editor.
 *
 * A real profile has 40–80 skills, and the old screen rendered every one as a
 * chip plus a permanent grid of suggestions — impossible to scan. Here the
 * skills are bucketed into domain groups (the same grouping the Profile
 * overview uses), each group previews a few entries, and suggestions appear
 * only once the user starts searching.
 *
 * Grouping is presentation only: `groupSkills` buckets the user's strings
 * without altering them, so nothing is renamed or normalised to fit a category.
 */
export function SkillsEditor({ editor }: { editor: ProfileEditorState }) {
  const { data, loading, loadError, reload, save, setForm, saveProfileSection, dirty } = editor;
  const [query, setQuery] = useState("");
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({});

  // Memoized off `data` itself: `data?.form.skills ?? []` produces a new array
  // identity on every render, which would defeat the memos below.
  const skills = useMemo(() => data?.form.skills ?? [], [data]);
  const targetRoles = useMemo(() => data?.form.target_roles ?? [], [data]);
  const groups = useMemo(() => groupSkills(skills), [skills]);

  /**
   * Suggestions for the user's own target roles, minus what they already have.
   * Only rendered while searching — never a permanent wall of options.
   */
  const suggestions = useMemo(() => {
    const term = query.trim().toLowerCase();
    if (!term) return [];
    const pool = new Set<string>();
    for (const role of targetRoles) {
      for (const skill of skillSuggestions[role] ?? []) pool.add(skill);
    }
    for (const list of Object.values(skillSuggestions)) {
      for (const skill of list) pool.add(skill);
    }
    return [...pool]
      .filter(
        (skill) =>
          skill.toLowerCase().includes(term) &&
          !skills.some((existing) => existing.toLowerCase() === skill.toLowerCase())
      )
      .slice(0, 8);
  }, [query, targetRoles, skills]);

  const alreadyPresent = skills.some(
    (skill) => skill.toLowerCase() === query.trim().toLowerCase()
  );

  function addSkills(raw: string) {
    const additions = raw
      .split(/[,\n]/)
      .map((item) => item.trim())
      .filter(Boolean);
    if (additions.length === 0) return;
    setForm((current) => {
      const next = [...current.skills];
      for (const addition of additions) {
        if (!next.some((existing) => existing.toLowerCase() === addition.toLowerCase())) {
          next.push(addition);
        }
      }
      return { ...current, skills: next };
    });
    setQuery("");
  }

  function removeSkill(skill: string) {
    setForm((current) => ({
      ...current,
      skills: current.skills.filter((item) => item !== skill)
    }));
  }

  return (
    <EditorShell loading={loading} loadError={loadError} onRetry={reload}>
      {/* Search doubles as the add box: type to filter suggestions, press Enter
          to add exactly what you typed, or paste a comma-separated list. */}
      <div className="rounded-card border border-line-default bg-surface-card p-4">
        <label htmlFor="skill-search" className="block text-sm font-medium">
          Add a skill
        </label>
        <div className="mt-1.5 flex gap-2">
          <div className="relative min-w-0 flex-1">
            <Search
              aria-hidden
              className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-foreground-muted"
            />
            <input
              id="skill-search"
              value={query}
              placeholder="Search or type a skill, or paste a comma-separated list"
              aria-describedby="skill-search-hint"
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  addSkills(query);
                }
              }}
              onPaste={(event) => {
                const pasted = event.clipboardData.getData("text");
                if (/[,\n]/.test(pasted)) {
                  event.preventDefault();
                  addSkills(pasted);
                }
              }}
              className="h-10 w-full rounded-card border border-line-default bg-surface-raised pl-9 pr-3 text-sm"
            />
          </div>
          <Button type="button" variant="secondary" onClick={() => addSkills(query)}>
            <Plus className="h-4 w-4" aria-hidden /> Add
          </Button>
        </div>
        <p id="skill-search-hint" className="mt-1 text-xs text-foreground-muted">
          {skills.length} skill{skills.length === 1 ? "" : "s"} on your profile.
        </p>

        {query.trim() && alreadyPresent && (
          <p role="status" className="mt-2 text-xs text-foreground-muted">
            “{query.trim()}” is already on your profile.
          </p>
        )}

        {suggestions.length > 0 && (
          <div className="mt-3">
            <p className="text-xs font-medium uppercase tracking-[0.08em] text-foreground-muted">
              Suggestions
            </p>
            <ul className="mt-1.5 flex flex-wrap gap-1.5">
              {suggestions.map((skill) => (
                <li key={skill}>
                  <button
                    type="button"
                    onClick={() => addSkills(skill)}
                    className="ds-focus-ring inline-flex items-center gap-1 rounded-control border border-dashed border-line-default px-2 py-1 text-xs text-foreground-secondary transition hover:border-line-interactive hover:text-foreground-link"
                  >
                    <Plus className="h-3 w-3" aria-hidden /> {skill}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      {groups.length === 0 ? (
        <p className="mt-4 rounded-card border border-dashed border-line-default bg-surface-subtle px-5 py-8 text-center text-sm text-foreground-muted">
          No skills yet. Skills drive job matching and resume tailoring.
        </p>
      ) : (
        <div className="mt-4 grid gap-3">
          {groups.map((group) => {
            const expanded = expandedGroups[group.name] ?? false;
            const visible = expanded ? group.skills : group.skills.slice(0, PREVIEW_PER_GROUP);
            const hidden = group.skills.length - visible.length;
            return (
              <section key={group.name} className="rounded-card border border-line-default bg-surface-card p-4">
                <h2 className="text-xs font-medium uppercase tracking-[0.08em] text-foreground-muted">
                  {group.name}
                  <span className="ml-1.5 font-normal normal-case tracking-normal">
                    ({group.skills.length})
                  </span>
                </h2>
                <ul className="mt-2 flex flex-wrap gap-1.5">
                  {visible.map((skill) => (
                    <li
                      key={skill}
                      className="inline-flex max-w-full items-center gap-1.5 rounded-control border border-line-default bg-surface-subtle px-2 py-1 text-xs text-foreground-secondary"
                    >
                      <span className="truncate">{skill}</span>
                      <button
                        type="button"
                        aria-label={`Remove ${skill}`}
                        onClick={() => removeSkill(skill)}
                        className="ds-focus-ring shrink-0 rounded text-foreground-muted transition hover:text-status-danger"
                      >
                        <X className="h-3 w-3" aria-hidden />
                      </button>
                    </li>
                  ))}
                </ul>
                {(hidden > 0 || expanded) && (
                  <button
                    type="button"
                    aria-expanded={expanded}
                    onClick={() =>
                      setExpandedGroups((current) => ({ ...current, [group.name]: !expanded }))
                    }
                    className="ds-focus-ring mt-2 text-xs font-medium text-foreground-muted transition hover:text-foreground-link"
                  >
                    {expanded ? "Show fewer" : `+${hidden} more`}
                  </button>
                )}
              </section>
            );
          })}
        </div>
      )}

      <SaveBar
        state={save}
        dirty={dirty}
        onSave={() => void saveProfileSection("skills")}
        onCancel={reload}
      />
    </EditorShell>
  );
}

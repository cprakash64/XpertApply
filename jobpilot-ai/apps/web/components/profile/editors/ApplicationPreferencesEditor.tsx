"use client";

import Link from "next/link";
import { ArrowRight, Lock } from "lucide-react";
import { ApplicationEligibility } from "@/components/ApplicationEligibility";
import { workAuthorizationOptions } from "@/lib/profileCatalog";
import type { ProfileEditorState } from "@/lib/profileEditorData";
import { EditorShell } from "./EditorShell";
import { FieldGroup, SaveBar, SelectField, Toggle } from "./primitives";

/**
 * Application preferences, rebuilt on the shared editor primitives.
 *
 * This screen used to compose its own layout and its own save bar, so it drifted
 * visually from Personal details and Job preferences. It now uses the same
 * `EditorShell`, `FieldGroup`, `SelectField` and `SaveBar` as every other
 * section, and it is mounted through `SectionEditor`, which means it inherits
 * the one unsaved-changes guard rather than needing its own.
 *
 * **The canonical semantics are untouched.** Three kinds of information live
 * here and are deliberately not merged:
 *
 * 1. *Matching preferences* — work-authorization status and relocation, plain
 *    columns on the profile record. Relocation is the one that also reaches
 *    autofill, as canonical `willing_to_relocate`.
 * 2. *Reusable legal answers* — authorization, current sponsorship, future
 *    sponsorship. Three separate canonical keys, each with three states
 *    (Yes / No / answer per application). Rendered by the existing
 *    `ApplicationEligibility` component, which owns their write path; nothing
 *    here re-implements it.
 * 3. *Voluntary demographics* — linked, not inlined, so an optional private
 *    form never sits in the middle of the primary editor.
 *
 * A work-authorization *status* is not a sponsorship answer, and "I need
 * sponsorship now" is not "I will need sponsorship later". Collapsing either
 * pair would put an answer on a real application that the user never gave.
 */
export function ApplicationPreferencesEditor({ editor }: { editor: ProfileEditorState }) {
  const { data, loading, loadError, reload, save, setForm, saveProfile, dirty } = editor;
  const form = data?.form;

  return (
    <EditorShell loading={loading} loadError={loadError} onRetry={reload}>
      {form && (
        <div className="grid gap-4">
          <FieldGroup
            title="Work eligibility"
            description="Used to filter roles you are eligible for. The questions employers actually ask are answered below."
          >
            <SelectField
              label="Work authorization status"
              value={form.work_authorization}
              options={workAuthorizationOptions as readonly (readonly [string, string])[]}
              onChange={(value) =>
                // Deliberately does NOT touch the sponsorship answers. Deriving
                // a legal answer from an immigration status is exactly the
                // inference that produced false statements on real forms.
                setForm((current) => ({ ...current, work_authorization: value }))
              }
            />
            <Toggle
              label="Open to relocation"
              checked={form.open_to_relocation}
              hint="Reused on applications that ask whether you would relocate."
              onChange={(value) =>
                setForm((current) => ({ ...current, open_to_relocation: value }))
              }
            />
          </FieldGroup>

          <section className="rounded-2xl border border-line bg-white p-4">
            <h2 className="text-sm font-semibold">Reusable application answers</h2>
            <p className="mt-1 text-xs text-[var(--text-muted)]">
              Answer once and JobPilot can reuse these. Each question is stored separately —
              “now” and “in the future” are different questions, and “Answer during each
              application” is a real choice, not a blank.
            </p>
            {/* Owns its own immediate write path: each answer is versioned and
                audited server-side the moment it is chosen, which is why it is
                not part of this screen's Save. */}
            <div className="mt-3">
              <ApplicationEligibility />
            </div>
          </section>

          <section className="rounded-2xl border border-line bg-white p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <h2 className="flex items-center gap-2 text-sm font-semibold">
                  Optional demographic information
                  <span className="inline-flex items-center gap-1 rounded-lg border border-line px-1.5 py-0.5 text-xs font-medium text-[var(--text-muted)]">
                    <Lock className="h-3 w-3" aria-hidden /> Private · Optional
                  </span>
                </h2>
                <p className="mt-1 max-w-xl text-xs text-[var(--text-muted)]">
                  Used only to help complete voluntary demographic questions on applications.
                  Never used for job matching, fit scoring, ranking, resume generation, or
                  cover-letter generation.
                </p>
              </div>
              <Link
                href="/profile/eeo"
                className="focus-ring inline-flex h-10 shrink-0 items-center gap-2 rounded-xl border border-line bg-white px-4 text-sm font-medium text-ink transition hover:border-[var(--border-strong)] hover:bg-panel"
              >
                Manage optional information <ArrowRight className="h-3.5 w-3.5" aria-hidden />
              </Link>
            </div>
          </section>
        </div>
      )}

      <SaveBar state={save} dirty={dirty} onSave={() => void saveProfile()} onCancel={reload} />
    </EditorShell>
  );
}

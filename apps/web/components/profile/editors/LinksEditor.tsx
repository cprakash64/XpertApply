"use client";

import { ExternalLink, Globe, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui";
import { GitHubIcon, LinkedInIcon, XIcon } from "@/components/profile/BrandIcons";
import type { ProfileEditorState } from "@/lib/profileEditorData";
import type { ProfileForm, ProfileLink } from "@/lib/profileForm";
import { isValidOptionalUrl } from "@/lib/profileUrls";
import { EditorShell } from "./EditorShell";
import { Field, SaveBar } from "./primitives";

type LinkField = Extract<
  keyof ProfileForm,
  "linkedin_url" | "github_url" | "portfolio_url" | "x_url"
>;

/**
 * The named networks.
 *
 * These stay individual profile columns rather than rows in the open-ended list
 * because they are the ones the extension resolves by name — moving them would
 * change an autofill contract for no user-visible benefit.
 */
const NAMED_LINKS: {
  key: LinkField;
  label: string;
  icon: (props: { className?: string }) => React.ReactNode;
  placeholder: string;
}[] = [
  {
    key: "linkedin_url",
    label: "LinkedIn",
    icon: LinkedInIcon,
    placeholder: "https://linkedin.com/in/your-handle"
  },
  {
    key: "github_url",
    label: "GitHub",
    icon: GitHubIcon,
    placeholder: "https://github.com/your-handle"
  },
  {
    key: "portfolio_url",
    label: "Website / Portfolio",
    icon: Globe,
    placeholder: "https://your-site.dev"
  },
  { key: "x_url", label: "X", icon: XIcon, placeholder: "https://x.com/your-handle" }
];

/** Placeholder rotation for custom rows — examples, never a restriction. */
const CUSTOM_EXAMPLES = [
  "Google Scholar",
  "Kaggle",
  "Hugging Face",
  "Medium",
  "Stack Overflow",
  "ResearchGate"
];

/**
 * Profile links.
 *
 * Two tiers: the four named networks above, and an open-ended list for
 * everything else — Google Scholar, Kaggle, a personal blog. Validation is the
 * shared `isValidOptionalUrl` rule the wizard uses (empty is fine, anything
 * present must be http(s)), so every screen accepts exactly the same values and
 * a `javascript:` URL is refused before it can be saved. The API enforces the
 * same rule independently via `HttpUrl`.
 */
/**
 * The links form itself, without any save controls.
 *
 * Shared by the standalone Links editor and by Personal details, so "Edit
 * contact" reaches LinkedIn, GitHub, X and the custom links rather than sending
 * the user hunting for a second screen. One implementation, two hosts.
 */
export function ProfileLinksFields({ editor }: { editor: ProfileEditorState }) {
  const { data, fieldErrors, setForm } = editor;
  const form = data?.form;
  if (!form) return null;

  function updateLink(index: number, patch: Partial<ProfileLink>) {
    setForm((current) => ({
      ...current,
      additional_links: current.additional_links.map((link, position) =>
        position === index ? { ...link, ...patch } : link
      )
    }));
  }

  return (
    <div className="grid gap-4">
      <section className="rounded-card border border-line-default bg-surface-card p-4">
        <h2 className="text-sm font-semibold">Professional links</h2>
        <ul className="mt-3 grid gap-3">
          {NAMED_LINKS.map(({ key, label, icon: Icon, placeholder }) => {
            const value = form[key] as string;
            const bad = !isValidOptionalUrl(value);
            const error = fieldErrors[key] ?? (bad ? "Enter a complete HTTP(S) web address." : undefined);
            return (
              <li key={key} className="flex items-start gap-3">
                <span
                  aria-hidden
                  className="mt-6 grid h-9 w-9 shrink-0 place-items-center rounded-card bg-surface-subtle text-foreground-muted"
                >
                  <Icon className="h-4 w-4" />
                </span>
                <div className="min-w-0 flex-1">
                  <Field
                    label={label}
                    type="url"
                    value={value}
                    placeholder={placeholder}
                    error={error}
                    onChange={(next) => setForm((current) => ({ ...current, [key]: next }))}
                  />
                </div>
                {/* Only offered once the value is actually openable. */}
                {value && !bad && (
                  <a
                    href={value}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label={`Open your ${label} profile in a new tab`}
                    className="ds-focus-ring mt-6 grid h-9 w-9 shrink-0 place-items-center rounded-card text-foreground-muted transition hover:bg-surface-subtle hover:text-foreground-link"
                  >
                    <ExternalLink className="h-4 w-4" aria-hidden />
                  </a>
                )}
              </li>
            );
          })}
        </ul>
      </section>

      <section className="rounded-card border border-line-default bg-surface-card p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold">Other links</h2>
            <p className="mt-0.5 text-xs text-foreground-muted">
              Anything else worth showing — Google Scholar, Kaggle, a blog.
            </p>
          </div>
          <Button
            type="button"
            variant="secondary"
            onClick={() =>
              setForm((current) => ({
                ...current,
                additional_links: [...current.additional_links, { label: "", url: "" }]
              }))
            }
          >
            <Plus className="h-4 w-4" aria-hidden /> Add another link
          </Button>
        </div>

        {form.additional_links.length === 0 ? (
          <p className="mt-3 text-xs text-foreground-muted">No other links yet.</p>
        ) : (
          <ul className="mt-3 grid gap-3">
            {form.additional_links.map((link, index) => {
              const badUrl = link.url.trim() !== "" && !isValidOptionalUrl(link.url);
              const missingLabel = link.url.trim() !== "" && link.label.trim() === "";
              const urlError =
                fieldErrors[`additional_links.${index}.url`] ??
                (badUrl ? "Enter a complete HTTP(S) web address." : undefined);
              const labelError =
                fieldErrors[`additional_links.${index}.label`] ??
                (missingLabel ? "Give this link a name." : undefined);
              return (
                <li key={index} className="rounded-card border border-line-default bg-surface-subtle p-3">
                  {/* Stacks on mobile so neither field is squeezed. */}
                  <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)_auto] sm:items-start">
                    <Field
                      label="Label"
                      value={link.label}
                      placeholder={CUSTOM_EXAMPLES[index % CUSTOM_EXAMPLES.length]}
                      error={labelError}
                      onChange={(next) => updateLink(index, { label: next })}
                    />
                    <Field
                      label="URL"
                      type="url"
                      value={link.url}
                      placeholder="https://..."
                      error={urlError}
                      onChange={(next) => updateLink(index, { url: next })}
                    />
                    <Button
                      type="button"
                      variant="secondary"
                      aria-label={`Remove ${link.label.trim() || "this link"}`}
                      className="sm:mt-6"
                      onClick={() =>
                        setForm((current) => ({
                          ...current,
                          additional_links: current.additional_links.filter(
                            (_, position) => position !== index
                          )
                        }))
                      }
                    >
                      <Trash2 className="h-4 w-4" aria-hidden />
                      <span className="sm:sr-only">Remove</span>
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}

/**
 * Every link problem currently blocking a save, for the host editor's banner.
 * Exported so Personal details can gate its own Save on the links it now hosts.
 */
export function linkProblemCount(editor: ProfileEditorState): number {
  const form = editor.data?.form;
  if (!form) return 0;
  const named = NAMED_LINKS.filter(({ key }) => !isValidOptionalUrl(form[key] as string)).length;
  const badUrls = form.additional_links.filter(
    (link) => link.url.trim() !== "" && !isValidOptionalUrl(link.url)
  ).length;
  const missingLabels = form.additional_links.filter(
    (link) => link.url.trim() !== "" && link.label.trim() === ""
  ).length;
  const serverErrors = Object.keys(editor.fieldErrors).filter(
    (path) => NAMED_LINKS.some(({ key }) => key === path) || path.startsWith("additional_links.")
  ).length;
  return named + badUrls + missingLabels + serverErrors;
}

/**
 * The standalone Links screen.
 *
 * Still reachable in its own right (the wizard's Links step routes here), and
 * renders the same fields Personal details embeds.
 */
export function LinksEditor({ editor }: { editor: ProfileEditorState }) {
  const { loading, loadError, reload, save, saveProfileSection, dirty } = editor;
  const problemCount = linkProblemCount(editor);

  return (
    <EditorShell loading={loading} loadError={loadError} onRetry={reload}>
      <ProfileLinksFields editor={editor} />

      {problemCount > 0 && (
        <p role="alert" className="mt-4 text-sm text-status-danger">
          Fix the highlighted link{problemCount === 1 ? "" : "s"} before saving.
        </p>
      )}

      <SaveBar
        state={save}
        dirty={dirty}
        disabled={problemCount > 0}
        onSave={() => void saveProfileSection("links")}
        onCancel={reload}
      />
    </EditorShell>
  );
}

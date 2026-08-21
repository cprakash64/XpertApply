"use client";

import { workAuthorizationOptions } from "@/lib/profileCatalog";
import type { ProfileEditorState } from "@/lib/profileEditorData";
import { validateApplicationEmail } from "@/lib/emailValidation";
import { EditorShell } from "./EditorShell";
import { Field, FieldGroup, SaveBar, SelectField } from "./primitives";
import { ProfileLinksFields, linkProblemCount } from "./LinksEditor";

/**
 * Personal information, grouped into Identity / Contact / Location so the form
 * reads as three short sections instead of one long column of inputs.
 *
 * Deliberately absent: the stored Workday portal credential. It is a secret
 * that belongs to the assisted-apply flow, not to canonical personal data, and
 * it is never displayed or re-collected here.
 */
export function PersonalEditor({ editor }: { editor: ProfileEditorState }) {
  const {
    data,
    fieldErrors,
    loading,
    loadError,
    reload,
    save,
    setForm,
    saveProfileSection,
    dirty
  } = editor;
  const form = data?.form;

  const emailProblem = validateApplicationEmail(form?.application_email) ?? "";
  const nameMissing = Boolean(form && (!form.first_name.trim() || !form.last_name.trim()));
  const linkProblems = linkProblemCount(editor);

  return (
    <EditorShell loading={loading} loadError={loadError} onRetry={reload}>
      {form && (
        <div className="grid gap-4">
          <FieldGroup
            title="Identity"
            description="Your legal name as it should appear on applications."
          >
            <Field
              label="First name"
              value={form.first_name}
              error={!form.first_name.trim() ? "Required." : undefined}
              onChange={(value) => setForm((current) => ({ ...current, first_name: value }))}
            />
            <Field
              label="Middle name"
              value={form.middle_name}
              hint="Optional."
              onChange={(value) => setForm((current) => ({ ...current, middle_name: value }))}
            />
            <Field
              label="Last name"
              value={form.last_name}
              error={!form.last_name.trim() ? "Required." : undefined}
              onChange={(value) => setForm((current) => ({ ...current, last_name: value }))}
            />
            <div className="hidden sm:block" aria-hidden />
            <Field
              label="Preferred first name"
              value={form.preferred_first_name}
              hint="What you would like to be called, if different."
              onChange={(value) =>
                setForm((current) => ({ ...current, preferred_first_name: value }))
              }
            />
            <Field
              label="Preferred last name"
              value={form.preferred_last_name}
              hint="Optional."
              onChange={(value) =>
                setForm((current) => ({ ...current, preferred_last_name: value }))
              }
            />
          </FieldGroup>

          <FieldGroup
            title="Contact"
            description="Used to fill in application forms. Your sign-in email is changed in Settings."
          >
            <Field
              label="Application email"
              type="email"
              value={form.application_email}
              error={(fieldErrors.application_email ?? emailProblem) || undefined}
              hint={!emailProblem ? "The address employers should reply to." : undefined}
              onChange={(value) =>
                setForm((current) => ({ ...current, application_email: value }))
              }
            />
            <Field
              label="Sign-in email"
              value={form.email}
              disabled
              hint="Changed in Settings."
              onChange={() => {}}
            />
            <Field
              label="Phone"
              type="tel"
              value={form.phone}
              placeholder="(602) 555-0147"
              error={fieldErrors.phone}
              onChange={(value) => setForm((current) => ({ ...current, phone: value }))}
            />
            <Field
              label="Phone country"
              value={form.phone_country_iso2}
              hint="Two-letter country code, e.g. US."
              onChange={(value) =>
                setForm((current) => ({
                  ...current,
                  phone_country_iso2: value.toUpperCase().slice(0, 2)
                }))
              }
            />
          </FieldGroup>

          <FieldGroup title="Location" description="Where you are based.">
            <Field
              label="City"
              value={form.location_city}
              error={fieldErrors.location_city}
              onChange={(value) => setForm((current) => ({ ...current, location_city: value }))}
            />
            <Field
              label="State / region"
              value={form.location_state}
              error={fieldErrors.location_state}
              onChange={(value) => setForm((current) => ({ ...current, location_state: value }))}
            />
            <Field
              label="Postal code"
              value={form.location_postal_code}
              error={fieldErrors.location_postal_code}
              onChange={(value) =>
                setForm((current) => ({ ...current, location_postal_code: value }))
              }
            />
            <Field
              label="Country"
              value={form.location_country}
              error={fieldErrors.location_country}
              onChange={(value) =>
                setForm((current) => ({ ...current, location_country: value }))
              }
            />
          </FieldGroup>

          <FieldGroup
            title="Work authorization"
            description="Used to filter roles you are eligible for. This is a matching preference — the legal questions applications ask are answered separately."
          >
            <SelectField
              label="Status"
              value={form.work_authorization}
              error={fieldErrors.work_authorization}
              options={workAuthorizationOptions as readonly (readonly [string, string])[]}
              onChange={(value) =>
                // Deliberately does not touch requires_sponsorship: deriving a
                // sponsorship answer from an immigration status is inference the
                // user has to make themselves.
                setForm((current) => ({ ...current, work_authorization: value }))
              }
              className="sm:col-span-2"
            />
          </FieldGroup>

          {/* The Contact card on the overview lists LinkedIn, GitHub, X and any
              custom links, so its Edit action has to reach them. Same fields as
              the standalone Links screen, one implementation. */}
          <ProfileLinksFields editor={editor} />
        </div>
      )}

      {nameMissing && (
        <p role="alert" className="mt-4 text-sm text-status-danger">
          First and last name are required before this section can be saved.
        </p>
      )}

      {linkProblems > 0 && (
        <p role="alert" className="mt-4 text-sm text-status-danger">
          Fix the highlighted link{linkProblems === 1 ? "" : "s"} before saving.
        </p>
      )}

      <SaveBar
        state={save}
        dirty={dirty}
        disabled={nameMissing || linkProblems > 0}
        onSave={() => void saveProfileSection("personal")}
        onCancel={reload}
      />
    </EditorShell>
  );
}

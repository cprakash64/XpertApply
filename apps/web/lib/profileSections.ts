/**
 * The profile wizard's step order, and the section slugs the focused editor
 * routes use.
 *
 * This lives in its own module — not in ProfileWizard.tsx — because that file
 * is a `"use client"` module. Every export of a client module becomes a client
 * *reference* when a server component imports it, so a server page reading
 * `WIZARD_STEPS[section]` from there gets `undefined` rather than the number,
 * and every editor route silently opens on step 0. A plain shared module is
 * importable from both sides and keeps one definition of the order.
 */

/**
 * The wizard's step order.
 *
 * `eeo` is deliberately absent: the voluntary demographic questions are no
 * longer a step in the career profile. They live at
 * /profile/application-preferences, beside the other application-time answers,
 * and /profile/eeo redirects there.
 */
export const WIZARD_STEPS = {
  import: 0,
  personal: 1,
  preferences: 2,
  education: 3,
  experience: 4,
  projects: 5,
  skills: 6,
  links: 7,
  review: 8
} as const;

export type WizardSection = keyof typeof WIZARD_STEPS;

/**
 * Sections that have a purpose-built focused editor. Everything else — import,
 * the full wizard, the voluntary EEO questions, review — still runs the wizard,
 * which remains the onboarding and import experience.
 *
 * Most map onto a wizard step, but they are not required to: `credentials`
 * (Certifications & Awards) is a first-class profile section the onboarding
 * wizard never had. The wizard's step list and the set of editable sections are
 * related, not identical.
 *
 * This lives here, beside WIZARD_STEPS, for the same reason: the route that
 * branches on it is a server component, and a function exported from a
 * `"use client"` module cannot be *called* from the server at all.
 */
export const FOCUSED_SECTIONS = [
  "personal",
  "preferences",
  "education",
  "experience",
  "projects",
  "skills",
  "links",
  "credentials",
  "publications",
  "application-preferences"
] as const;

export type FocusedSection = (typeof FOCUSED_SECTIONS)[number];

/** Focused sections that are also a step in the onboarding wizard. */
export type WizardBackedSection = FocusedSection & WizardSection;

export function isFocusedSection(section: string): section is FocusedSection {
  return (FOCUSED_SECTIONS as readonly string[]).includes(section);
}

/** True when the section corresponds to a wizard step the editor can open on. */
export function isWizardSection(section: string): section is WizardSection {
  return section in WIZARD_STEPS;
}

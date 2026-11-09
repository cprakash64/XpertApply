/**
 * Workday step recognition, trust boundaries and safe-navigation targets (EXT-LIVE-05W).
 *
 * Pure DOM reads. Nothing here clicks, types or stores anything.
 *
 * Evidence level: the `data-automation-id` names below come from public descriptions of Workday's
 * candidate-experience markup and from owned fixtures. They were NOT verified against a live tenant in
 * this build (no authorized Workday session was available). Every lookup therefore has a visible-text
 * fallback, and an unrecognised page is reported as `unknown_step`, which pauses instead of guessing.
 */

export type WorkdayStepKind =
  | "job_description"   // posting page with an Apply action, no form
  | "start_choice"      // Autofill with Resume / Apply Manually / Use My Last Application
  | "sign_in"           // authentication boundary
  | "create_account"    // account-creation boundary
  | "verification"      // email/phone code, CAPTCHA, MFA
  | "my_information"
  | "my_experience"
  | "application_questions"
  | "voluntary_disclosures"
  | "self_identify"
  | "review"            // final boundary: never advanced past by XpertApply
  | "ambiguous_submit"  // a Submit button on a step the employer labels as an ordinary application step
  | "unknown_step";

/** Kinds where XpertApply must stop and hand control to the person. */
export const USER_BOUNDARY_KINDS: ReadonlySet<WorkdayStepKind> = new Set([
  "sign_in", "create_account", "verification", "start_choice", "voluntary_disclosures", "self_identify", "ambiguous_submit"
]);

const text = (el: Element | null | undefined): string => (el?.textContent || (el as HTMLInputElement | null)?.value || "").replace(/\s+/g, " ").trim();
const auto = (doc: ParentNode, id: string): HTMLElement | null => doc.querySelector<HTMLElement>(`[data-automation-id="${id}"]`);

function visible(el: HTMLElement): boolean {
  const style = el.ownerDocument.defaultView?.getComputedStyle(el);
  return style?.display !== "none" && style?.visibility !== "hidden" && el.getAttribute("aria-hidden") !== "true";
}

function usable(el: HTMLElement): boolean {
  return visible(el) && !el.matches(":disabled") && el.getAttribute("aria-disabled") !== "true";
}

export function workdayControls(doc: ParentNode): HTMLElement[] {
  return Array.from(doc.querySelectorAll<HTMLElement>("button,[role=button],input[type=submit],input[type=button]"));
}

function activeStepLabel(doc: ParentNode): string {
  const el = doc.querySelector('[aria-current="step"], [data-automation-id="progressBarActiveStep"], [data-automation-id*="progressBarActive" i]');
  return text(el).replace(/^(current\s+step\s*\d*\s*of\s*\d*\s*)/i, "").toLowerCase();
}

function headings(doc: ParentNode): string {
  return Array.from(doc.querySelectorAll("h1,h2,h3,[role=heading]")).map(text).join(" | ").toLowerCase();
}

function hasCaptcha(doc: ParentNode): boolean {
  return Boolean(doc.querySelector('iframe[src*="recaptcha" i], iframe[src*="hcaptcha" i], iframe[src*="captcha" i], [class*="g-recaptcha" i], [data-automation-id*="captcha" i], .h-captcha'));
}

/** Final-submission control. Presence of any one means the page is the review/submit boundary. */
export function findWorkdayFinalSubmit(doc: ParentNode): HTMLElement | null {
  for (const control of workdayControls(doc)) {
    if (!usable(control)) continue;
    const id = (control.getAttribute("data-automation-id") || "").toLowerCase();
    if (/^(signin|createaccount)/.test(id) || /signinsubmit|createaccountsubmit/.test(id)) continue;
    if (id === "pagefootersubmitbutton" || id === "bottom-navigation-submit-button") return control;
    if (/^(submit|submit application|finish)$/i.test(text(control))) return control;
  }
  return null;
}

export function classifyWorkdayStep(doc: ParentNode): WorkdayStepKind {
  const step = activeStepLabel(doc);
  if (findWorkdayFinalSubmit(doc)) {
    // A Submit that sits on a step the employer's own progress bar names as an ordinary section is NOT proof of a review
    // page. Treat it as uncertain: stop and say so, never advance and never claim "ready for review".
    return /(my information|my experience|application questions|voluntary disclosures|self identify)/.test(step) ? "ambiguous_submit" : "review";
  }
  const heads = headings(doc);
  if (/^(review|preview)\b/.test(step) || /\breview (your )?application\b|^review$|\| review\b/.test(heads)) return "review";

  const hasPassword = Boolean(doc.querySelector('input[type="password"]'));
  const verifyInput = doc.querySelector('input[autocomplete="one-time-code"], [data-automation-id*="verification" i] input, [data-automation-id*="verificationCode" i]');
  if (hasCaptcha(doc) || verifyInput || /\b(verify your (email|identity|phone)|verification code|two-factor|multi-factor|security check)\b/.test(heads)) return "verification";
  if (auto(doc, "createAccountSubmitButton") || auto(doc, "createAccountCheckbox") || (hasPassword && doc.querySelectorAll('input[type="password"]').length >= 2)) return "create_account";
  if (auto(doc, "signInSubmitButton") || (hasPassword && /sign in|log in/.test(heads))) return "sign_in";

  if (/my information/.test(step)) return "my_information";
  if (/my experience/.test(step)) return "my_experience";
  if (/application questions/.test(step)) return "application_questions";
  if (/voluntary disclosures/.test(step)) return "voluntary_disclosures";
  if (/self identify/.test(step)) return "self_identify";
  if (/my information/.test(heads)) return "my_information";
  if (/my experience/.test(heads)) return "my_experience";
  if (/application questions|additional questions/.test(heads)) return "application_questions";
  if (/voluntary disclosures/.test(heads)) return "voluntary_disclosures";
  if (/self[- ]identify|self identification/.test(heads)) return "self_identify";

  const labels = workdayControls(doc).filter(usable).map((c) => text(c).toLowerCase());
  if (labels.some((l) => /^(autofill with resume|apply manually|use my last application)$/.test(l))) return "start_choice";
  const formControls = doc.querySelectorAll("input:not([type=hidden]):not([type=password]),select,textarea").length;
  if (formControls === 0 && labels.includes("apply")) return "job_description";
  return "unknown_step";
}

/**
 * The single control XpertApply may activate to move forward inside an application. Never Submit, never
 * Sign in / Create account, never the start-choice buttons (those involve credentials or a document the
 * person chooses). Returns null at any boundary.
 */
export function findWorkdaySafeNext(doc: ParentNode): HTMLElement | null {
  const kind = classifyWorkdayStep(doc);
  if (!["my_information", "my_experience", "application_questions", "unknown_step"].includes(kind)) return null;
  for (const id of ["pageFooterNextButton", "bottom-navigation-next-button"]) {
    const el = auto(doc, id);
    if (el && usable(el)) return el;
  }
  const controls = workdayControls(doc).filter(usable);
  for (const label of ["save and continue", "next", "continue"]) {
    const match = controls.find((c) => text(c).toLowerCase() === label);
    if (match) return match;
  }
  return null;
}

/** Visible validation failures on the current step (counts only; no values). */
export function workdayValidationErrors(doc: ParentNode): number {
  const banner = Array.from(doc.querySelectorAll<HTMLElement>('[data-automation-id="errorBanner"], [data-automation-id="errorMessage"], [role="alert"]')).filter((e) => visible(e) && text(e).length > 0);
  const invalid = Array.from(doc.querySelectorAll<HTMLElement>('[aria-invalid="true"]')).filter(visible);
  return banner.length + invalid.length;
}

/** Workday `data-automation-id` -> the plain label the generic mapper already understands. */
const AUTOMATION_LABELS: Readonly<Record<string, string>> = {
  "legalNameSection_firstName": "First Name",
  "legalNameSection_middleName": "Middle Name",
  "legalNameSection_lastName": "Last Name",
  "preferredNameSection_firstName": "Preferred First Name",
  "preferredNameSection_lastName": "Preferred Last Name",
  "email": "Email Address",
  "phone-number": "Phone Number",
  "phone-extension": "Phone Extension",
  "addressSection_addressLine1": "Address Line 1",
  "addressSection_addressLine2": "Address Line 2",
  "addressSection_city": "City",
  "addressSection_postalCode": "Postal Code",
  "addressSection_countryRegion": "State",
  "countryDropdown": "Country",
  "country-phone-code": "Country Phone Code",
  "phone-device-type": "Phone Device Type",
  "jobTitle": "Job Title",
  "companyName": "Company",
  "school": "School or University",
  "degree": "Degree",
  "fieldOfStudy": "Field of Study",
  "gpa": "Overall Result (GPA)"
};

export function workdayAutomationLabel(el: Element): string | null {
  let node: Element | null = el;
  for (let depth = 0; node && depth < 4; depth++, node = node.parentElement) {
    const id = node.getAttribute("data-automation-id");
    if (id && AUTOMATION_LABELS[id]) return AUTOMATION_LABELS[id]!;
  }
  return null;
}

/** Step position, only when the employer's own progress bar exposes it. Never inferred or invented. */
export function workdayProgress(doc: ParentNode): { index: number; total: number; label: string } | null {
  const items = Array.from(doc.querySelectorAll<HTMLElement>('[data-automation-id="progressBar"] li, [data-automation-id="progressBarItem"], ol[data-automation-id*="progress" i] > li'));
  if (items.length < 2) return null;
  const at = items.findIndex((i) => i.getAttribute("aria-current") === "step" || i.matches('[data-automation-id="progressBarActiveStep"]') || Boolean(i.querySelector('[aria-current="step"], [data-automation-id="progressBarActiveStep"]')));
  if (at < 0) return null;
  return { index: at + 1, total: items.length, label: text(items[at]).replace(/^(current\s+step\s*\d*\s*of\s*\d*\s*)/i, "") };
}

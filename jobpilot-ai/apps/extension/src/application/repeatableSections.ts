import type { ApplicationSessionData, DiscoveredField } from "../types";
import { discoverFields } from "../fields/discovery";
import { fillField } from "../fields/fill";
import {
  deepAccessibleName,
  deepContains,
  deepQuery,
  deepQueryAll,
  deepTextContent
} from "../dom/deepDom";
import { findAddControl, findSections, type SectionMatch } from "./sectionControls";
import { buildSelfIntroduction, canonicalUrlKey, type SectionEnum } from "./sectionData";

export type SectionPolicy = "AUTO_FILL_SAFE" | "FILL_AND_REVIEW" | "REVIEW_ONLY" | "SKIP";
export type SectionTerminalReason =
  | "NO_CONFIRMED_PROFILE_RECORDS"
  | "CANDIDATE_RECORDS_AVAILABLE"
  | "ADD_CONTROL_NOT_FOUND"
  | "EDITOR_OPEN_FAILED"
  | "EDITOR_FIELDS_UNRESOLVED"
  | "REQUIRED_RECORD_FIELD_MISSING"
  | "DUPLICATE_ALREADY_PRESENT"
  | "RECORD_ADDED_AND_VERIFIED"
  | "SECTION_POLICY_REVIEW_ONLY"
  | "UNSUPPORTED_SECTION"
  | "RECORD_SAVE_FAILED"
  | "RECORD_VERIFICATION_FAILED";
export interface SectionRecord { id: string; identity: string; values: Record<string, string>; }
export interface SectionTrace {
  sectionKind: SectionEnum;
  required: boolean;
  policy: SectionPolicy;
  existingItemCount: number;
  candidateRecordCount: number;
  recordsAdded: number;
  duplicatesSkipped: number;
  incompleteSkipped: number;
  candidateRecordIds: string[];
  failureCode: SectionTerminalReason | null;
}

export interface StructuredCandidateCounts {
  projects: number;
  awards: number;
  languages: number;
  professionalLinks: number;
  workSamples: number;
  selfIntroductionSourceFacts: number;
  reviewedResumeExtraction: number;
}

export interface RepeatableSectionAdapter {
  identify(section: SectionMatch): SectionEnum | null;
  inspectExistingItems(section: SectionMatch): Promise<string[]>;
  getCandidateRecords(kind: SectionEnum, session: ApplicationSessionData): SectionRecord[];
  findMissingRecords(existing: string[], candidates: SectionRecord[]): SectionRecord[];
  openEditor(section: SectionMatch): Promise<HTMLElement | null>;
  discoverEditorFields(editor: HTMLElement): Promise<DiscoveredField[]>;
  fillRecord(editor: HTMLElement, record: SectionRecord, kind?: SectionEnum): Promise<boolean>;
  save(editor: HTMLElement): Promise<boolean>;
  verifySavedRecord(root: ParentNode, kind: SectionEnum, record: SectionRecord): Promise<boolean>;
}

const POLICY: Record<SectionEnum, SectionPolicy> = {
  // Work history and education come from the user's own confirmed profile
  // records, entered and reviewed by them in XpertApply. They are the two sections
  // an application is most incomplete without.
  work_experience: "AUTO_FILL_SAFE",
  education: "AUTO_FILL_SAFE",
  internship_experience: "REVIEW_ONLY",
  project_experience: "AUTO_FILL_SAFE",
  work_samples: "AUTO_FILL_SAFE",
  honors_awards: "AUTO_FILL_SAFE",
  language_skills: "AUTO_FILL_SAFE",
  self_introduction: "FILL_AND_REVIEW",
  sns: "AUTO_FILL_SAFE"
};

export class GenericRepeatableSectionAdapter implements RepeatableSectionAdapter {
  identify(section: SectionMatch): SectionEnum | null { return section.section; }

  async inspectExistingItems(section: SectionMatch): Promise<string[]> {
    const items = deepQueryAll<HTMLElement>(section.container, "article,li,[role=listitem],[data-record],.card")
      .map((item) => normalize(deepTextContent(item, 4000)))
      .filter(Boolean);
    // A section that renders entries as plain divs (SmartRecruiters, TikTok)
    // exposes no list markup at all. Its whole text is then the only evidence of
    // what is already there — enough for the duplicate check, which is all this
    // is used for.
    if (items.length > 0) return items;
    const whole = normalize(deepTextContent(section.container, 8000));
    return whole ? [whole] : [];
  }

  getCandidateRecords(kind: SectionEnum, session: ApplicationSessionData): SectionRecord[] {
    const profile = session.profileData ?? {};
    if (kind === "work_experience") {
      return objectRecords(profile.experience).flatMap((item, index) => {
        const company = text(item.company);
        const title = text(item.title);
        // An entry the destination could not store is not offered at all: a row
        // with neither an employer nor a role is not a work history.
        if (!company && !title) return [];
        return [{
          id: recordId("experience", item.id, index),
          identity: identity([company, title, text(item.start_date)]),
          values: {
            company, title, location: text(item.location),
            start_date: text(item.start_date), end_date: text(item.end_date),
            currently_working: item.currently_working === true ? "true" : "",
            description: experienceDescription(item)
          }
        }];
      });
    }
    if (kind === "education") {
      return objectRecords(profile.education).flatMap((item, index) => {
        const school = text(item.school);
        if (!school) return [];
        return [{
          id: recordId("education", item.id, index),
          identity: identity([school, text(item.degree), text(item.major)]),
          values: {
            school, degree: text(item.degree), major: text(item.major), minor: text(item.minor),
            start_date: text(item.start_date), end_date: text(item.end_date),
            gpa: text(item.gpa)
          }
        }];
      });
    }
    if (kind === "project_experience") {
      return objectRecords(profile.projects).flatMap((item, index) => {
        const name = text(item.name); if (!name) return [];
        const url = firstString(item.links);
        return [{ id: recordId("project", item.id, index), identity: identity([name, url, text(item.start_date), text(item.end_date)]), values: {
          name, description: text(item.description), technologies: stringList(item.technologies).join(", "),
          url, start_date: text(item.start_date), end_date: text(item.end_date)
        } }];
      });
    }
    if (kind === "honors_awards") {
      return objectRecords(profile.awards).flatMap((item, index) => {
        const name = text(item.name); if (!name) return [];
        return [{ id: recordId("award", item.id, index), identity: identity([name, text(item.issuer), text(item.date)]), values: {
          name, issuer: text(item.issuer), date: text(item.date), description: text(item.description)
        } }];
      });
    }
    if (kind === "language_skills") {
      return objectRecords(profile.languages).flatMap((item, index) => {
        const language = text(item.language); const proficiency = text(item.proficiency);
        return language && proficiency
          ? [{ id: `language-${index}`, identity: identity([language]), values: { language, proficiency } }]
          : [];
      });
    }
    if (kind === "work_samples" || kind === "sns") {
      const raw = [profile.linkedin_url, profile.github_url, profile.portfolio_url]
        .filter((value): value is string => typeof value === "string" && /^https:\/\//i.test(value));
      return raw.map((url, index) => ({
        id: `link-${index}`, identity: canonicalUrlKey(url), values: { url, title: platformTitle(url) }
      }));
    }
    if (kind === "self_introduction") {
      const intro = buildSelfIntroduction({
        jobTitle: session.jobTitle ?? undefined,
        company: session.company ?? undefined,
        qualifications: stringList(profile.skills).slice(0, 2),
        highlight: objectRecords(profile.projects)[0]
          ? { title: text(objectRecords(profile.projects)[0].name), description: text(objectRecords(profile.projects)[0].description) }
          : undefined,
        careerFocus: stringList(profile.target_roles)[0]
      });
      return intro ? [{ id: "self-introduction", identity: identity([intro]), values: { description: intro } }] : [];
    }
    // Experience records currently do not carry an explicitly confirmed
    // internship classification. Never infer it from a title.
    return [];
  }

  findMissingRecords(existing: string[], candidates: SectionRecord[]): SectionRecord[] {
    return candidates.filter((record) => !existing.some((value) => value.includes(record.identity) || record.identity.split("|").every((part) => !part || value.includes(part))));
  }

  async openEditor(section: SectionMatch): Promise<HTMLElement | null> {
    // An editor the destination rendered for us. The live ServiceNow
    // (SmartRecruiters) Experience and Education sections ship a blank entry
    // form already open beside their "+ Add" button; pressing Add there appends
    // a SECOND blank row and leaves the one the user is looking at untouched.
    const alreadyOpen = renderedEmptyEditor(section);
    if (alreadyOpen) return alreadyOpen;

    const add = findAddControl(section);
    if (!add || !add.isConnected) return null;
    const before = new Set(deepQueryAll<HTMLElement>(document, "[role=dialog],[aria-modal=true],form,fieldset"));
    const beforeFieldCount = discoverFields(section.container).length;
    add.scrollIntoView?.({ block: "center" });
    add.click();
    // The container is polled directly rather than re-running section discovery
    // on every tick: on a web-component application that scan is a whole-page
    // shadow walk (~50ms), and doing it 60 times would block the page for
    // seconds while the editor was already open.
    return await waitFor(() => {
      const dialogs = deepQueryAll<HTMLElement>(document, "[role=dialog],[aria-modal=true]");
      const addedDialog = dialogs.find((item) => !before.has(item));
      if (addedDialog) return addedDialog;
      // An INLINE editor (SmartRecruiters, TikTok) has no dialog: the section
      // container simply grows a set of fields. More fields than before is the
      // only reliable signal that Add did something.
      const container = section.container.isConnected
        ? section.container
        : findSections(document).find((item) => item.section === section.section)?.container ?? null;
      if (container && discoverFields(container).length > beforeFieldCount) return container;
      return null;
    }, 2500);
  }

  async discoverEditorFields(editor: HTMLElement): Promise<DiscoveredField[]> { return discoverFields(editor); }

  async fillRecord(editor: HTMLElement, record: SectionRecord, kind?: SectionEnum): Promise<boolean> {
    const fields = await this.discoverEditorFields(editor);
    const requirements = fields.filter((field) => field.required);
    for (const field of fields) {
      if (isPickerNavigation(field)) continue;
      const key = recordKey(field, kind);
      const value = key ? datePartFor(field, key, record.values) : "";
      if (!value || field.existingValue.trim()) continue;
      const outcome = await fillField(field, value, {
        status: key === "description" ? "review" : "verified",
        // A location/company/school picker needs a SHORT query: the remote
        // search behind it matches a name, not a full "City, State, Country".
        dropdownSearchValue: searchQueryFor(value)
      });
      if (outcome.status !== "filled" && outcome.status !== "skipped" && field.required) return false;
    }
    return requirements.every((field) => field.existingValue.trim() || Boolean(field.element && liveValue(field.element)));
  }

  /**
   * Commit the entry.
   *
   * Two shapes are both correct and must be told apart:
   *  • a modal/dialog editor, which is committed by its Save/Done control and
   *    disappears — that control not existing is a genuine failure;
   *  • an INLINE editor whose fields ARE the entry (SmartRecruiters renders one
   *    directly in the section). Some inline editors still offer Save; those
   *    that do not are already committed, and demanding a Save control there
   *    reported RECORD_SAVE_FAILED on a row that had been filled correctly.
   */
  async save(editor: HTMLElement): Promise<boolean> {
    const save = dedupeInnermost(deepQueryAll<HTMLElement>(editor, "button,[role=button]")).find((item) => {
      const name = deepAccessibleName(item);
      return /^(save|done|add (?:project|award|language|link|sample|experience|education|entry))\b/i.test(name)
        && !/submit application|apply now|withdraw|delete|remove|cancel/i.test(name)
        && !item.matches(":disabled") && item.getAttribute("aria-disabled") !== "true";
    });
    if (!save) {
      // No Save control: only acceptable for an inline editor, where the fields
      // themselves are the stored entry.
      return !isDialog(editor);
    }
    save.click();
    const closed = await waitFor(
      () => !editor.isConnected || editor.getAttribute("aria-hidden") === "true" || !save.isConnected,
      1800
    );
    return closed !== null || !isDialog(editor);
  }

  async verifySavedRecord(root: ParentNode, kind: SectionEnum, record: SectionRecord): Promise<boolean> {
    // Resolved ONCE: re-running section discovery inside the poll turns a 2s
    // wait into fifty full-page shadow walks.
    const section = findSections(root).find((item) => item.section === kind);
    if (!section) return false;
    return await waitFor(() => {
      const normalized = normalize(deepTextContent(section.container, 8000));
      const main = record.identity.split("|").find(Boolean) ?? "";
      if (main && normalized.includes(main)) return true;
      // An inline editor keeps the values in its own controls rather than
      // rendering a summary card. The committed value in a live control is the
      // same proof.
      const live = deepQueryAll<HTMLElement>(section.container, "input,textarea,select")
        .map((element) => normalize(liveValue(element)))
        .filter(Boolean);
      return main && live.some((value) => value.includes(main) || main.includes(value)) ? true : null;
    }, 2000) === true;
  }
}

/**
 * An entry form the section already shows, with nothing entered in it.
 *
 * Deliberately strict, because the alternative — pressing Add — is always
 * available and never wrong: the section must expose at least two controls and
 * not one of them may hold a value. A single search box, or a list of entries
 * the user already has, therefore falls through to the Add control as before.
 */
function renderedEmptyEditor(section: SectionMatch): HTMLElement | null {
  const container = section.container;
  // A synthetic sibling wrapper holds CLONES; filling those would write into
  // nothing. Only a live container can be an editor.
  if (!container.isConnected) return null;
  const fields = discoverFields(container);
  if (fields.length < 2) return null;
  if (fields.some((field) => field.existingValue.trim())) return null;
  return container;
}

/** Is this editor a modal, or fields rendered inline in the page? */
function isDialog(editor: HTMLElement): boolean {
  return editor.getAttribute("role") === "dialog" || editor.getAttribute("aria-modal") === "true";
}

/** Keep only the innermost of nested matches (a component host and its own
 * implementation button both match the same selector). */
function dedupeInnermost(elements: HTMLElement[]): HTMLElement[] {
  return elements.filter((element) => !elements.some((other) => other !== element && deepContains(element, other)));
}

/**
 * A date picker's own navigation controls are not answers.
 *
 * SmartRecruiters' date field renders `<input type="number" aria-label="Current
 * year">` as the calendar's year spinner beside the real value input. Typing a
 * year into it scrolls the calendar and stores nothing.
 */
function isPickerNavigation(field: DiscoveredField): boolean {
  const name = `${field.ariaLabel} ${field.label}`.replace(/\s+/g, " ").trim();
  return /^(current|previous|next|prev)\s+(year|month|day|week)$/i.test(name);
}

/**
 * The value for a field that represents only PART of a date.
 *
 * A single record date ("2020-05") reaches the form as a whole date, a month, or
 * a year depending on how the destination splits the control. Writing the whole
 * value into a year box is how "2020-05" ended up in a field that accepts four
 * digits.
 */
function datePartFor(field: DiscoveredField, key: string, values: Record<string, string>): string {
  const value = values[key] ?? "";
  if (!value || !/^(start_date|end_date|date)$/.test(key)) return value;
  const name = `${field.ariaLabel} ${field.label} ${field.name} ${field.placeholder}`.toLowerCase();
  if (field.inputType === "number" || /\byear\b|yyyy/.test(name)) return isoYear(value);
  if (/\bmonth\b|\bmm\b/.test(name)) return isoMonthName(value);
  return value;
}

function isoYear(value: string): string {
  return /^(\d{4})/.exec(value)?.[1] ?? "";
}

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"
];

function isoMonthName(value: string): string {
  const matched = /^\d{4}-(\d{2})/.exec(value);
  if (!matched) return "";
  const index = Number(matched[1]) - 1;
  return index >= 0 && index < 12 ? MONTH_NAMES[index] : "";
}

/**
 * The query to type into a searchable control.
 *
 * A remote location/company picker matches a NAME. Typing the stored
 * "Phoenix, Arizona, United States" returns nothing, and the field is then
 * reported as having no options — the live symptom on the City field.
 */
export function searchQueryFor(value: string): string {
  const head = value.split(",")[0]?.trim() ?? "";
  return head.length >= 2 ? head : value;
}

export async function fillRepeatableSections(
  root: ParentNode,
  session: ApplicationSessionData,
  adapter: RepeatableSectionAdapter = new GenericRepeatableSectionAdapter()
): Promise<SectionTrace[]> {
  const traces: SectionTrace[] = [];
  for (const section of findSections(root)) {
    const kind = adapter.identify(section); if (!kind) continue;
    const policy = POLICY[kind];
    const existing = await adapter.inspectExistingItems(section);
    const candidates = adapter.getCandidateRecords(kind, session);
    const missing = adapter.findMissingRecords(existing, candidates);
    const trace: SectionTrace = {
      sectionKind: kind, required: sectionRequired(section), policy,
      existingItemCount: existing.length, candidateRecordCount: candidates.length,
      recordsAdded: 0, duplicatesSkipped: candidates.length - missing.length,
      incompleteSkipped: 0, candidateRecordIds: candidates.map((record) => record.id), failureCode: null
    };
    if (policy === "REVIEW_ONLY" || candidates.length === 0) {
      trace.failureCode = candidates.length === 0 ? "NO_CONFIRMED_PROFILE_RECORDS" : "SECTION_POLICY_REVIEW_ONLY";
      traces.push(trace); continue;
    }
    if (missing.length === 0) {
      trace.failureCode = "DUPLICATE_ALREADY_PRESENT";
      traces.push(trace); continue;
    }
    trace.failureCode = "CANDIDATE_RECORDS_AVAILABLE";
    for (const record of missing) {
      let current = findSections(root).find((item) => item.section === kind);
      if (!current) { trace.failureCode = "UNSUPPORTED_SECTION"; break; }
      current.container.scrollIntoView?.({ block: "center", behavior: "auto" });
      current = findSections(root).find((item) => item.section === kind);
      if (!current) { trace.failureCode = "UNSUPPORTED_SECTION"; break; }
      if (!findAddControl(current)) { trace.failureCode = "ADD_CONTROL_NOT_FOUND"; break; }
      const editor = await adapter.openEditor(current);
      if (!editor) { trace.failureCode = "EDITOR_OPEN_FAILED"; break; }
      const editorFields = await adapter.discoverEditorFields(editor);
      if (editorFields.length === 0) { trace.failureCode = "EDITOR_FIELDS_UNRESOLVED"; break; }
      if (!await adapter.fillRecord(editor, record, kind)) {
        trace.incompleteSkipped += 1;
        trace.failureCode = "REQUIRED_RECORD_FIELD_MISSING";
        continue;
      }
      if (!await adapter.save(editor)) { trace.failureCode = "RECORD_SAVE_FAILED"; break; }
      if (!await adapter.verifySavedRecord(root, kind, record)) { trace.failureCode = "RECORD_VERIFICATION_FAILED"; break; }
      trace.recordsAdded += 1;
      trace.failureCode = "RECORD_ADDED_AND_VERIFIED";
    }
    traces.push(trace);
  }
  return traces;
}

/** Counts only—safe for diagnostics and sufficient to locate a missing handoff. */
export function structuredCandidateCounts(session: ApplicationSessionData): StructuredCandidateCounts {
  const profile = session.profileData ?? {};
  const links = [profile.linkedin_url, profile.github_url, profile.portfolio_url]
    .filter((value): value is string => typeof value === "string" && /^https:\/\//i.test(value));
  const languages = objectRecords(profile.languages).filter((item) => text(item.language) && text(item.proficiency));
  const selfFacts = stringList(profile.skills).length
    + objectRecords(profile.projects).length
    + stringList(profile.target_roles).length;
  return {
    projects: objectRecords(profile.projects).length,
    awards: objectRecords(profile.awards).length,
    languages: languages.length,
    professionalLinks: links.filter((url) => /linkedin|github/i.test(url)).length,
    workSamples: links.filter((url) => !/linkedin/i.test(url)).length,
    selfIntroductionSourceFacts: selfFacts,
    // No reviewed resume-extraction contract is attached to the current
    // application session. A generated PDF/content document is not equivalent
    // to user-reviewed structured profile data and must not be auto-promoted.
    reviewedResumeExtraction: objectRecords(profile.reviewed_resume_extraction).length
  };
}

/**
 * Which field of the record this control asks for.
 *
 * Section-aware on purpose. "Title" means the job title in a work-experience
 * row and the award's name in an honours row; "Company" is the employer in one
 * and the issuer in the other. One flat table mapped both onto `issuer`, which
 * is why an employer name could never reach an Experience row.
 */
function recordKey(field: DiscoveredField, kind?: SectionEnum): string | null {
  const label = `${field.label} ${field.ariaLabel} ${field.name} ${field.placeholder}`.toLowerCase();
  // "From"/"To" and "Start"/"End" are the same two dates under different names.
  const dateKey = /\bfrom\b|\bstart\b/.test(label)
    ? "start_date"
    : /\bto\b|\bend\b|until|graduat|completion/.test(label)
      ? "end_date"
      : null;

  if (kind === "work_experience" || kind === "internship_experience") {
    if (/company|employer|organi[sz]ation|firm/.test(label)) return "company";
    if (/job title|position|role|^title/.test(label) || /\btitle\b/.test(label)) return "title";
    if (/location|city|office/.test(label)) return "location";
    if (/current(ly)?( (work|employ|role|position))?|present|i (still|currently)/.test(label)) return "currently_working";
    if (/description|responsibilit|summary|achievement|detail/.test(label)) return "description";
    return dateKey;
  }

  if (kind === "education") {
    // Checked BEFORE the institution rule: "School location" contains the word
    // "school" but asks for a place, and answering it with the school's name is
    // wrong data on the employer's record.
    if (/location|city|campus|country/.test(label)) return "location";
    if (/school|university|college|institution|academy/.test(label)) return "school";
    if (/degree|qualification|level of (education|study)/.test(label)) return "degree";
    if (/major|field of study|discipline|concentration|subject/.test(label)) return "major";
    if (/minor/.test(label)) return "minor";
    if (/gpa|grade|marks|score/.test(label)) return "gpa";
    if (/description|activities|detail/.test(label)) return "description";
    return dateKey;
  }

  if (/language/.test(label)) return "language";
  if (/project|award|honou?r|name/.test(label)) return "name";
  if (/title/.test(label)) return "title";
  if (/organization|issuer|company/.test(label)) return "issuer";
  if (/proficiency|level/.test(label)) return "proficiency";
  if (/description|introduction|summary|details/.test(label)) return "description";
  if (/technolog|skills/.test(label)) return "technologies";
  if (/url|link|website|sns/.test(label)) return "url";
  if (/start|^from\b/.test(label)) return "start_date";
  if (/end|^to\b/.test(label)) return "end_date";
  if (/date/.test(label)) return "date";
  return null;
}

function sectionRequired(section: SectionMatch): boolean {
  return section.container.getAttribute("aria-required") === "true"
    || section.container.getAttribute("data-required") === "true"
    || /[*✱]\s*$|\brequired\b/i.test(section.heading.textContent ?? "");
}
/**
 * What a control currently holds.
 *
 * A web-component field is neither an `<input>` nor a text node: it mirrors its
 * committed value onto the host and keeps the real control in its shadow root.
 * Reading `textContent` there returns "" for a field that is plainly filled,
 * which reported a fully populated Experience row as
 * REQUIRED_RECORD_FIELD_MISSING and threw the record away.
 */
function liveValue(element: HTMLElement): string {
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) {
    return element.value.trim();
  }
  const mirrored = element.getAttribute("value");
  if (mirrored?.trim()) return mirrored.trim();
  const inner = deepQuery<HTMLInputElement>(element, "input:not([type=hidden]),textarea,select");
  if (inner?.value?.trim()) return inner.value.trim();
  return (element.textContent ?? "").trim();
}
function normalize(value: string): string { return value.toLowerCase().replace(/[^a-z0-9./:+#]+/g, " ").trim(); }
function identity(values: string[]): string { return values.map(normalize).filter(Boolean).join("|"); }
function text(value: unknown): string { return typeof value === "string" ? value.trim() : ""; }
/**
 * The Description box on an employer's Experience row.
 *
 * Built ONLY from what the user entered and reviewed in their profile: an
 * explicit description if the record has one, otherwise their own bullet lines.
 * Nothing is generated and no resume document text is used, because an employer
 * reads this as the applicant's own statement of what they did. When the record
 * carries neither, the box is left for the user rather than filled with prose
 * nobody wrote.
 */
function experienceDescription(item: Record<string, unknown>): string {
  const explicit = text(item.description);
  if (explicit) return explicit;
  const bullets = stringList(item.bullets).map((line) => line.replace(/^[•\-*\s]+/, "").trim()).filter(Boolean);
  return bullets.join("\n");
}
function stringList(value: unknown): string[] { return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim() !== "") : []; }
function objectRecords(value: unknown): Record<string, unknown>[] { return Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object")) : []; }
function firstString(value: unknown): string { return stringList(value)[0] ?? ""; }
function recordId(prefix: string, value: unknown, index: number): string {
  return typeof value === "number" || typeof value === "string" ? `${prefix}-${value}` : `${prefix}-${index}`;
}
function platformTitle(raw: string): string { try { return new URL(raw).hostname.replace(/^www\./, ""); } catch { return "Professional link"; } }
async function waitFor<T>(read: () => T | null, timeoutMs: number): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { const value = read(); if (value !== null) return value; await new Promise((resolve) => setTimeout(resolve, 40)); }
  return null;
}

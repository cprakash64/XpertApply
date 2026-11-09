/**
 * Workday repeatable sections: Work Experience, Education, Websites (EXT-LIVE-06).
 *
 * Replaces the generic repeaters on Workday. The generic "Add another" expander clicked Workday's Add
 * button while counting labels it could not recognise, which would create blank rows.
 *
 * Rules:
 *  - Match saved records to existing rows by CONTENT (employer+title+start year, school+degree), never by
 *    position, so Workday re-ordering or a resume parse cannot cause a mismatch or a duplicate.
 *  - A row is added only for a saved record that has no matching row and no blank row to reuse.
 *  - A non-empty live value is never overwritten. A different value is a "kept" conflict, reported by count.
 *  - Nothing is invented: a missing date part, degree or school stays blank and is reported.
 *  - Every written value is read back from the rendered control; failures carry a label and a reason code,
 *    never the value.
 */

import {
  byAutomation, byLabel, norm, parseIsoParts, sameDegree, pickDegree, pickExact, readDate, readPrompt, readTypeahead,
  setChecked, setDate, setPrompt, setText, setTypeahead, sleep, type ControlResult, type DateParts
} from "./workdayControls";

export type SectionKind = "work_experience" | "education" | "websites";
export interface SectionIssue { section: SectionKind; row: number; field: string; reason: string }
export interface WorkdaySectionTrace {
  section: SectionKind;
  requested: number;
  rowsBefore: number;
  rowsAfter: number;
  matched: number;
  added: number;
  fieldsWritten: number;
  fieldsAlreadyCorrect: number;
  keptDifferent: number;
  foreignRowsPreserved: number;
  issues: SectionIssue[];
}

type Rec = Record<string, unknown>;
const records = (v: unknown): Rec[] => (Array.isArray(v) ? v.filter((x): x is Rec => Boolean(x && typeof x === "object")) : []);
const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

// ---- structure ---------------------------------------------------------------------------------
interface SectionDef { kind: SectionKind; container: string[]; heading: RegExp; entry: RegExp; entryHeading: RegExp }
const DEFS: Record<SectionKind, SectionDef> = {
  work_experience: { kind: "work_experience", container: ["workExperienceSection"], heading: /^work experience$/i, entry: /^workExperience-\d+$/, entryHeading: /^work experience \d+$/i },
  education: { kind: "education", container: ["educationSection"], heading: /^education$/i, entry: /^education-\d+$/, entryHeading: /^education \d+$/i },
  websites: { kind: "websites", container: ["websiteSection"], heading: /^websites?$/i, entry: /^website-\d+$/, entryHeading: /^website \d+$/i }
};

/** A node held across an SPA re-render is detached; fall back to the whole document so the live section is always found. */
function liveRoot(root: ParentNode): ParentNode {
  const node = root as unknown as Node;
  return node.isConnected === false ? node.ownerDocument ?? document : root;
}

function findContainer(initial: ParentNode, def: SectionDef): HTMLElement | null {
  const root = liveRoot(initial);
  for (const id of def.container) {
    const el = root.querySelector<HTMLElement>(`[data-automation-id="${id}"]`);
    if (el) return el;
  }
  for (const h of Array.from(root.querySelectorAll<HTMLElement>("h1,h2,h3,[role=heading]"))) {
    if (!def.heading.test((h.textContent || "").replace(/\s+/g, " ").trim())) continue;
    let node: HTMLElement | null = h.parentElement;
    while (node && node.parentElement) {
      if (node.querySelectorAll("input,textarea,button").length > 0) return node;
      node = node.parentElement;
    }
  }
  return null;
}

function entriesOf(container: HTMLElement, def: SectionDef): HTMLElement[] {
  const byId = Array.from(container.querySelectorAll<HTMLElement>("[data-automation-id]")).filter((e) => def.entry.test(e.getAttribute("data-automation-id") || ""));
  if (byId.length) return byId;
  return Array.from(container.querySelectorAll<HTMLElement>('[role="group"], fieldset, section')).filter((g) => {
    const h = g.querySelector<HTMLElement>("h1,h2,h3,h4,legend,[role=heading]");
    return Boolean(h && def.entryHeading.test((h.textContent || "").replace(/\s+/g, " ").trim()));
  });
}

function addButton(container: HTMLElement, def: SectionDef): HTMLElement | null {
  const inside = (b: HTMLElement) => entriesOf(container, def).some((e) => e.contains(b));
  const candidates = Array.from(container.querySelectorAll<HTMLElement>('button,[role="button"]')).filter((b) => !inside(b) && !(b as HTMLButtonElement).disabled && b.getAttribute("aria-disabled") !== "true");
  return candidates.find((b) => b.getAttribute("data-automation-id") === "add-button")
    ?? candidates.find((b) => /^add( another)?$/i.test((b.textContent || "").replace(/\s+/g, " ").trim()))
    ?? null;
}

// ---- field access ------------------------------------------------------------------------------
const textLike = (e: HTMLElement | null): HTMLInputElement | HTMLTextAreaElement | null => (e && /^(INPUT|TEXTAREA)$/.test(e.tagName) ? (e as HTMLInputElement) : null);

function dateWrapper(entry: HTMLElement, ids: string[], label: RegExp): HTMLElement | null {
  for (const id of ids) {
    const el = entry.querySelector<HTMLElement>(`[data-automation-id="${id}"]`);
    if (el?.querySelector('[data-automation-id^="dateSection"], [role=spinbutton]')) return el;
  }
  const l = byLabel<HTMLElement>(entry, label);
  return l ? (l.closest<HTMLElement>('[data-automation-id="dateInputWrapper"], [data-automation-id^="formField"]') ?? l.parentElement) : null;
}

/** Only parts the control really has, so a year-only control is never asked for a month. */
function supported(wrapper: HTMLElement, parts: DateParts): DateParts {
  const has = (n: string) => Boolean(wrapper.querySelector(`[data-automation-id="dateSection${n}-input"], input[aria-label="${n}" i], [role=spinbutton][aria-label="${n}" i]`));
  return { month: has("Month") ? parts.month : undefined, day: has("Day") ? parts.day : undefined, year: has("Year") ? parts.year : undefined };
}

interface Counters { written: number; correct: number; kept: number; issues: SectionIssue[] }

async function ensureText(entry: HTMLElement | null, ids: string[], label: RegExp, want: string, ctx: { section: SectionKind; row: number; name: string }, c: Counters): Promise<void> {
  if (!want || !entry) return;
  const el = textLike(byAutomation(entry, ids) ?? byLabel(entry, label));
  if (!el) return;
  if (el.value.trim()) { if (norm(el.value) === norm(want)) c.correct++; else c.kept++; return; }
  record(await setText(el, want), ctx, c);
}

function record(result: ControlResult, ctx: { section: SectionKind; row: number; name: string }, c: Counters): void {
  if (result.ok) c.written++;
  else c.issues.push({ section: ctx.section, row: ctx.row, field: ctx.name, reason: result.reason });
}

async function ensureDate(entry: HTMLElement | null, ids: string[], label: RegExp, iso: string | undefined, ctx: { section: SectionKind; row: number; name: string }, c: Counters): Promise<void> {
  if (!iso || !entry) return;
  const wrapper = dateWrapper(entry, ids, label);
  if (!wrapper) return;
  const want = supported(wrapper, parseIsoParts(iso));
  if ((want.month && !/^(0?[1-9]|1[0-2])$/.test(want.month)) || (want.year && !/^(19|20)\d{2}$/.test(want.year))) { c.issues.push({ ...ctx, field: ctx.name, reason: "DATE_INVALID_IN_PROFILE" }); return; }
  if (!want.year) { c.issues.push({ ...ctx, field: ctx.name, reason: "DATE_YEAR_UNKNOWN" }); return; }
  if (supported(wrapper, { month: "1" }).month !== undefined && !want.month) { c.issues.push({ ...ctx, field: ctx.name, reason: "DATE_MONTH_UNKNOWN" }); return; }
  const live = readDate(wrapper);
  const differs = (k: "month" | "day" | "year") => Boolean(want[k] && live[k] && Number(live[k]) !== Number(want[k]));
  if (differs("month") || differs("year")) { c.kept++; return; }
  const missing = (["month", "day", "year"] as const).some((k) => want[k] && !live[k]);
  if (!missing) { c.correct++; return; }
  const onlyMissing: DateParts = {};
  for (const k of ["month", "day", "year"] as const) if (want[k] && !live[k]) onlyMissing[k] = want[k];
  record(await setDate(wrapper, onlyMissing), ctx, c);
}

// ---- row state ---------------------------------------------------------------------------------
interface WorkRow { title: string; company: string; startYear: string }
function readWork(entry: HTMLElement): WorkRow {
  const t = textLike(byAutomation(entry, ["jobTitle"]) ?? byLabel(entry, /^job title/i))?.value ?? "";
  const co = textLike(byAutomation(entry, ["companyName"]) ?? byLabel(entry, /^company/i))?.value ?? "";
  const w = dateWrapper(entry, ["startDate"], /^from/i);
  return { title: norm(t), company: norm(co), startYear: (w ? readDate(w).year : "") ?? "" };
}
interface EduRow { school: string; degree: string }
function eduSchoolEl(entry: HTMLElement): HTMLElement | null {
  return byAutomation(entry, ["school", "schoolItem"], "input,textarea,button,[role=combobox]") ?? byLabel(entry, /^school/i);
}
function eduDegreeEl(entry: HTMLElement): HTMLElement | null {
  return byAutomation(entry, ["degree"], "button,input,[role=combobox]") ?? byLabel(entry, /^degree/i);
}
function readSchool(entry: HTMLElement): string {
  const holder = entry.querySelector<HTMLElement>('[data-automation-id="school"], [data-automation-id="schoolItem"]');
  const chips = holder ? readTypeahead(holder) : [];
  if (chips.length) return chips[0]!;
  return textLike(eduSchoolEl(entry))?.value ?? "";
}
function readEdu(entry: HTMLElement): EduRow {
  const d = eduDegreeEl(entry);
  return { school: norm(readSchool(entry)), degree: norm(d ? (d.matches("button") ? readPrompt(d) : (d as HTMLInputElement).value) : "") };
}

const blankWork = (r: WorkRow) => !r.title && !r.company && !r.startYear;
const blankEdu = (r: EduRow) => !r.school && !r.degree;

// ---- main --------------------------------------------------------------------------------------
/** SPA renders replace the whole section node, so the container is always re-resolved, never held across an action. */
async function addRow(find: () => HTMLElement | null, def: SectionDef): Promise<boolean> {
  const first = find();
  if (!first) return false;
  const before = entriesOf(first, def).length;
  const button = addButton(first, def);
  if (!button) return false;
  button.scrollIntoView?.({ block: "center" });
  button.click();
  const end = Date.now() + 3000;
  while (Date.now() < end) {
    const now = find();
    if (now && entriesOf(now, def).length > before) return true;
    await sleep(40);
  }
  return false;
}

function newTrace(section: SectionKind, requested: number, rows: number): WorkdaySectionTrace {
  return { section, requested, rowsBefore: rows, rowsAfter: rows, matched: 0, added: 0, fieldsWritten: 0, fieldsAlreadyCorrect: 0, keptDifferent: 0, foreignRowsPreserved: 0, issues: [] };
}

function workRecords(profile: Rec): Array<{ company: string; title: string; location: string; start: string; end: string; current: boolean; description: string; key: WorkRow }> {
  return records(profile.experience).flatMap((r) => {
    const company = str(r.company), title = str(r.title);
    if (!company && !title) return [];
    const description = str(r.description) || (Array.isArray(r.bullets) ? (r.bullets as unknown[]).filter((b): b is string => typeof b === "string").map((b) => b.replace(/^[•\-*\s]+/, "").trim()).filter(Boolean).join("\n") : "");
    return [{ company, title, location: str(r.location), start: str(r.start_date), end: str(r.end_date), current: r.currently_working === true, description, key: { company: norm(company), title: norm(title), startYear: parseIsoParts(str(r.start_date)).year ?? "" } }];
  });
}

export async function fillWorkExperience(root: ParentNode, profile: Rec): Promise<WorkdaySectionTrace | null> {
  const def = DEFS.work_experience;
  const find = () => findContainer(root, def);
  const wanted = workRecords(profile);
  if (!find()) return null;
  const rows = () => { const c = find(); return c ? entriesOf(c, def) : []; };
  const trace = newTrace("work_experience", wanted.length, rows().length);
  if (wanted.length === 0) { trace.foreignRowsPreserved = rows().filter((e) => !blankWork(readWork(e))).length; return trace; }
  const c: Counters = { written: 0, correct: 0, kept: 0, issues: [] };

  // Assign saved records to rows by content; each row is claimed at most once.
  const claimed = new Map<number, number>(); // wanted index -> entry index
  const initial = rows().map(readWork);
  // Same employer is the identity. Start year or title only disambiguates repeated stints at one employer; a
  // different title at the same employer and year is the SAME job that the person or Workday worded differently.
  wanted.forEach((w, wi) => {
    let best = -1, bestScore = -1;
    initial.forEach((r, ri) => {
      if (Array.from(claimed.values()).includes(ri) || blankWork(r) || r.company !== w.key.company) return;
      const yearOk = !r.startYear || !w.key.startYear || r.startYear === w.key.startYear;
      const titleEq = Boolean(r.title) && r.title === w.key.title;
      if (!yearOk && !titleEq) return;
      const score = (titleEq ? 2 : 0) + (yearOk && r.startYear && w.key.startYear ? 1 : 0);
      if (score > bestScore) { best = ri; bestScore = score; }
    });
    if (best >= 0) claimed.set(wi, best);
  });
  trace.matched = claimed.size;
  const taken = () => Array.from(claimed.values());
  trace.foreignRowsPreserved = initial.filter((r, i) => !blankWork(r) && !taken().includes(i)).length;

  for (let wi = 0; wi < wanted.length; wi++) {
    if (!claimed.has(wi)) {
      const blank = rows().map(readWork).findIndex((r, i) => blankWork(r) && !taken().includes(i));
      if (blank >= 0) claimed.set(wi, blank);
      else {
        if (rows().length >= 25 || !await addRow(find, def)) { c.issues.push({ section: "work_experience", row: wi + 1, field: "Add", reason: "ADD_DID_NOT_CREATE_ROW" }); continue; }
        trace.added++;
        claimed.set(wi, rows().length - 1);
      }
    }
    const rec = wanted[wi]!;
    const index = claimed.get(wi)!;
    const ctx = (name: string) => ({ section: "work_experience" as const, row: index + 1, name });
    const entry = () => rows()[index] ?? null;
    await ensureText(entry(), ["jobTitle"], /^job title/i, rec.title, ctx("Job Title"), c);
    await ensureText(entry(), ["companyName"], /^company/i, rec.company, ctx("Company"), c);
    await ensureText(entry(), ["location"], /^location/i, rec.location, ctx("Location"), c);
    await ensureDate(entry(), ["startDate"], /^from/i, rec.start, ctx("From"), c);
    const box = entry() ? (byAutomation<HTMLInputElement>(entry()!, ["currentlyWorkHere"], "input[type=checkbox]") ?? byLabel<HTMLInputElement>(entry()!, /currently work here/i)) : null;
    if (box && rec.current && !box.checked) record(await setChecked(box, true), ctx("I currently work here"), c);
    else if (box && rec.current) c.correct++;
    if (!rec.current && rec.end) await ensureDate(entry(), ["endDate"], /^to/i, rec.end, ctx("To"), c);
    await ensureText(entry(), ["roleDescription"], /^role description/i, rec.description, ctx("Role Description"), c);
  }
  trace.rowsAfter = rows().length;
  trace.fieldsWritten = c.written; trace.fieldsAlreadyCorrect = c.correct; trace.keptDifferent = c.kept; trace.issues = c.issues;
  return trace;
}

export async function fillEducation(root: ParentNode, profile: Rec): Promise<WorkdaySectionTrace | null> {
  const def = DEFS.education;
  const find = () => findContainer(root, def);
  const wanted = records(profile.education).flatMap((r) => {
    const school = str(r.school);
    return school ? [{ school, degree: str(r.degree), major: str(r.major), gpa: str(r.gpa), start: str(r.start_date), end: str(r.end_date) }] : [];
  });
  if (!find()) return null;
  const rows = () => { const c = find(); return c ? entriesOf(c, def) : []; };
  const trace = newTrace("education", wanted.length, rows().length);
  if (wanted.length === 0) { trace.foreignRowsPreserved = rows().filter((e) => !blankEdu(readEdu(e))).length; return trace; }
  const c: Counters = { written: 0, correct: 0, kept: 0, issues: [] };
  const claimed = new Map<number, number>();
  const taken = () => Array.from(claimed.values());
  const initial = rows().map(readEdu);
  wanted.forEach((w, wi) => {
    const hit = initial.findIndex((r, ri) => !taken().includes(ri) && !blankEdu(r) && r.school === norm(w.school) && (!r.degree || !w.degree || sameDegree(r.degree, w.degree)));
    if (hit >= 0) claimed.set(wi, hit);
  });
  trace.matched = claimed.size;
  trace.foreignRowsPreserved = initial.filter((r, i) => !blankEdu(r) && !taken().includes(i)).length;

  for (let wi = 0; wi < wanted.length; wi++) {
    if (!claimed.has(wi)) {
      const blank = rows().map(readEdu).findIndex((r, i) => blankEdu(r) && !taken().includes(i));
      if (blank >= 0) claimed.set(wi, blank);
      else {
        if (rows().length >= 15 || !await addRow(find, def)) { c.issues.push({ section: "education", row: wi + 1, field: "Add", reason: "ADD_DID_NOT_CREATE_ROW" }); continue; }
        trace.added++;
        claimed.set(wi, rows().length - 1);
      }
    }
    const rec = wanted[wi]!;
    const index = claimed.get(wi)!;
    const ctx = (name: string) => ({ section: "education" as const, row: index + 1, name });
    const entry = () => rows()[index] ?? null;

    // School: a searchable list (must pick a real record) or a plain text box.
    const holder = entry()?.querySelector<HTMLElement>('[data-automation-id="school"], [data-automation-id="schoolItem"]') ?? null;
    if (holder && holder.querySelector('[data-automation-id="searchBox"], input[role="combobox"]')) {
      const live = readTypeahead(holder);
      if (live.length) { if (norm(live[0]) === norm(rec.school)) c.correct++; else c.kept++; }
      else record(await setTypeahead(holder, rec.school), ctx("School or University"), c);
    } else await ensureText(entry(), ["school", "schoolItem"], /^school/i, rec.school, ctx("School or University"), c);

    const degree = entry() ? eduDegreeEl(entry()!) : null;
    if (degree && rec.degree) {
      const live = degree.matches("button") ? readPrompt(degree) : (degree as HTMLInputElement).value;
      if (live.trim()) { if (sameDegree(live, rec.degree)) c.correct++; else c.kept++; }
      else if (degree.matches("button")) record(await setPrompt(degree, rec.degree, pickDegree), ctx("Degree"), c);
    }

    const fos = entry()?.querySelector<HTMLElement>('[data-automation-id="fieldOfStudy"]') ?? null;
    if (fos && rec.major) {
      const live = readTypeahead(fos);
      if (live.length) { if (live.some((n) => norm(n) === norm(rec.major))) c.correct++; else c.kept++; }
      else record(await setTypeahead(fos, rec.major), ctx("Field of Study"), c);
    }
    await ensureText(entry(), ["gradeAverage", "gpa"], /^(overall result|gpa)/i, rec.gpa, ctx("Overall Result (GPA)"), c);
    await ensureDate(entry(), ["firstYearAttended", "startDate"], /^from/i, rec.start, ctx("From"), c);
    await ensureDate(entry(), ["lastYearAttended", "endDate"], /^to/i, rec.end, ctx("To"), c);
  }
  trace.rowsAfter = rows().length;
  trace.fieldsWritten = c.written; trace.fieldsAlreadyCorrect = c.correct; trace.keptDifferent = c.kept; trace.issues = c.issues;
  return trace;
}

export async function fillWebsites(root: ParentNode, profile: Rec): Promise<WorkdaySectionTrace | null> {
  const def = DEFS.websites;
  const find = () => findContainer(root, def);
  const urls = [profile.linkedin_url, profile.github_url, profile.portfolio_url].map(str).filter((u) => /^https:\/\//i.test(u));
  if (!find()) return null;
  const rows = () => { const c = find(); return c ? entriesOf(c, def) : []; };
  const urlEl = (e: HTMLElement) => textLike(byAutomation(e, ["url", "websiteUrl"]) ?? byLabel(e, /^url/i));
  const keyOf = (u: string) => u.toLowerCase().replace(/^https?:\/\/(www\.)?/, "").replace(/\/+$/, "");
  const trace = newTrace("websites", urls.length, rows().length);
  const c: Counters = { written: 0, correct: 0, kept: 0, issues: [] };
  const live = () => rows().map((e) => urlEl(e)?.value ?? "");
  trace.foreignRowsPreserved = live().filter((v) => v && !urls.some((u) => keyOf(u) === keyOf(v))).length;
  for (let i = 0; i < urls.length; i++) {
    const url = urls[i]!;
    if (live().some((v) => v && keyOf(v) === keyOf(url))) { c.correct++; trace.matched++; continue; }
    let index = live().findIndex((v) => !v.trim());
    if (index < 0) {
      if (rows().length >= 10 || !await addRow(find, def)) { c.issues.push({ section: "websites", row: i + 1, field: "Add", reason: "ADD_DID_NOT_CREATE_ROW" }); continue; }
      trace.added++;
      index = rows().length - 1;
    }
    const el = rows()[index] ? urlEl(rows()[index]!) : null;
    if (el) record(await setText(el, url), { section: "websites", row: index + 1, name: "URL" }, c);
  }
  trace.rowsAfter = rows().length;
  trace.fieldsWritten = c.written; trace.fieldsAlreadyCorrect = c.correct; trace.keptDifferent = c.kept; trace.issues = c.issues;
  return trace;
}

const PARSE_BUSY = '[data-automation-id="file-upload-progress"], [data-automation-id="parsing-progress"], [data-automation-id="resumeSection"] [aria-busy="true"]';

/** True while Workday is still parsing an uploaded résumé; rows are then still being created by the employer. */
export function workdayParseInProgress(root: ParentNode): boolean {
  return Boolean(liveRoot(root).querySelector(PARSE_BUSY));
}

/** Waits (bounded) for an in-flight résumé parse to finish so its rows are reconciled, not raced or duplicated. */
export async function waitForWorkdayParse(root: ParentNode, maxMs = 25_000): Promise<"none" | "settled" | "timeout"> {
  if (!workdayParseInProgress(root)) return "none";
  const end = Date.now() + maxMs;
  while (Date.now() < end) {
    if (!workdayParseInProgress(root)) { await sleep(400); return "settled"; }
    await sleep(100);
  }
  return "timeout";
}

export async function fillWorkdaySections(root: ParentNode, profile: Rec): Promise<WorkdaySectionTrace[]> {
  const out: WorkdaySectionTrace[] = [];
  if (await waitForWorkdayParse(root) === "timeout") return out;
  for (const run of [fillWorkExperience, fillEducation, fillWebsites]) {
    const t = await run(root, profile).catch(() => null);
    if (t) out.push(t);
  }
  return out;
}

export function sectionIssueSummary(traces: WorkdaySectionTrace[]): string[] {
  const names: Record<SectionKind, string> = { work_experience: "Work Experience", education: "Education", websites: "Websites" };
  return traces.flatMap((t) => t.issues.map((i) => `${names[i.section]} ${i.row} · ${i.field}`));
}

export { pickExact };

const ENTRY_ID = /^(workExperience|education|website|language|certification)-\d+$/;

/** True for any control inside a Workday repeatable row. Those are owned (written and read back) by this module. */
export function isInWorkdaySectionEntry(el: Element): boolean {
  for (let n: Element | null = el; n; n = n.parentElement) {
    const id = n.getAttribute("data-automation-id");
    if (id && ENTRY_ID.test(id)) return true;
  }
  return false;
}

/** Required controls inside section rows that are still blank (counts only). */
export function blankRequiredInSections(root: ParentNode): number {
  let blank = 0;
  for (const el of Array.from(root.querySelectorAll<HTMLElement>("input,textarea,button[aria-haspopup]"))) {
    if (!isInWorkdaySectionEntry(el)) continue;
    if (el instanceof HTMLInputElement && (el.type === "checkbox" || el.type === "radio" || el.type === "hidden" || el.type === "file")) continue;
    if (el.closest('[data-automation-id="searchBox"]') || el.getAttribute("data-automation-id") === "searchBox") continue;
    const label = el.id ? el.ownerDocument.querySelector(`label[for="${CSS.escape(el.id)}"]`)?.textContent ?? "" : "";
    const required = (el as HTMLInputElement).required || el.getAttribute("aria-required") === "true" || /\*\s*$/.test(label.trim());
    if (!required) continue;
    if (el.closest('[data-automation-id="dateInputWrapper"]')) { if (!(el as HTMLInputElement).value?.trim()) blank++; continue; }
    const value = el.matches("button") ? readPrompt(el) : (el as HTMLInputElement).value;
    const holder = el.closest<HTMLElement>('[data-automation-id="multiSelectContainer"], [data-automation-id="school"], [data-automation-id="fieldOfStudy"]');
    if (holder && readTypeahead(holder).length > 0) continue;
    if (!value.trim()) blank++;
  }
  return blank;
}

/** True when the page has any repeatable-section container or Add control: it is a form even with no ordinary inputs yet. */
export function hasWorkdaySections(root: ParentNode): boolean {
  const live = liveRoot(root);
  return Boolean(live.querySelector('[data-automation-id="workExperienceSection"], [data-automation-id="educationSection"], [data-automation-id="websiteSection"], [data-automation-id="add-button"], [data-automation-id="resumeSection"]'));
}

/**
 * Workday keeps an uploaded résumé server-side, so after a refresh the section already lists the file. Uploading again would
 * attach a second copy and re-run the employer's parser over the person's reviewed entries.
 */
export function workdayResumeAlreadyAttached(input: HTMLElement): boolean {
  const section = input.closest<HTMLElement>('[data-automation-id="resumeSection"], [data-automation-id="resume-section"], [data-automation-id="file-upload-drop-zone"]') ?? input.parentElement;
  if (!section) return false;
  return Boolean(section.querySelector('[data-automation-id="file-upload-successful"], [data-automation-id="file-upload-item"], [data-automation-id="delete-file"]'));
}

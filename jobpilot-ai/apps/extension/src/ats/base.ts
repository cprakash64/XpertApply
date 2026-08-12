/**
 * Shared adapter helpers. All ATS adapters reuse the generic discovery, mapping,
 * and submit-locating logic; each only customizes detection (and, later, upload
 * quirks). This keeps ATS-specific code small and avoids one monolithic file.
 */

import { discoverFields } from "../fields/discovery";
import { buildMappings } from "../fields/mapping";
import {
  deepClosest,
  deepParentElement,
  deepQuery,
  deepQueryAll,
  deepTextContent,
  nearestHeadingText,
  scopedElementById,
  scopedQuery
} from "../dom/deepDom";
import type { ApplicationSessionData, DiscoveredField, FieldMappingResult, PageContext } from "../types";
import { resolveApplicationRoot, type FormRootResult } from "./formRoot";

/**
 * Resolve the application form root by weighted evidence (see formRoot.ts).
 *
 * Previously this picked the `<form>` with the most inputs and fell back to the
 * whole document — which selected the site's SEARCH form on a React application
 * that renders no `<form>` at all. Discovery is now scoped to a scored,
 * confidently-identified application root, or to nothing at all.
 *
 * Returns `null` when no candidate is confidently the application
 * (APPLICATION_FORM_AMBIGUOUS / NO_APPLICATION_FORM) — callers must surface that
 * rather than scanning the page globally.
 */
export function resolveApplicationForm(doc: Document): FormRootResult {
  return resolveApplicationRoot(doc);
}

/** Back-compatible accessor: the resolved root, or `document` only when the
 * caller has no way to report ambiguity. Prefer `resolveApplicationForm`. */
export function pickApplicationForm(doc: Document): ParentNode {
  return resolveApplicationRoot(doc).root ?? doc;
}

export function baseDiscover(context: PageContext, step = 0): DiscoveredField[] {
  return discoverFields(pickApplicationForm(context.document), step);
}

export function baseMap(fields: DiscoveredField[], session: ApplicationSessionData): FieldMappingResult {
  return buildMappings(fields, session);
}

/** Locate the final submit control — for WARNING only. XpertApply never clicks it. */
export function findGenericSubmit(context: PageContext): HTMLElement | null {
  const doc = context.document;
  const explicit = deepQuery<HTMLElement>(doc, "button[type=submit], input[type=submit]");
  if (explicit) {
    return explicit;
  }
  const buttons = deepQueryAll<HTMLElement>(doc, "button, [role=button]");
  return buttons.find((b) => /\b(submit|apply|send application)\b/i.test(b.textContent || "")) ?? null;
}

export function hostMatches(url: string, fragment: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === fragment || host.endsWith("." + fragment) || host.includes(fragment);
  } catch {
    return false;
  }
}

/**
 * Discover real file inputs for document upload, INCLUDING inputs that ordinary
 * field discovery skips because they are visually hidden behind an "Attach"
 * button (common on modern Greenhouse/Ashby). Each is classified as resume or
 * cover-letter from its associated label, section text, accepted MIME types, or
 * the nearby "Attach"/"Upload" button text — so the cover letter is never set
 * into the resume field.
 */
export function discoverUploadInputs(root: ParentNode): { input: HTMLInputElement; kind: "resume" | "cover-letter" }[] {
  // Shadow-piercing: SmartRecruiters' `spl-dropzone` keeps the real file input
  // inside its own shadow root, so a light-DOM query found no upload target at
  // all and the tailored resume was silently never attached.
  const inputs = deepQueryAll<HTMLInputElement>(root, 'input[type="file"]');
  const classified: { input: HTMLInputElement; kind: "resume" | "cover-letter"; importControl: boolean }[] = [];
  // A document dropzone whose own wording never says "resume" (see
  // `isUnnamedDocumentDropzone`). Kept apart from the classified set so it can
  // only ever be used as a last resort.
  const unnamed: HTMLInputElement[] = [];
  for (const input of inputs) {
    if (input.disabled) continue;
    const context = uploadContextText(input);
    const kind = classifyUpload(context);
    if (!kind) {
      if (isUnnamedDocumentDropzone(input, context)) unnamed.push(input);
      continue;
    }
    classified.push({ input, kind, importControl: isImportControl(context) });
  }

  // A "drop your resume here and we'll fill the form for you" control is an
  // IMPORT, not an attachment: uploading into it re-parses the document and
  // overwrites fields the user (or XpertApply) already answered. It is used only
  // when the destination offers no real attachment field of the same kind.
  const out: { input: HTMLInputElement; kind: "resume" | "cover-letter" }[] = [];
  for (const kind of ["resume", "cover-letter"] as const) {
    const forKind = classified.filter((entry) => entry.kind === kind);
    const attachments = forKind.filter((entry) => !entry.importControl);
    for (const entry of (attachments.length > 0 ? attachments : forKind)) {
      out.push({ input: entry.input, kind: entry.kind });
    }
  }

  // Last resort, and only when the destination named no resume control at all.
  // The live SmartRecruiters "Easy Apply" block (ServiceNow's destination) is
  // exactly this shape: a heading, "Choose an option to autocomplete your
  // application", and a dropzone whose visible text is "Choose a file or drop
  // it here / 10MB size limit". Nothing in it contains the word resume, so the
  // only upload target on the page was skipped, no document ever reached the
  // ATS, and Experience/Education were therefore never parsed or populated.
  if (!out.some((entry) => entry.kind === "resume") && unnamed.length === 1) {
    out.push({ input: unnamed[0], kind: "resume" });
  }
  return out;
}

function classifyUpload(context: string): "resume" | "cover-letter" | null {
  if (/cover\s*letter|coverletter|motivation letter/.test(context)) return "cover-letter";
  if (/resume|résumé|\bcv\b|curriculum vitae/.test(context)) return "resume";
  // A file input near an "attach/upload" control with no clear label is treated
  // as a resume only when it is the sole file input; otherwise left for review.
  return null;
}

/**
 * Wording that says "this control takes THE application document".
 *
 * The strong phrases name the application flow itself and are decisive on their
 * own. The weak ones are what any dropzone says, so they count only when the
 * control's `accept` list proves it takes documents and nothing else.
 */
const STRONG_DOCUMENT_INTENT =
  /easy apply|quick apply|one click apply|autocomplete your application|auto complete your application|autofill|auto fill|import|parse|apply with/;
const WEAK_DOCUMENT_INTENT =
  /drop it here|drop your file|drag and drop|choose a file|select a file|upload a file|upload your file|attach a file|attach your file|browse/;

/**
 * Is this an application-document dropzone that simply never says "resume"?
 *
 * Deliberately narrow, because the caller uses the answer to upload the user's
 * resume: the control must both accept documents (never an avatar or a
 * portfolio image) and sit in a block whose wording is about applying. Even
 * then it is used only when it is the ONLY such control and the page named no
 * resume field of its own.
 */
function isUnnamedDocumentDropzone(input: HTMLInputElement, context: string): boolean {
  const acceptsDocuments = documentAccept(input);
  if (acceptsDocuments === "other") return false;
  // The surrounding block, NOT `context`: the wording that identifies an Easy
  // Apply dropzone lives in the paragraph above it, which the classification
  // context deliberately excludes (a wide read there would let a neighbouring
  // "Cover letter" heading retype a resume field).
  const block = `${context} ${uploadBlockText(input)}`;
  if (STRONG_DOCUMENT_INTENT.test(block)) return true;
  return acceptsDocuments === "documents" && WEAK_DOCUMENT_INTENT.test(block);
}

/** The visible wording of the block this control sits in, bounded. */
function uploadBlockText(input: HTMLInputElement): string {
  const parts: string[] = [];
  let node: Element | null = deepClosest(input, "div,fieldset,section,li");
  for (let hops = 0; node && hops < 3; hops += 1) {
    if (/^(form|main|body|html)$/i.test(node.tagName)) break;
    parts.push(deepTextContent(node, 600));
    node = deepParentElement(node);
  }
  return parts.join(" ").toLowerCase().replace(/[-_]+/g, " ").replace(/\s+/g, " ");
}

/** What the control's `accept` list says it takes. */
function documentAccept(input: HTMLInputElement): "documents" | "other" | "unspecified" {
  const parts = (input.getAttribute("accept") || "")
    .toLowerCase()
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length === 0) return "unspecified";
  const documentLike =
    /^\.(pdf|docx?|rtf|txt|odt|pages)$|^application\/pdf$|^application\/msword$|wordprocessingml|^application\/rtf$|^text\/plain$|opendocument\.text/;
  return parts.every((part) => documentLike.test(part)) ? "documents" : "other";
}

/** Does this file input feed a parse-and-prefill flow rather than an attachment? */
function isImportControl(context: string): boolean {
  return /autocomplete your application|autofill (with|from)|apply with (your )?(resume|cv)|import (your )?(resume|cv|profile)|parse (your )?(resume|cv)|upload to (auto)?fill/.test(
    context
  );
}

function uploadContextText(input: HTMLInputElement): string {
  const parts: string[] = [];
  const id = input.id;
  if (id) {
    // Scoped: a component's inner input and its host commonly share an id, and
    // the matching <label for> lives in the component's own shadow root.
    const label = scopedQuery(input, `label[for="${cssEscape(id)}"]`);
    if (label?.textContent) parts.push(label.textContent);
  }
  parts.push(input.getAttribute("name") || "", input.id || "", input.getAttribute("aria-label") || "");
  const labelledby = (input.getAttribute("aria-labelledby") || "").split(/\s+/).filter(Boolean);
  for (const lid of labelledby) parts.push(scopedElementById(input, lid)?.textContent || "");

  // The component host's own attributes name the control when its internals do
  // not (`<spl-dropzone data-test="resume-upload">` vs `"apply-with-resume-container"`).
  for (const host of hostChain(input)) {
    parts.push(
      host.tagName.toLowerCase(),
      host.getAttribute("data-test") || "",
      host.getAttribute("data-testid") || "",
      host.getAttribute("label") || "",
      host.getAttribute("aria-label") || "",
      host.id || ""
    );
  }

  const container = deepClosest(input, "div,fieldset,section,li");
  if (container) {
    // Include button/label text within the same upload block ("Attach", etc.).
    parts.push(deepQuery(container, "label,legend,h1,h2,h3,h4,button,[role=button]")?.textContent || "");
    parts.push(container.getAttribute?.("data-field") || "");
  }
  // Which SECTION the control sits in. Two SmartRecruiters dropzones are
  // otherwise identical — same id, same accept list — and only the heading
  // above them ("Easy Apply" vs "Resume") tells them apart.
  parts.push(nearestHeadingText(input));
  // Separators are normalised so identifiers read as words: an ATS names this
  // control `data-test="apply-with-resume-container"` or
  // `data-testid="parse_resume_upload"`, and only a word-level view can tell an
  // import control from an attachment field.
  return parts.join(" ").toLowerCase().replace(/[-_]+/g, " ").replace(/\s+/g, " ");
}

/** The component hosts above this element, innermost first. */
function hostChain(element: Element): Element[] {
  const chain: Element[] = [];
  let node: Element | null = element;
  for (let hops = 0; node && hops < 4; hops += 1) {
    const root = node.getRootNode();
    if (!(root instanceof ShadowRoot)) break;
    node = root.host;
    chain.push(node);
  }
  return chain;
}

function cssEscape(value: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") return CSS.escape(value);
  return value.replace(/["\\]/g, "\\$&");
}

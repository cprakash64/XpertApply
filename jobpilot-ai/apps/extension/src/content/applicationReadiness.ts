/**
 * Bounded dynamic-readiness for a destination application page.
 *
 * The live failure this exists to fix: the "I'm interested" CTA opened the
 * destination application correctly, the destination content script attached,
 * the session rebound — and the widget then sat on "Detecting fields / Filled 0
 * of 0" forever, on a page that visibly contained a resume upload, first/last
 * name, email, confirm email, city, phone country code, phone number, Experience
 * and Education.
 *
 * The cause is structural, not cosmetic. Discovery ran ONE scan against the
 * document as it existed the instant the content script announced readiness.
 * The destination application hydrates after that point, so the scan saw zero
 * applicant controls — and a zero-control page was classified as a job listing
 * and latched terminal, which also disarmed the mutation observer that would
 * otherwise have noticed the form arriving a moment later.
 *
 * So this module replaces "scan once, conclude forever" with a bounded process:
 *
 *   1. look at the document as it is now;
 *   2. if there is no application yet, WATCH for one (mutations, not polling);
 *   3. require a short quiet window after fields appear, so discovery does not
 *      race a half-rendered form;
 *   4. re-arm when the application root is replaced mid-hydration;
 *   5. stop at a hard deadline with ONE stable failure code.
 *
 * Every exit is terminal and named. "Still detecting" is not an outcome this
 * function can return, because that is precisely the state the user was stuck in.
 */

import { resolveApplicationForm } from "../ats/base";
import type { FormRootResult } from "../ats/formRoot";
import {
  deepClosest,
  deepQueryAll,
  openShadowHostCount,
  scopedElementById,
  scopedQuery
} from "../dom/deepDom";

/** The handoff stages, in the order a healthy destination passes through them. */
export type ReadinessStage =
  | "CONTENT_SCRIPT_READY"
  | "SESSION_REBOUND"
  | "APPLICATION_ROOT_WAITING"
  | "APPLICATION_ROOT_FOUND"
  | "FIELD_DISCOVERY_STARTED"
  | "FIELD_DISCOVERY_COMPLETED"
  | "AUTOFILL_STARTED";

/** Stable terminal codes. None of these is a success, and none is silent. */
export type ReadinessFailureCode =
  | "APPLICATION_ROOT_NOT_FOUND"
  | "APPLICATION_FRAME_UNAVAILABLE"
  | "FIELD_DISCOVERY_RETURNED_ZERO"
  | "APPLICATION_DISCOVERY_TIMEOUT";

/**
 * What makes a page an application.
 *
 * Deliberately several independent signals: no single one of them is present on
 * every ATS, and requiring a confident form root alone is what let a visibly
 * populated page report "0 of 0".
 */
export interface ApplicationEvidence {
  resumeUpload: boolean;
  nameFields: boolean;
  emailFields: boolean;
  phoneField: boolean;
  repeatableSectionControls: boolean;
  multiFieldForm: boolean;
  personalInformationHeading: boolean;
  /** Applicant-shaped controls found, excluding JobPilot's own widget. */
  applicantControlCount: number;
}

export interface FrameCensus {
  /** Index in `document.querySelectorAll("iframe")`; never a URL. */
  frameIndex: number;
  /** Origin only — no path, no query. */
  origin: string;
  accessible: boolean;
  applicantControlCount: number;
  /**
   * Could this frame plausibly HOLD the application?
   *
   * The live misdiagnosis this exists to stop: the SmartRecruiters application
   * page embeds one `about:blank` iframe belonging to the LinkedIn
   * `@linkedin/xdoor-sdk` tracker. Its `contentDocument` is null, so it counted
   * as "an unreadable frame", and a readiness timeout on a page whose form was
   * simply in shadow DOM was reported as
   * "JobPilot could not reach the embedded application form."
   *
   * A frame with no navigable document of its own is never that application.
   */
  plausibleApplicationHost: boolean;
}

export interface ReadinessResult {
  ready: boolean;
  stage: ReadinessStage;
  failureCode: ReadinessFailureCode | null;
  root: FormRootResult | null;
  evidence: ApplicationEvidence;
  /**
   * Where the application actually is. `frame` means this document has no
   * application of its own but a readable child frame does — that frame runs its
   * own content-script instance and owns discovery, so the top frame must NOT
   * report a tab-level failure.
   */
  evidenceLocation: "top" | "frame" | "none";
  /** Every frame inspected, with its own control count. */
  frames: FrameCensus[];
  /** Total applicant controls seen across this document and readable frames. */
  fieldCount: number;
  elapsedMs: number;
  /** How many times the application root was seen to change during hydration. */
  rootReplacements: number;
  /** Open shadow hosts in this document — diagnostics for web-component ATSs. */
  openShadowHosts: number;
}

export interface ReadinessOptions {
  doc?: Document;
  /** Hard ceiling. After this the result is terminal and named. */
  timeoutMs?: number;
  /** Settling window required after evidence appears, before discovery runs. */
  quietMs?: number;
  /** Called on every stage change, so the widget never shows a frozen label. */
  onStage?: (stage: ReadinessStage, detail: { elapsedMs: number; fieldCount: number }) => void;
  /** Injected for tests; defaults to `Date.now`. */
  now?: () => number;
}

/** JobPilot's own UI is never evidence of an employer application. */
const WIDGET_ROOT = "#jobpilot-assisted-apply";

const APPLICANT_CONTROL_SELECTOR =
  'input:not([type=hidden]):not([type=submit]):not([type=button]),textarea,select,[contenteditable=true],[role=combobox],[role=listbox]';

function ours(element: Element): boolean {
  return deepClosest(element, WIDGET_ROOT) !== null;
}

function visible(element: Element): boolean {
  const style = element.ownerDocument.defaultView?.getComputedStyle(element);
  if (!style) return true;
  return style.display !== "none" && style.visibility !== "hidden";
}

function applicantControls(doc: Document): Element[] {
  // Shadow-piercing. The live ServiceNow destination (SmartRecruiters
  // "Easy Apply") renders every control inside an open shadow root, so the
  // light-DOM-only count was 0 on a fully rendered application — which is what
  // made readiness time out and then blame an unrelated iframe.
  return deepQueryAll<Element>(doc, APPLICANT_CONTROL_SELECTOR).filter(
    (element) => !ours(element) && visible(element)
  );
}

/** Accessible text a labelling rule would attach to this control. */
function controlText(element: Element): string {
  const labelledBy = element.getAttribute("aria-labelledby");
  const referenced = labelledBy
    ? labelledBy.split(/\s+/).map((id) => scopedElementById(element, id)?.textContent ?? "").join(" ")
    : "";
  const wrapping = deepClosest(element, "label")?.textContent ?? "";
  const forLabel = element.id
    ? scopedQuery(element, `label[for="${cssEscape(element.id)}"]`)?.textContent ?? ""
    : "";
  return [
    element.getAttribute("aria-label") ?? "",
    element.getAttribute("placeholder") ?? "",
    element.getAttribute("name") ?? "",
    element.getAttribute("autocomplete") ?? "",
    // Web-component fields (`<spl-input label="First name">`) carry the question
    // on the host, where no ARIA rule would look for it.
    hostLabel(element),
    element.id,
    referenced,
    wrapping,
    forLabel
  ].join(" ");
}

/** `label` attribute of the nearest web-component host. */
function hostLabel(element: Element): string {
  let node: Element | null = element;
  for (let hops = 0; node && hops < 4; hops += 1) {
    const value = node.getAttribute("label");
    if (value?.trim()) return value;
    const root = node.getRootNode();
    node = root instanceof ShadowRoot ? root.host : null;
  }
  return "";
}

function cssEscape(value: string): string {
  return value.replace(/(["\\])/g, "\\$1");
}

function matchesAny(controls: Element[], pattern: RegExp): boolean {
  return controls.some((control) => pattern.test(controlText(control)));
}

/**
 * Read the current application evidence out of a document.
 *
 * Pure observation: never clicks, fills, or navigates.
 */
export function collectApplicationEvidence(doc: Document = document): ApplicationEvidence {
  const controls = applicantControls(doc);
  const fileInputs = deepQueryAll(doc, 'input[type="file"]').filter((element) => !ours(element));
  // File inputs are deliberately NOT visibility-filtered: several ATSs hide the
  // real input behind a styled "Attach" button, and it is the single strongest
  // application signal on the page.

  const headings = deepQueryAll(doc, "h1,h2,h3,h4,legend,[role=heading]")
    .filter((element) => !ours(element))
    .map((element) => (element.textContent ?? "").trim());

  const addControls = deepQueryAll(doc, 'button,[role="button"],a[href]')
    .filter((element) => !ours(element) && visible(element))
    .map((element) => (element.getAttribute("aria-label") ?? element.textContent ?? "").trim());

  return {
    resumeUpload: fileInputs.length > 0 || /\b(resume|r[ée]sum[ée]|\bcv\b)\b/i.test(headings.join(" ")),
    nameFields: matchesAny(controls, /first[\s_-]*name/i) && matchesAny(controls, /last[\s_-]*name|surname|family[\s_-]*name/i),
    emailFields: matchesAny(controls, /e-?mail/i),
    phoneField: matchesAny(controls, /phone|mobile|telephone/i),
    repeatableSectionControls: addControls.some((label) =>
      /^\+?\s*add\b/i.test(label) && /experience|education|employment|school|degree|position/i.test(label)
    ) || headings.some((heading) => /^(work\s+)?experience$|^education$/i.test(heading)),
    multiFieldForm: deepQueryAll(doc, "form")
      .filter((form) => !ours(form))
      .some((form) => applicantControlsIn(form).length >= 4),
    personalInformationHeading: headings.some((heading) =>
      /personal\s+information|personal\s+details|about\s+you|your\s+information/i.test(heading)
    ),
    applicantControlCount: controls.length
  };
}

function applicantControlsIn(root: Element): Element[] {
  return deepQueryAll<Element>(root, APPLICANT_CONTROL_SELECTOR).filter(
    (element) => !ours(element) && visible(element)
  );
}

/**
 * Is there enough evidence to call this an application?
 *
 * Two independent signals, or one very strong one. A single stray text input on
 * a marketing page must not qualify; a hydrated application always will.
 */
export function hasApplicationEvidence(evidence: ApplicationEvidence): boolean {
  const signals = [
    evidence.resumeUpload,
    evidence.nameFields,
    evidence.emailFields,
    evidence.phoneField,
    evidence.repeatableSectionControls,
    evidence.multiFieldForm,
    evidence.personalInformationHeading
  ].filter(Boolean).length;
  if (evidence.nameFields && evidence.emailFields) return true;
  return signals >= 2;
}

/**
 * Census of child frames.
 *
 * A frame we cannot read is reported as inaccessible rather than counted as
 * empty — the difference between `APPLICATION_FRAME_UNAVAILABLE` and a false
 * `APPLICATION_ROOT_NOT_FOUND`. Cross-origin application frames get their own
 * content script (the manifest injects into all frames) and report in
 * separately; this census exists so the top frame can explain itself instead of
 * showing a bare 0.
 */
export function censusChildFrames(doc: Document = document): FrameCensus[] {
  return Array.from(doc.querySelectorAll("iframe")).map((frame, frameIndex) => {
    let origin = "unknown";
    try {
      origin = new URL(frame.src || doc.location.href, doc.location.href).origin;
    } catch {
      /* an unparseable src is reported as unknown, never guessed at */
    }
    const plausibleApplicationHost = plausibleFrameHost(frame, doc);
    try {
      const inner = frame.contentDocument;
      if (!inner) return { frameIndex, origin, accessible: false, applicantControlCount: 0, plausibleApplicationHost };
      return {
        frameIndex,
        origin,
        accessible: true,
        applicantControlCount: applicantControls(inner).length,
        plausibleApplicationHost
      };
    } catch {
      // Cross-origin: expected, not an error.
      return { frameIndex, origin, accessible: false, applicantControlCount: 0, plausibleApplicationHost };
    }
  });
}

/**
 * Could an unreadable frame be the application?
 *
 * Requires a real navigable http(s) document AND a box big enough to render a
 * form. Tracking pixels (0×0, 1×1) and `about:blank`/`srcdoc` SDK channels are
 * neither, and treating them as candidate application frames is what turned a
 * shadow-DOM discovery failure into a false "embedded form" verdict.
 *
 * Where no layout engine is available (jsdom, an offscreen frame) size is
 * unknown rather than zero, so the URL test alone decides.
 */
function plausibleFrameHost(frame: HTMLIFrameElement, doc: Document): boolean {
  const raw = (frame.getAttribute("src") ?? "").trim();
  if (!raw || raw.toLowerCase().startsWith("about:") || raw.toLowerCase().startsWith("data:")) return false;
  let resolved: URL;
  try {
    resolved = new URL(raw, doc.location?.href);
  } catch {
    return false;
  }
  if (!/^https?:$/.test(resolved.protocol)) return false;

  const box = frame.getBoundingClientRect?.();
  // A layout-free environment reports 0×0 for everything; only treat measured,
  // genuinely tiny frames as trackers.
  const measured = Boolean(box && (box.width > 0 || box.height > 0));
  if (measured && box!.width * box!.height < 10_000) return false;
  return true;
}

/** Child documents we are actually permitted to read. */
function readableFrameDocuments(doc: Document): Document[] {
  return Array.from(doc.querySelectorAll("iframe")).flatMap((frame) => {
    try {
      const inner = frame.contentDocument;
      return inner ? [inner] : [];
    } catch {
      // Cross-origin: expected. That frame runs its own content script.
      return [];
    }
  });
}

/**
 * Is there an application anywhere this frame can see?
 *
 * A destination whose form lives in a same-origin child frame is a real and
 * common shape. Judging readiness on the top document alone means waiting out
 * the full timeout and then reporting a failure for a form we can read perfectly
 * well — the "0 of 0" symptom in a different disguise.
 */
function aggregateEvidence(doc: Document): {
  top: ApplicationEvidence;
  location: "top" | "frame" | "none";
  sufficient: boolean;
} {
  const top = collectApplicationEvidence(doc);
  if (hasApplicationEvidence(top)) return { top, location: "top", sufficient: true };
  const inFrame = readableFrameDocuments(doc).some((inner) =>
    hasApplicationEvidence(collectApplicationEvidence(inner))
  );
  return { top, location: inFrame ? "frame" : "none", sufficient: inFrame };
}

/**
 * A snapshot the caller can compare across hydration steps.
 *
 * Includes the child-frame control tally, so a form hydrating inside a frame
 * re-arms the settling window instead of being discovered half-built.
 */
function rootFingerprint(doc: Document, root: FormRootResult): string {
  const element = root.root as Element | null;
  const frames = censusChildFrames(doc)
    .map((frame) => `${frame.frameIndex}:${frame.accessible ? frame.applicantControlCount : "x"}`)
    .join(",");
  if (!element) return `none|${applicantControls(doc).length}|${frames}`;
  return `${element.tagName}:${element.id}:${applicantControlsIn(element).length}|${frames}`;
}

function tally(doc: Document, frames: FrameCensus[]): number {
  return applicantControls(doc).length
    + frames.filter((frame) => frame.accessible).reduce((sum, frame) => sum + frame.applicantControlCount, 0);
}

/**
 * Wait — boundedly — for the destination application to be ready to discover.
 *
 * Resolves exactly once, always with a terminal verdict. The caller must treat a
 * `ready: false` result as a named failure to show the user, never as a reason
 * to keep the widget on "Detecting fields".
 */
export function awaitApplicationReadiness(options: ReadinessOptions = {}): Promise<ReadinessResult> {
  const doc = options.doc ?? document;
  const timeoutMs = options.timeoutMs ?? 20_000;
  const quietMs = options.quietMs ?? 400;
  const now = options.now ?? (() => Date.now());
  const startedAt = now();
  const view = doc.defaultView ?? window;

  return new Promise<ReadinessResult>((resolve) => {
    let settled = false;
    let stage: ReadinessStage = "CONTENT_SCRIPT_READY";
    let rootReplacements = 0;
    let lastFingerprint: string | null = null;
    let quietTimer: number | null = null;
    let observer: MutationObserver | null = null;
    let deadlineTimer: number | null = null;

    const announce = (next: ReadinessStage, fieldCount: number): void => {
      if (stage === next) return;
      stage = next;
      options.onStage?.(next, { elapsedMs: now() - startedAt, fieldCount });
    };

    const finish = (ready: boolean, failureCode: ReadinessFailureCode | null, root: FormRootResult | null): void => {
      if (settled) return;
      settled = true;
      observer?.disconnect();
      if (quietTimer !== null) view.clearTimeout(quietTimer);
      if (deadlineTimer !== null) view.clearTimeout(deadlineTimer);
      const frames = censusChildFrames(doc);
      const aggregate = aggregateEvidence(doc);
      resolve({
        ready,
        stage: ready ? "APPLICATION_ROOT_FOUND" : stage,
        failureCode,
        root,
        evidence: aggregate.top,
        evidenceLocation: aggregate.location,
        frames,
        fieldCount: tally(doc, frames),
        elapsedMs: now() - startedAt,
        rootReplacements,
        openShadowHosts: openShadowHostCount(doc)
      });
    };

    /**
     * One evaluation of the current document.
     *
     * Returns true only when the application looks ready AND has stayed still
     * for the quiet window — a form still adding fields is not ready, and
     * discovering it mid-render is how stale element references are born.
     */
    const evaluate = (): void => {
      if (settled) return;
      const frames = censusChildFrames(doc);
      const fieldCount = tally(doc, frames);

      if (!aggregateEvidence(doc).sufficient) {
        // Nothing yet. This is EXPECTED before hydration and must never latch.
        announce("APPLICATION_ROOT_WAITING", fieldCount);
        if (quietTimer !== null) {
          view.clearTimeout(quietTimer);
          quietTimer = null;
        }
        return;
      }

      const root = resolveApplicationForm(doc);
      const fingerprint = rootFingerprint(doc, root);
      if (lastFingerprint !== null && lastFingerprint !== fingerprint) {
        // The application root was replaced during hydration (a React remount,
        // an SPA route landing). Every element reference from before is dead, so
        // the quiet window restarts rather than the run proceeding on stale nodes.
        rootReplacements += 1;
        if (quietTimer !== null) {
          view.clearTimeout(quietTimer);
          quietTimer = null;
        }
      }
      lastFingerprint = fingerprint;
      announce("APPLICATION_ROOT_WAITING", fieldCount);

      if (quietTimer !== null) return;
      quietTimer = view.setTimeout(() => {
        quietTimer = null;
        if (settled) return;
        if (!aggregateEvidence(doc).sufficient) return;
        const settledRoot = resolveApplicationForm(doc);
        if (rootFingerprint(doc, settledRoot) !== lastFingerprint) {
          // Still moving. Re-arm instead of discovering a half-built form.
          lastFingerprint = rootFingerprint(doc, settledRoot);
          evaluate();
          return;
        }
        announce("APPLICATION_ROOT_FOUND", tally(doc, censusChildFrames(doc)));
        finish(true, null, settledRoot);
      }, quietMs) as unknown as number;
    };

    // 1. The document as it is right now. A hydrated destination resolves here.
    evaluate();
    if (settled) return;

    // 2. Otherwise WATCH. This is the step whose absence produced the live
    //    "0 of 0": the previous code concluded from the first scan alone.
    const target = doc.body ?? doc.documentElement;
    if (target) {
      observer = new MutationObserver(() => evaluate());
      observer.observe(target, { childList: true, subtree: true, attributes: true, attributeFilter: ["type", "name", "aria-label", "hidden", "style"] });
    }

    // 3. A hard deadline. "Detecting fields" forever is not an acceptable end
    //    state, so the timeout names exactly what was and was not found.
    deadlineTimer = view.setTimeout(() => {
      if (settled) return;
      const frames = censusChildFrames(doc);
      // Only a frame that could actually HOLD an application counts. Blaming an
      // analytics `about:blank` frame is what produced "could not reach the
      // embedded application form" on a page whose form was in shadow DOM.
      const unreadableFrames = frames.filter(
        (frame) => !frame.accessible && frame.plausibleApplicationHost
      );
      const failureCode: ReadinessFailureCode = aggregateEvidence(doc).sufficient
        // Evidence but no settled root: discovery would return nothing useful.
        ? (tally(doc, frames) === 0 ? "FIELD_DISCOVERY_RETURNED_ZERO" : "APPLICATION_DISCOVERY_TIMEOUT")
        : unreadableFrames.length > 0
          // A form we are not permitted to read is a DIFFERENT problem from a
          // form that never rendered, and the user deserves the difference.
          ? "APPLICATION_FRAME_UNAVAILABLE"
          : "APPLICATION_ROOT_NOT_FOUND";
      finish(false, failureCode, null);
    }, timeoutMs) as unknown as number;
  });
}

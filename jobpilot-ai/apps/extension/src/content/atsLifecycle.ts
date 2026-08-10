export type AtsLifecycleState =
  | "INITIALIZING"
  | "DISCOVERING_INITIAL_PAGE"
  | "PREPARING_DOCUMENTS"
  | "UPLOADING_RESUME"
  | "WAITING_FOR_ATS_PARSE"
  | "ATS_PARSE_ACTIVITY_DETECTED"
  | "ATS_PARSE_SETTLING"
  | "INVALIDATING_PRE_PARSE_RUN"
  | "REDISCOVERING_POST_PARSE_DOM"
  | "RECONCILING_ATS_VALUES"
  | "FILLING_SCALAR_FIELDS"
  | "FILLING_REPEATABLE_SECTIONS"
  | "VERIFYING_APPLICATION"
  | "FILLING_COMPLETE"
  | "FINAL_LIVE_DOM_RESCAN"
  | "REQUIRED_CONTROL_VALIDATION"
  | "REPEATER_VALIDATION"
  | "CONSENT_VALIDATION"
  | "REVIEW_READY"
  | "DOCUMENT_UPLOAD_FAILED"
  | "ATS_PARSE_TIMEOUT"
  | "POST_PARSE_REDISCOVERY_FAILED"
  | "SCALAR_FILL_PARTIAL"
  | "REPEATER_FILL_PARTIAL"
  | "TECHNICAL_REVIEW_REQUIRED";

export interface LifecycleCounts {
  scalarFields?: number;
  repeatableSections?: number;
  populatedFields?: number;
  relevantMutations?: number;
  unresolved?: number;
  optionalSkipped?: number;
  unsupported?: number;
}

export interface LifecycleTransition {
  state: AtsLifecycleState;
  runId: string;
  timestamp: string;
  applicationSessionId: number;
  pageFingerprint: string;
  domGeneration: number;
  extensionBuildId: string;
  reason: string;
  counts: LifecycleCounts;
}

export interface LifecycleToken {
  runId: string;
  domGeneration: number;
  pageFingerprint: string;
}

let lifecycleSequence = 0;

export class AtsLifecycleRun {
  readonly runId: string;
  readonly createdAt: string;
  private generation = 0;
  private fingerprint: string;
  private transitions: LifecycleTransition[] = [];
  private controller = new AbortController();

  constructor(
    readonly applicationSessionId: number,
    readonly extensionBuildId: string,
    fingerprint = pageFingerprint(document)
  ) {
    const now = Date.now();
    this.runId = `${extensionBuildId}:ats:${now.toString(36)}:${(++lifecycleSequence).toString(36)}`;
    this.createdAt = new Date(now).toISOString();
    this.fingerprint = fingerprint;
  }

  transition(state: AtsLifecycleState, reason: string, counts: LifecycleCounts = {}): LifecycleTransition {
    const entry = {
      state,
      runId: this.runId,
      timestamp: new Date().toISOString(),
      applicationSessionId: this.applicationSessionId,
      pageFingerprint: this.fingerprint,
      domGeneration: this.generation,
      extensionBuildId: this.extensionBuildId,
      reason,
      counts: { ...counts }
    };
    this.transitions.push(entry);
    return entry;
  }

  invalidatePreParse(reason = "ats_parse_completed"): LifecycleToken {
    this.transition("INVALIDATING_PRE_PARSE_RUN", reason);
    this.controller.abort();
    this.controller = new AbortController();
    this.generation += 1;
    this.fingerprint = pageFingerprint(document);
    return this.token();
  }

  token(): LifecycleToken {
    return { runId: this.runId, domGeneration: this.generation, pageFingerprint: this.fingerprint };
  }

  accepts(token: LifecycleToken): boolean {
    const current = this.token();
    return token.runId === current.runId
      && token.domGeneration === current.domGeneration
      && token.pageFingerprint === current.pageFingerprint;
  }

  signal(): AbortSignal { return this.controller.signal; }
  trace(): LifecycleTransition[] { return this.transitions.map((item) => ({ ...item, counts: { ...item.counts } })); }
  domGeneration(): number { return this.generation; }
}

export interface ParseWaitOptions {
  quietWindowMs?: number;
  maximumWaitMs?: number;
  activityGraceMs?: number;
  now?: () => number;
}

export interface ParseWaitResult {
  settled: boolean;
  activityDetected: boolean;
  relevantMutations: number;
  fieldCountBefore: number;
  fieldCountAfter: number;
  sectionCountBefore: number;
  sectionCountAfter: number;
  populatedBefore: number;
  populatedAfter: number;
  reason: "quiet_window" | "no_activity_observed" | "timeout" | "aborted";
}

/** Mutation-based parse settling. Observes the document so replacing the old
 * application root is itself a relevant signal. */
export async function waitForAtsParse(
  root: ParentNode,
  signal: AbortSignal,
  options: ParseWaitOptions = {}
): Promise<ParseWaitResult> {
  const quietWindowMs = options.quietWindowMs ?? 1400;
  const maximumWaitMs = options.maximumWaitMs ?? 15_000;
  const activityGraceMs = options.activityGraceMs ?? 900;
  const now = options.now ?? Date.now;
  const before = domMetrics(root);
  const startedAt = now();
  let lastRelevantAt = startedAt;
  let activityDetected = false;
  let relevantMutations = 0;

  const observeRoot = root instanceof Document ? root.documentElement : root.ownerDocument?.documentElement ?? document.documentElement;
  const observer = new MutationObserver((records) => {
    const relevant = records.filter(isRelevantMutation).length;
    if (relevant === 0) return;
    relevantMutations += relevant;
    activityDetected = true;
    lastRelevantAt = now();
  });
  observer.observe(observeRoot, { childList: true, subtree: true, attributes: true, characterData: true });

  let reason: ParseWaitResult["reason"] = "timeout";
  try {
    while (now() - startedAt < maximumWaitMs) {
      if (signal.aborted) { reason = "aborted"; break; }
      const elapsed = now() - startedAt;
      const quietFor = now() - lastRelevantAt;
      if (activityDetected && quietFor >= quietWindowMs) { reason = "quiet_window"; break; }
      if (!activityDetected && elapsed >= activityGraceMs) { reason = "no_activity_observed"; break; }
      await new Promise((resolve) => window.setTimeout(resolve, Math.min(100, quietWindowMs)));
    }
  } finally {
    observer.disconnect();
  }
  const currentRoot = root instanceof Document || (root as Node).isConnected ? root : document;
  const after = domMetrics(currentRoot);
  return {
    settled: reason === "quiet_window" || reason === "no_activity_observed",
    activityDetected,
    relevantMutations,
    fieldCountBefore: before.scalarFields,
    fieldCountAfter: after.scalarFields,
    sectionCountBefore: before.repeatableSections,
    sectionCountAfter: after.repeatableSections,
    populatedBefore: before.populatedFields,
    populatedAfter: after.populatedFields,
    reason
  };
}

function isRelevantMutation(record: MutationRecord): boolean {
  const target = record.target instanceof Element ? record.target : record.target.parentElement;
  if (!target) return false;
  if (target.closest("#jobpilot-assisted-apply")) return false;
  if (record.type === "attributes") {
    return ["value", "aria-expanded", "aria-busy", "aria-disabled", "disabled", "hidden", "class"]
      .includes(record.attributeName ?? "");
  }
  if (record.type === "characterData") return Boolean(target.closest("form,[role=form],main,section"));
  return Array.from(record.addedNodes).concat(Array.from(record.removedNodes)).some((node) =>
    node instanceof Element && (
      node.matches("input,select,textarea,button,[role=combobox],[role=dialog],section,fieldset,form")
      || Boolean(node.querySelector("input,select,textarea,button,[role=combobox],[role=dialog]"))
    )
  );
}

export function domMetrics(root: ParentNode): Required<LifecycleCounts> {
  const controls = Array.from(root.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | HTMLElement>(
    "input:not([type=hidden]),select,textarea,[contenteditable=true],[role=combobox]"
  ));
  const populated = controls.filter((item) => {
    if (item instanceof HTMLSelectElement) return Boolean(item.value);
    if (item instanceof HTMLInputElement || item instanceof HTMLTextAreaElement) return Boolean(item.value.trim());
    return Boolean(item.textContent?.trim());
  }).length;
  const sections = Array.from(root.querySelectorAll("section,fieldset,[role=region]")).filter((item) =>
    /project|award|honor|language|internship|work sample|self.?introduction|sns|social/i.test(item.textContent ?? "")
  ).length;
  return {
    scalarFields: controls.length,
    repeatableSections: sections,
    populatedFields: populated,
    relevantMutations: 0,
    unresolved: 0,
    optionalSkipped: 0,
    unsupported: 0
  };
}

export function pageFingerprint(doc: Document): string {
  const material = [doc.location.origin, doc.location.pathname,
    doc.querySelector("form,[role=form]")?.getAttribute("id") ?? "",
    doc.querySelector("h1,[role=heading]")?.textContent?.trim() ?? ""
  ].join("\u001f");
  let hash = 2166136261;
  for (let index = 0; index < material.length; index += 1) {
    hash ^= material.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `page_${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

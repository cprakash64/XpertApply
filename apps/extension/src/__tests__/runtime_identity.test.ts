/**
 * Runtime identity, and the widget states that must be unreachable.
 *
 * These exist because of a live failure that a green test suite could not
 * explain: three legal questions sat empty and the panel showed
 * "Detecting fields / Filled 0 of 0" beside "Discovered 11 / Filled 1".
 *
 * Two distinct causes are covered here. First, a mixed-build or
 * mixed-environment runtime, which produces exactly those symptoms and which
 * nothing previously detected. Second, the widget's own arithmetic: the
 * contradictory summary was possible because two independent writers reported
 * totals, and it is now impossible because only one does.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BUILD_MISMATCH_MESSAGE,
  ENVIRONMENT_MISMATCH_MESSAGE,
  ACCOUNT_MISMATCH_MESSAGE,
  WORKER_UNREACHABLE_MESSAGE,
  classifyEnvironment,
  evaluateHandshake,
  handshakeSummary,
  type ApiEnvironment,
  type RuntimeHandshake,
  type RuntimeIdentity
} from "../runtimeIdentity";
import { createWidget } from "../content/widget";
import {
  QuestionLedger,
  STAGE_LABEL,
  computeQuestionCounts,
  questionCountsReconcile,
  type QuestionState
} from "../content/questionLedger";
import type { LedgerCounts } from "../fields/ledger";

function identity(buildId: string, environment: ApiEnvironment = "local"): RuntimeIdentity {
  return { buildId, version: "0.2.0", environment };
}

function handshake(overrides: Partial<RuntimeHandshake> = {}): RuntimeHandshake {
  const self = identity("abc1234");
  return {
    contentScript: self,
    serviceWorker: self,
    widget: self,
    webEnvironment: "local",
    ...overrides
  };
}

describe("environment classification", () => {
  it.each([
    ["http://localhost:8000", "local"],
    ["http://127.0.0.1:8000", "local"],
    ["http://api.local", "local"],
    ["https://staging.jobpilot.ai", "staging"],
    ["https://api-dev.example.com", "staging"],
    ["https://qa.example.com", "staging"],
    ["https://jobpilot.ai", "production"],
    ["https://api.jobpilot.ai", "production"],
    ["https://app.jobpilot.ai", "production"]
  ] as [string, ApiEnvironment][])("classifies %s as %s", (url, expected) => {
    expect(classifyEnvironment(url)).toBe(expected);
  });

  it("refuses to guess for anything unrecognised", () => {
    // Deliberately NOT "production": assuming production for a self-hosted
    // backend would block a legitimate deployment.
    expect(classifyEnvironment("https://careers.acme.example")).toBe("unknown");
    expect(classifyEnvironment("not a url")).toBe("unknown");
    expect(classifyEnvironment("")).toBe("unknown");
  });
});

describe("the runtime handshake", () => {
  it("allows a run when every context is the same build and environment", () => {
    expect(evaluateHandshake(handshake())).toEqual({ ok: true, reason: "ok", message: "" });
  });

  it("blocks when the service worker is a different build", () => {
    const verdict = evaluateHandshake(
      handshake({ serviceWorker: identity("older99") })
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toBe("build_mismatch");
    expect(verdict.message).toBe(BUILD_MISMATCH_MESSAGE);
  });

  it("blocks when the widget is a different build", () => {
    expect(evaluateHandshake(handshake({ widget: identity("older99") })).reason)
      .toBe("build_mismatch");
  });

  it("exposes a stale side-panel context", () => {
    const verdict = evaluateHandshake(handshake({ sidePanel: identity("older-panel") }));
    expect(verdict.reason).toBe("build_mismatch");
    expect(handshakeSummary(
      handshake({ sidePanel: identity("older-panel") }),
      verdict
    ).sidePanelBuild).toBe("older-panel");
  });

  it("blocks when the worker does not answer at all", () => {
    const verdict = evaluateHandshake(handshake({ serviceWorker: null }));
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toBe("worker_unreachable");
    expect(verdict.message).toBe(WORKER_UNREACHABLE_MESSAGE);
  });

  it("reports a build mismatch BEFORE an environment mismatch", () => {
    // A mixed-build runtime cannot be trusted to describe its own environment,
    // so telling the user to fix the environment would send them the wrong way.
    const verdict = evaluateHandshake(
      handshake({ serviceWorker: identity("older99", "production") })
    );
    expect(verdict.reason).toBe("build_mismatch");
  });

  it("blocks when the extension and the worker disagree about the backend", () => {
    const verdict = evaluateHandshake({
      ...handshake(),
      serviceWorker: identity("abc1234", "production")
    });
    expect(verdict.reason).toBe("environment_mismatch");
    expect(verdict.message).toBe(ENVIRONMENT_MISMATCH_MESSAGE);
  });

  it("blocks when the profile was saved in a different environment", () => {
    // The saved answer genuinely is not present in the backend the extension is
    // talking to, which is indistinguishable from "you never answered" unless
    // it is caught here.
    const verdict = evaluateHandshake(handshake({ webEnvironment: "production" }));
    expect(verdict.reason).toBe("environment_mismatch");
    expect(verdict.message).toBe(ENVIRONMENT_MISMATCH_MESSAGE);
  });

  it("blocks two different API bases even when both are local", () => {
    const localA = { ...identity("abc1234"), apiBase: "http://localhost:8000" };
    const localB = { ...identity("abc1234"), apiBase: "http://localhost:9000" };
    expect(evaluateHandshake({
      ...handshake(), contentScript: localA, serviceWorker: localB
    }).reason).toBe("environment_mismatch");
  });

  it("blocks when the web and extension session users differ", () => {
    const verdict = evaluateHandshake(handshake({
      webAuthenticatedUserId: 3,
      extensionAuthenticatedUserId: 4
    }));
    expect(verdict.reason).toBe("account_mismatch");
    expect(verdict.message).toBe(ACCOUNT_MISMATCH_MESSAGE);
  });

  it("does not block on an unrecognised environment", () => {
    // A self-hosted deployment is unknown but perfectly consistent.
    expect(evaluateHandshake({
      contentScript: identity("abc1234", "unknown"),
      serviceWorker: identity("abc1234", "unknown"),
      widget: identity("abc1234", "unknown"),
      webEnvironment: "unknown"
    }).ok).toBe(true);
    expect(evaluateHandshake(handshake({ webEnvironment: "unknown" })).ok).toBe(true);
    expect(evaluateHandshake(handshake({ webEnvironment: null })).ok).toBe(true);
  });

  it("treats two dev builds as the same build", () => {
    // Every context reports "dev" under Vitest, where esbuild's define is not
    // in play. That is genuinely one build, and falls out of equality.
    const dev = identity("dev");
    expect(evaluateHandshake({
      contentScript: dev, serviceWorker: dev, widget: dev, webEnvironment: "local"
    }).ok).toBe(true);
  });

  it("summarises without leaking a hostname or a token", () => {
    const summary = handshakeSummary(
      handshake({ serviceWorker: identity("older99") }),
      evaluateHandshake(handshake({ serviceWorker: identity("older99") }))
    );
    expect(summary).toEqual({
      contentScriptBuild: "abc1234",
      serviceWorkerBuild: "older99",
      widgetBuild: "abc1234",
      sidePanelBuild: "not_observed",
      extensionEnvironment: "local",
      serviceWorkerEnvironment: "local",
      sidePanelEnvironment: "not_observed",
      webEnvironment: "local",
      contentApiBase: "unknown",
      serviceWorkerApiBase: "unknown",
      sidePanelApiBase: "not_observed",
      webApiBase: "unknown",
      webAuthenticatedUserId: "unknown",
      extensionAuthenticatedUserId: "unknown",
      verdict: "build_mismatch"
    });
    const text = JSON.stringify(summary);
    expect(text).not.toMatch(/localhost:\d+|https?:\/\/|Bearer|token/i);
  });

  it("names the unreachable worker rather than omitting it", () => {
    const summary = handshakeSummary(
      handshake({ serviceWorker: null }),
      evaluateHandshake(handshake({ serviceWorker: null }))
    );
    expect(summary.serviceWorkerBuild).toBe("unreachable");
  });
});

// --------------------------------------------------------------------------- //
// The forbidden widget states
// --------------------------------------------------------------------------- //
let capturedRoot: ShadowRoot | null = null;
let originalAttachShadow: typeof Element.prototype.attachShadow;

beforeEach(() => {
  originalAttachShadow = Element.prototype.attachShadow;
  Element.prototype.attachShadow = function (init: ShadowRootInit) {
    const root = originalAttachShadow.call(this, { ...init, mode: "open" });
    capturedRoot = root;
    return root;
  };
});

afterEach(() => {
  Element.prototype.attachShadow = originalAttachShadow;
  document.getElementById("jobpilot-assisted-apply")?.remove();
  capturedRoot = null;
});

function mount() {
  const widget = createWidget({ retry: () => {}, clear: () => {}, complete: () => {} });
  return { widget, root: capturedRoot! };
}

function text(root: ShadowRoot, selector: string): string {
  return (root.querySelector<HTMLElement>(selector)?.textContent ?? "").trim();
}

/** A ledger snapshot in the widget's shape. */
function counts(overrides: Partial<LedgerCounts> = {}): LedgerCounts {
  return {
    discovered: 11, filled: 1, needsInformation: 10, needsConfirmation: 0,
    sensitive: 0, technical: 0, optionalSkipped: 0, requiredBlank: 10, pending: 10,
    ...overrides
  };
}

describe("the widget cannot contradict the ledger", () => {
  it("ignores a caller's totals once a ledger snapshot exists", () => {
    const { widget, root } = mount();
    widget.refreshCounts(counts());
    // The exact defect from the live report: a caller publishing its own
    // totals — here a raw DOM count of 0 with a hardcoded filled of 0 — while
    // the ledger says 11 discovered and 1 filled.
    widget.update({ stage: "filling", filled: 0, total: 0, message: "Filling…" });

    expect(text(root, ".count")).toBe("Filled 1 of 11");
    expect(text(root, ".count")).not.toBe("Filled 0 of 0");
    expect(text(root, ".counts-row")).toContain("11");
  });

  it("keeps the headline count and the grid in step", () => {
    const { widget, root } = mount();
    widget.update({ stage: "detecting", filled: 0, total: 0 });
    // A later ledger refresh must move BOTH, not just the grid.
    widget.refreshCounts(counts({ discovered: 4, filled: 4, needsInformation: 0, requiredBlank: 0, pending: 0 }));
    expect(text(root, ".count")).toBe("Filled 4 of 4");
    expect(text(root, ".counts-row")).toContain("Discovered: 4");
  });

  it("never says Detecting fields once the ledger has moved past discovery", () => {
    const { widget, root } = mount();
    for (const stage of [
      "reading_options", "matching_answers", "filling", "waiting_for_you", "ready_for_review"
    ] as const) {
      widget.update({ stage: "detecting", stageLabel: STAGE_LABEL[stage] });
      // The header names the LEDGER's stage, not the coarse presentation enum.
      expect(text(root, ".title"), stage).toBe(STAGE_LABEL[stage]);
      expect(text(root, ".title"), stage).not.toBe("Detecting fields");
    }
  });

  it("offers every stage the ledger can be in", () => {
    // A ledger stage with no label would render as blank or fall back to the
    // coarse enum, which is how the old contradiction was possible.
    const stages = [
      "understanding_questions", "reading_options", "matching_answers",
      "filling", "waiting_for_you", "ready_for_review"
    ] as const;
    for (const stage of stages) {
      expect(STAGE_LABEL[stage], stage).toBeTruthy();
    }
    expect(Object.values(STAGE_LABEL)).toEqual([
      "Understanding questions",
      "Reading available options",
      "Matching your saved answers",
      "Filling verified answers",
      "Waiting for your input",
      "Ready for final review"
    ]);
  });

  it("shows a blank count only before any ledger exists", () => {
    const { widget, root } = mount();
    widget.update({ stage: "preparing" });
    expect(text(root, ".count")).toBe("");
  });
});

describe("filled means filled_verified", () => {
  it("counts only verified fills, and the buckets always sum", () => {
    const ledger = new QuestionLedger();
    const states: QuestionState[] = [
      "answer_missing", "requires_confirmation", "requires_user_gesture",
      "interaction_failed", "sensitive_manual", "unsupported", "optional_skipped"
    ];
    states.forEach((state, index) => {
      ledger.record({ fieldKey: `f${index}`, state: "discovered", reasonCode: "x" });
      ledger.record({ fieldKey: `f${index}`, state, reasonCode: "x" });
    });
    ledger.record({ fieldKey: "done", state: "discovered", reasonCode: "x" });
    ledger.record({ fieldKey: "done", state: "canonicalizing", reasonCode: "x" });
    ledger.record({ fieldKey: "done", state: "answer_resolved", reasonCode: "x" });
    ledger.record({ fieldKey: "done", state: "selecting", reasonCode: "x" });
    ledger.record({ fieldKey: "done", state: "filled_verified", reasonCode: "verified" });

    const totals = ledger.counts();
    // Exactly one verified fill, no matter how many fields were touched.
    expect(totals.filled_and_verified).toBe(1);
    expect(totals.discovered).toBe(8);
    expect(questionCountsReconcile(ledger.all())).toBe(true);
    // The live contradiction was filled > 0 with discovered 0. Arithmetically
    // impossible: both come from the same entry list.
    expect(totals.filled_and_verified).toBeLessThanOrEqual(totals.discovered);
  });

  it("cannot report a fill with nothing discovered", () => {
    const empty = computeQuestionCounts([]);
    expect(empty.discovered).toBe(0);
    expect(empty.filled_and_verified).toBe(0);
  });

  it("does not count a selection still in flight as filled", () => {
    const ledger = new QuestionLedger();
    ledger.record({ fieldKey: "a", state: "discovered", reasonCode: "x" });
    ledger.record({ fieldKey: "a", state: "canonicalizing", reasonCode: "x" });
    ledger.record({ fieldKey: "a", state: "answer_resolved", reasonCode: "x" });
    ledger.record({ fieldKey: "a", state: "selecting", reasonCode: "applying" });
    expect(ledger.counts().filled_and_verified).toBe(0);
    expect(ledger.stage()).toBe("filling");
  });
});

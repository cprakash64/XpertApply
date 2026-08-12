import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  TIKTOK_LEGAL_IDENTITIES,
  actuateTikTokLegalField,
  discoverTikTokApplication,
  matchesTikTokApplicationUrl,
  mergeTikTokLegalFields,
  tikTokFailureCode,
  tikTokHostAllowed
} from "../ats/tiktokApplication";
import { discoverFields } from "../fields/discovery";
import { buildLedger } from "../fields/ledger";
import { verifyFinalLiveDom } from "../content/finalVerification";
import { fieldRef } from "../content/questionBatch";
import type { QuestionExecutionTrace } from "../content/diagnostics";
import type { ApplicationSessionData } from "../types";

const URL = "https://careers.tiktok.com/position/123456789/detail";
const session: ApplicationSessionData = {
  sessionId: 66,
  atsType: "generic",
  officialUrl: URL,
  jobTitle: "Engineer",
  company: "TikTok",
  answers: [],
  unresolvedQuestions: []
};

function fixture(trigger = true): string {
  const control = (id: string) => trigger
    ? `<div class="answer-cell"><button id="${id}" type="button" role="combobox" aria-haspopup="listbox" aria-expanded="false">Select</button><input type="hidden" name="${id}_value"></div>`
    : '<div class="answer-cell"><span>Select</span></div>';
  return `<form id="application-form">
    <section class="generated-control-shell">
      <h2>Work Authorization</h2>
      <div class="question-row">
        <div class="question">Are you legally authorized to work in the US without restriction?</div>
        ${control("authorization")}
      </div>
      <div class="question-row">
        <div class="question">Will you now or in the future require visa sponsorship or a visa transfer?</div>
        ${control("sponsorship")}
      </div>
      <label><input id="privacy" type="checkbox"> I agree to the privacy policy</label>
    </section>
  </form>`;
}

function installGeometry(): void {
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn()
  });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    x: 10, y: 10, top: 10, left: 10, right: 210, bottom: 50,
    width: 200, height: 40, toJSON: () => ({})
  } as DOMRect);
  Object.defineProperty(document, "elementFromPoint", {
    configurable: true,
    value: () => document.activeElement
  });
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  if (typeof PointerEvent === "undefined") vi.stubGlobal("PointerEvent", MouseEvent);
  document.body.innerHTML = fixture();
  installGeometry();
});

/**
 * The live blocker, as a test.
 *
 * The authenticated TikTok application is served from
 * `lifeattiktok.com/resume/<id>/apply`. The adapter's host gate accepted only
 * `careers.tiktok.com`, so on the one host that actually renders the Work
 * Authorization questions the adapter never activated at all — and reported the
 * generic `TIKTOK_ADAPTER_NOT_ACTIVATED` while the widget claimed
 * "required remaining: 0" beside two visibly empty dropdowns.
 */
describe("TikTok supported application hosts", () => {
  const LIVE = "https://lifeattiktok.com/resume/123/apply";

  it.each([
    ["the live application route", LIVE],
    ["a query string", "https://lifeattiktok.com/resume/123/apply?foo=bar"],
    ["a locale prefix", "https://lifeattiktok.com/en-US/resume/123/apply"],
    ["a hash-routed SPA path", "https://lifeattiktok.com/resume/123/apply#work-authorization"],
    ["a www subdomain", "https://www.lifeattiktok.com/resume/123/apply"],
    ["an approved careers.tiktok.com route", "https://careers.tiktok.com/position/123/apply"],
    ["a careers.tiktok.com locale route", "https://careers.tiktok.com/en/position/123/application?source=jobs"]
  ])("allows %s", (_label, url) => {
    expect(tikTokHostAllowed(url)).toBe(true);
  });

  it.each([
    // Consumer TikTok is NOT an application surface, and a broad *.tiktok.com
    // match would have swept all of it in.
    ["the consumer site", "https://www.tiktok.com/@someone"],
    ["the bare consumer domain", "https://tiktok.com/foryou"],
    ["a suffix-confusion host", "https://careers.tiktok.com.evil.test/position/123/apply"],
    ["a substring-confusion host", "https://notlifeattiktok.com/resume/123/apply"],
    ["plaintext http", "http://lifeattiktok.com/resume/123/apply"],
    ["an unrelated employer", "https://example.test/position/123/detail"]
  ])("rejects %s", (_label, url) => {
    expect(tikTokHostAllowed(url)).toBe(false);
  });

  it("activates on the live lifeattiktok.com application and inserts both authoritative identities", () => {
    const inventory = discoverTikTokApplication(LIVE, document.querySelector("form")!);

    expect(inventory.active).toBe(true);
    expect(inventory.trace).toMatchObject({
      adapterName: "tiktok_application",
      hostname: "lifeattiktok.com",
      pathShape: "/resume/<id>/apply",
      hostAllowed: true,
      contentScriptAllowed: true,
      applicationSurfaceFound: true,
      workAuthorizationSectionFound: true,
      authorizationQuestionFound: true,
      sponsorshipQuestionFound: true,
      adapterActivated: true,
      // The whole point: no generic activation failure on the real host.
      activationFailureCode: null,
      authorizationInventoryInserted: true,
      sponsorshipInventoryInserted: true
    });
    expect(inventory.trace.activationReason).not.toBe("TIKTOK_ADAPTER_NOT_ACTIVATED");
    expect(inventory.slots.map((slot) => slot.identity)).toEqual([
      TIKTOK_LEGAL_IDENTITIES.authorization,
      TIKTOK_LEGAL_IDENTITIES.sponsorship_now_or_future
    ]);
  });

  it("redacts the application id out of the diagnostic path shape", () => {
    const trace = discoverTikTokApplication(
      "https://lifeattiktok.com/en-US/resume/7412998877665544/apply?token=secret",
      document.querySelector("form")!
    ).trace;
    expect(trace.pathShape).toBe("/<locale>/resume/<id>/apply");
    expect(JSON.stringify(trace)).not.toContain("7412998877665544");
    expect(JSON.stringify(trace)).not.toContain("secret");
  });

  it("reports two required-and-unverified legal controls while both live dropdowns are blank", () => {
    const result = verifyFinalLiveDom({
      root: document.querySelector("form")!,
      session: { ...session, officialUrl: LIVE },
      domGeneration: 1,
      lifecycleIsCurrent: true,
      ledger: [],
      questionEntries: [],
      questionTraces: [],
      repeatableSections: [],
      pageUrl: LIVE
    });

    // The live widget said "required verified: 0 / required remaining: 0 /
    // technical issues: 0" beside two empty dropdowns. Blank required controls
    // are REMAINING, never absent.
    expect(result.requiredVerified).toBe(0);
    expect(result.requiredRemaining).toBe(2);
    expect(result.canEnterReviewReady).toBe(false);
    expect(result.tiktokAdapterTrace).toMatchObject({
      hostAllowed: true,
      adapterActivated: true,
      authorizationInventoryInserted: true,
      sponsorshipInventoryInserted: true,
      finalVerificationUsedAdapter: true
    });
    // Privacy consent stays the user's decision and is counted separately.
    expect(result.manualConsentActions).toBe(1);
  });

  it("keeps both authoritative identities after a generic discovery merge", () => {
    const inventory = discoverTikTokApplication(LIVE, document.querySelector("form")!);
    const generic = discoverFields(document.querySelector("form")!);
    const merged = mergeTikTokLegalFields(generic, inventory);

    for (const identity of Object.values(TIKTOK_LEGAL_IDENTITIES)) {
      expect(merged.filter((field) => field.uid === identity)).toHaveLength(1);
    }
    // No generic placeholder may shadow a legal question.
    const legalLabels = merged.filter((field) =>
      /legally authorized|visa sponsorship/i.test(`${field.label} ${field.ariaLabel}`)
    );
    expect(legalLabels.every((field) => Object.values(TIKTOK_LEGAL_IDENTITIES).includes(field.uid))).toBe(true);
  });

  it("names the missing row instead of silently dropping a visible question", () => {
    document.body.innerHTML = `<form id="application-form">
      <section><h2>Work Authorization</h2>
        <div class="question-row">
          <div class="question">Are you legally authorized to work in the US without restriction?</div>
          <div class="answer-cell"><button id="authorization" type="button" role="combobox" aria-haspopup="listbox">Select</button></div>
        </div>
      </section></form>`;
    installGeometry();

    const inventory = discoverTikTokApplication(LIVE, document.querySelector("form")!);
    expect(inventory.active).toBe(true);
    expect(inventory.slots[0].failureCode).toBeNull();
    expect(inventory.slots[1].failureCode).toBe("TIKTOK_SPONSORSHIP_ROW_NOT_FOUND");
  });
});

describe("TikTok application adapter discovery", () => {
  it("activates on approved TikTok Careers application-route variants", () => {
    expect(matchesTikTokApplicationUrl(URL)).toBe(true);
    expect(matchesTikTokApplicationUrl("https://careers.tiktok.com/position/123/apply")).toBe(true);
    expect(matchesTikTokApplicationUrl("https://careers.tiktok.com/en/position/123/application?source=jobs#authorization")).toBe(true);
    expect(matchesTikTokApplicationUrl("https://careers.tiktok.com/portal/apply/123?locale=en-US")).toBe(true);
    // The URL gate is the exact approved Careers origin. Activation still
    // requires a visible scoped application root + Work Authorization section.
    expect(matchesTikTokApplicationUrl("https://careers.tiktok.com/search")).toBe(true);
    expect(matchesTikTokApplicationUrl("https://careers.tiktok.com.evil.test/position/123/detail")).toBe(false);
    expect(matchesTikTokApplicationUrl("https://example.test/position/123/detail")).toBe(false);
  });

  it("records a visible legal section even when an unapproved origin prevents activation", () => {
    const inventory = discoverTikTokApplication("https://example.test/portal/apply/123", document.querySelector("form")!);
    expect(inventory.active).toBe(false);
    expect(inventory.trace).toMatchObject({
      adapterName: "tiktok_application",
      adapterActivated: false,
      // The generic code told us nothing. The host is the actual cause, and it
      // is now named as one — this is the exact class of failure that hid the
      // missing lifeattiktok.com allowlist entry for so long.
      activationReason: "TIKTOK_HOST_NOT_SUPPORTED",
      activationFailureCode: "TIKTOK_HOST_NOT_SUPPORTED",
      hostAllowed: false,
      hostname: "not-supported",
      workAuthorizationSectionFound: true,
      authorizationQuestionFound: true,
      sponsorshipQuestionFound: true
    });
  });

  it("finds two empty required legal controls with stable distinct identities and leaves privacy separate", () => {
    const inventory = discoverTikTokApplication(URL, document.querySelector("form")!);
    expect(inventory.active).toBe(true);
    expect(inventory.trace).toMatchObject({
      adapterActivated: true,
      urlMatch: true,
      workAuthorizationSectionFound: true,
      authorizationRowFound: true,
      sponsorshipRowFound: true,
      distinctFieldIdentities: true
    });
    expect(inventory.slots.map((slot) => slot.identity)).toEqual([
      TIKTOK_LEGAL_IDENTITIES.authorization,
      TIKTOK_LEGAL_IDENTITIES.sponsorship_now_or_future
    ]);
    expect(inventory.slots.map((slot) => slot.field?.required)).toEqual([true, true]);
    expect(inventory.slots.map((slot) => slot.trigger?.id)).toEqual(["authorization", "sponsorship"]);
    expect(inventory.slots[0].trigger).not.toBe(inventory.slots[1].trigger);
    expect(inventory.slots.some((slot) => slot.trigger === document.querySelector("#privacy"))).toBe(false);
  });

  it("reports the exact technical failure when question rows have no trigger", () => {
    document.body.innerHTML = fixture(false);
    const inventory = discoverTikTokApplication(URL, document.querySelector("form")!);
    expect(inventory.slots.map((slot) => slot.failureCode)).toEqual([
      "TIKTOK_LEGAL_CONTROL_NOT_FOUND",
      "TIKTOK_LEGAL_CONTROL_NOT_FOUND"
    ]);
    expect(inventory.slots.map((slot) => slot.field?.required)).toEqual([true, true]);
  });
});

function installPortal(
  id: string,
  strategy: "click" | "pointer" | "keyboard",
  replaceAfterOpen = false,
  replaceAfterSelection = false,
  revert = false
): void {
  let trigger = document.getElementById(id)!;
  const open = () => {
    if (document.querySelector('[role="listbox"]')) return;
    if (replaceAfterOpen) {
      const replacement = trigger.cloneNode(true) as HTMLElement;
      trigger.replaceWith(replacement);
      trigger = replacement;
    }
    trigger.setAttribute("aria-expanded", "true");
    const menu = document.createElement("div");
    menu.setAttribute("role", "listbox");
    for (const label of ["Yes", "No"]) {
      const option = document.createElement("div");
      option.setAttribute("role", "option");
      option.textContent = label;
      option.addEventListener("click", () => {
        const current = document.getElementById(id)!;
        const hidden = current.parentElement!.querySelector<HTMLInputElement>('input[type="hidden"]')!;
        if (!revert) {
          if (replaceAfterSelection) {
            const replacement = current.cloneNode(false) as HTMLElement;
            replacement.textContent = label;
            current.replaceWith(replacement);
            trigger = replacement;
          } else {
            current.textContent = label;
          }
          hidden.value = label === "Yes" ? "true" : "false";
        }
        menu.remove();
      });
      menu.appendChild(option);
    }
    document.body.appendChild(menu);
  };
  if (strategy === "click") trigger.addEventListener("click", open);
  if (strategy === "pointer") trigger.addEventListener("pointerdown", open);
  if (strategy === "keyboard") trigger.addEventListener("keydown", (event) => {
    if ((event as KeyboardEvent).key === "Enter") open();
  });
}

describe("TikTok legal interaction", () => {
  it.each([
    ["click", "click"],
    ["pointer", "pointer"],
    ["keyboard", "enter"]
  ] as const)("opens with %s and selects the approved authorization Yes", async (strategy, expectedOpen) => {
    installPortal("authorization", strategy);
    const result = await actuateTikTokLegalField(
      URL,
      TIKTOK_LEGAL_IDENTITIES.authorization,
      "Yes",
      true,
      document.querySelector("form")!
    );
    expect(result).toMatchObject({ ok: true, reason: "verified", openStrategy: expectedOpen });
    expect(document.getElementById("authorization")!.textContent).toBe("Yes");
  });

  it("selects sponsorship No and reacquires after open and selection React replacements", async () => {
    installPortal("sponsorship", "click", true, true);
    const result = await actuateTikTokLegalField(
      URL,
      TIKTOK_LEGAL_IDENTITIES.sponsorship_now_or_future,
      "No",
      false,
      document.querySelector("form")!
    );
    expect(result).toMatchObject({ ok: true, displayed: "No", verificationSource: "display+hidden_input" });
    expect(document.getElementById("sponsorship")!.isConnected).toBe(true);
  });

  it("uses the assisted action's user-triggered open and then verifies the approved answer", async () => {
    installPortal("authorization", "click");
    const result = await actuateTikTokLegalField(
      URL,
      TIKTOK_LEGAL_IDENTITIES.authorization,
      "Yes",
      true,
      document.querySelector("form")!,
      true
    );
    expect(result).toMatchObject({ ok: true, openStrategy: "already_open", displayed: "Yes" });
    expect(document.getElementById("authorization")!.style.outline).toContain("3px");
  });

  it("returns LISTBOX_NOT_OPENED when the trigger never exposes a popup", async () => {
    const result = await actuateTikTokLegalField(
      URL,
      TIKTOK_LEGAL_IDENTITIES.authorization,
      "Yes",
      true,
      document.querySelector("form")!
    );
    expect(result.reason).toBe("menu_not_opened");
    expect(tikTokFailureCode(result.reason)).toBe("LISTBOX_NOT_OPENED");
  });

  it("returns OPTION_NOT_FOUND when the popup has no unambiguous Yes/No option", async () => {
    document.getElementById("authorization")!.addEventListener("click", () => {
      const menu = document.createElement("div");
      menu.setAttribute("role", "listbox");
      const option = document.createElement("div");
      option.setAttribute("role", "option");
      option.textContent = "Maybe";
      menu.appendChild(option);
      document.body.appendChild(menu);
    });
    const result = await actuateTikTokLegalField(
      URL,
      TIKTOK_LEGAL_IDENTITIES.authorization,
      "Yes",
      true,
      document.querySelector("form")!
    );
    expect(result.reason).toBe("option_not_found");
    expect(tikTokFailureCode(result.reason)).toBe("OPTION_NOT_FOUND");
  });

  it("returns CONTROL_VALUE_DID_NOT_COMMIT when React reverts the selection", async () => {
    installPortal("authorization", "click", false, false, true);
    const result = await actuateTikTokLegalField(
      URL,
      TIKTOK_LEGAL_IDENTITIES.authorization,
      "Yes",
      true,
      document.querySelector("form")!
    );
    expect(result.reason).toBe("selected_value_not_persisted");
    expect(tikTokFailureCode(result.reason)).toBe("CONTROL_VALUE_DID_NOT_COMMIT");
  });

  it("maps open, option, and commit failures to precise production codes", () => {
    expect(tikTokFailureCode("menu_not_opened")).toBe("LISTBOX_NOT_OPENED");
    expect(tikTokFailureCode("option_not_found")).toBe("OPTION_NOT_FOUND");
    expect(tikTokFailureCode("selected_value_not_persisted")).toBe("CONTROL_VALUE_DID_NOT_COMMIT");
    expect(tikTokFailureCode("control_not_found")).toBe("TIKTOK_LEGAL_CONTROL_NOT_FOUND");
  });
});

function trace(fieldId: string, canonicalKey: string, typedAnswer: boolean, verified: boolean): QuestionExecutionTrace {
  return {
    fieldId, frameId: "top", rawLabel: canonicalKey, accessibleName: canonicalKey,
    sectionHeading: "Work Authorization", fieldType: "combobox", ariaRole: "combobox", options: ["Yes", "No"],
    canonicalKey, resolutionMethod: "registry", resolutionConfidence: 1,
    transform: canonicalKey.includes("sponsorship") ? "boolean_or" : "none",
    requiredCanonicalKeys: [], answerSource: "saved_profile", sourceValues: typedAnswer ? [true] : [false, false],
    typedAnswer, displayAnswer: typedAnswer ? "Yes" : "No", profileRevision: "r1",
    domGeneration: 1, actuator: "tiktok_application", actuatorReached: verified,
    transactionStates: verified ? ["QUEUED_FOR_ACTUATION", "FILLED"] : ["SEMANTICALLY_RESOLVED"],
    attemptedValue: "[redacted]", displayedValueAfterFill: verified ? "[present]" : "[empty]",
    backingValueAfterFill: verified ? "[present]" : "[empty]", verified, failureCode: null
  };
}

function finalResult(traces: QuestionExecutionTrace[] = []) {
  const root = document.querySelector("form")!;
  const inventory = discoverTikTokApplication(URL, root);
  const fields = inventory.slots.flatMap((slot) => slot.field ? [slot.field] : []);
  const ledger = buildLedger(fields, [], (field) => ({
    canonicalKey: inventory.slots.find((slot) => slot.identity === field.uid)?.canonicalKey ?? null,
    sensitive: false,
    reusable: true,
    fillSource: null
  }));
  return verifyFinalLiveDom({
    root, session, domGeneration: 1, lifecycleIsCurrent: true, ledger,
    questionEntries: [], questionTraces: traces, repeatableSections: [], pageUrl: URL
  });
}

describe("TikTok final legal inventory", () => {
  it("counts two blank legal controls and one separate privacy consent", () => {
    const result = finalResult();
    expect(result).toMatchObject({
      requiredLiveControlCount: 2,
      requiredVerified: 0,
      requiredRemaining: 2,
      manualConsentActions: 1,
      canEnterReviewReady: false
    });
    expect(result.ledger.filter((entry) => entry.uid.startsWith("tiktok:")).every((entry) => entry.required)).toBe(true);
    expect(result.ledger.filter((entry) => entry.uid.startsWith("tiktok:")).some((entry) => entry.status === "intentionally_skipped_optional")).toBe(false);
  });

  it("reports 1/1 after authorization only and 2/0 after both verify", () => {
    document.getElementById("authorization")!.textContent = "Yes";
    document.querySelector<HTMLInputElement>('[name="authorization_value"]')!.value = "true";
    const authId = fieldRef(discoverTikTokApplication(URL, document.querySelector("form")!).slots[0].field!);
    const auth = trace(authId, "work_authorization_us", true, true);
    expect(finalResult([auth])).toMatchObject({ requiredVerified: 1, requiredRemaining: 1, canEnterReviewReady: false });

    document.getElementById("sponsorship")!.textContent = "No";
    document.querySelector<HTMLInputElement>('[name="sponsorship_value"]')!.value = "false";
    const sponsorshipId = fieldRef(discoverTikTokApplication(URL, document.querySelector("form")!).slots[1].field!);
    const sponsorship = trace(sponsorshipId, "sponsorship_required_now_or_future", false, true);
    expect(finalResult([auth, sponsorship])).toMatchObject({
      requiredVerified: 2,
      requiredRemaining: 0,
      manualConsentActions: 1,
      technicalIssues: 0,
      canEnterReviewReady: true
    });
  });

  /**
   * The live symptom: work authorization visibly showed "Yes" and the panel
   * still listed it as an unresolved required field with a technical issue.
   *
   * The transaction's own verification had failed (React committed after the
   * settle window), so `trace.verified` stayed false and the final pass — which
   * required it for legal keys — refused the control even though it re-read the
   * live DOM and found exactly the approved answer.
   */
  it("accepts a legal control the live DOM proves we actuated correctly", () => {
    document.getElementById("authorization")!.textContent = "Yes";
    document.querySelector<HTMLInputElement>('[name="authorization_value"]')!.value = "true";
    const authId = fieldRef(discoverTikTokApplication(URL, document.querySelector("form")!).slots[0].field!);
    const pessimistic = trace(authId, "work_authorization_us", true, false);
    // We DID drive the control; only our optimistic read of it came back empty.
    pessimistic.actuatorReached = true;
    pessimistic.failureCode = "CONTROL_VALUE_DID_NOT_COMMIT";

    const result = finalResult([pessimistic]);
    expect(result.requiredVerified).toBe(1);
    const authorization = result.controls.find((control) => control.uid.endsWith(":authorization"))!;
    expect(authorization.verified).toBe(true);
    // A verified control must not also carry a failure code.
    expect(authorization.failureCode).toBeNull();
  });

  it("does not accept a legal control we never actuated", () => {
    document.getElementById("authorization")!.textContent = "Yes";
    document.querySelector<HTMLInputElement>('[name="authorization_value"]')!.value = "true";
    const authId = fieldRef(discoverTikTokApplication(URL, document.querySelector("form")!).slots[0].field!);
    const untouched = trace(authId, "work_authorization_us", true, false);
    untouched.actuatorReached = false;

    const authorization = finalResult([untouched]).controls
      .find((control) => control.uid.endsWith(":authorization"))!;
    expect(authorization.verified).toBe(false);
  });

  it("keeps actuator failures technical and never optional-skipped", () => {
    const inventory = discoverTikTokApplication(URL, document.querySelector("form")!);
    const traces = inventory.slots.map((slot, index) => {
      const item = trace(fieldRef(slot.field!), slot.canonicalKey, index === 0, false);
      item.actuatorReached = true;
      item.transactionStates = ["QUEUED_FOR_ACTUATION", "CONTROL_LOCATED", "OPEN_ATTEMPTED"];
      item.failureCode = index === 0 ? "LISTBOX_NOT_OPENED" : "OPTION_NOT_FOUND";
      return item;
    });
    const result = finalResult(traces);
    expect(result.technicalIssues).toBe(2);
    expect(result.requiredRemaining).toBe(2);
    expect(result.ledger.filter((entry) => entry.uid.startsWith("tiktok:")).map((entry) => entry.status))
      .toEqual(["technical_failure", "technical_failure"]);
    expect(result.ledger.some((entry) => entry.uid.startsWith("tiktok:") && entry.status === "intentionally_skipped_optional")).toBe(false);
  });
});

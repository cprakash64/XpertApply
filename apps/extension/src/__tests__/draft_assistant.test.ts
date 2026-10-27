/**
 * "Suggest answers": which boxes are offered, what is sent, how the response is trusted, and
 * that nothing reaches the employer's page except through an explicit apply.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, draftAnswers } from "../api/client";
import {
  applyBlockedReason,
  buildDraftRequest,
  collectDraftCandidates,
  describeDraftError,
  parseDraftResponse
} from "../content/draftAssistant";
import { MSG, parseRuntimeMessage } from "../messages";
import type { DiscoveredField } from "../types";

function textarea(attrs: Partial<DiscoveredField> & { maxLength?: number } = {}): DiscoveredField {
  const el = document.createElement("textarea");
  if (attrs.maxLength) el.maxLength = attrs.maxLength;
  const { maxLength: _unused, ...rest } = attrs;
  return {
    uid: "u1",
    frameId: "top",
    control: "textarea",
    inputType: "textarea",
    name: "q",
    id: "q",
    autocomplete: "",
    placeholder: "",
    ariaLabel: "",
    label: "Describe a project you are proud of and your contribution",
    labelSource: "label",
    normalizedLabel: "describe a project",
    nearbyText: "",
    sectionHeading: "",
    required: true,
    disabled: false,
    visible: true,
    multiple: false,
    custom: false,
    existingValue: "",
    options: [],
    validationMessage: "",
    step: 0,
    element: el,
    ...rest
  } as DiscoveredField;
}

describe("which boxes are offered", () => {
  it("offers an empty, visible, enabled free-text question", () => {
    const [candidate] = collectDraftCandidates([textarea()]);
    expect(candidate).toMatchObject({ fieldKey: "u1", required: true, maxLength: null });
  });

  it("carries the employer's own character limit", () => {
    expect(collectDraftCandidates([textarea({ maxLength: 500 })])[0].maxLength).toBe(500);
  });

  it("never touches a box that already has text, is hidden, or is disabled", () => {
    expect(collectDraftCandidates([textarea({ existingValue: "my own words" })])).toEqual([]);
    expect(collectDraftCandidates([textarea({ visible: false })])).toEqual([]);
    expect(collectDraftCandidates([textarea({ disabled: true })])).toEqual([]);
  });

  it("ignores non-textarea controls and labels too short to be a question", () => {
    expect(collectDraftCandidates([textarea({ control: "text" })])).toEqual([]);
    expect(collectDraftCandidates([textarea({ label: "Notes" })])).toEqual([]);
  });

  it.each([
    "Are you legally authorized to work in the United States?",
    "Will you now or in the future require visa sponsorship for employment?",
    "What is your gender identity?",
    "Do you have a disability or veteran status you would like to disclose?"
  ])("never sends a sensitive question: %s", (label) => {
    expect(collectDraftCandidates([textarea({ label })])).toEqual([]);
  });

  it("caps the batch at the server's limit and de-duplicates by field", () => {
    const many = Array.from({ length: 12 }, (_, i) => textarea({ uid: `u${i}`, label: `Tell us about experience number ${i} in depth` }));
    expect(collectDraftCandidates([...many, many[0]])).toHaveLength(8);
  });
});

describe("request body", () => {
  it("contains only what the page can see: ids, question text, limits, required", () => {
    const body = buildDraftRequest(collectDraftCandidates([textarea({ maxLength: 800 })]));
    expect(body).toEqual([
      {
        field_identifier: "u1",
        question: "Describe a project you are proud of and your contribution",
        control_type: "textarea",
        max_length: 800,
        required: true
      }
    ]);
    // No profile, resume, job or session data is ever composed client-side.
    expect(JSON.stringify(body)).not.toMatch(/resume|profile|token|email|phone/i);
  });
});

describe("trusting the response", () => {
  const asked = collectDraftCandidates([textarea({ maxLength: 100 })]);
  const draft = (over: Record<string, unknown>) => ({
    drafts: [{ field_identifier: "u1", generation_status: "drafted", proposed_answer: "I built a retrieval service.", missing_information: [], ...over }]
  });

  it("accepts a drafted answer for a question that was asked", () => {
    expect(parseDraftResponse(draft({}), asked)[0]).toMatchObject({ status: "drafted", text: "I built a retrieval service." });
  });

  it("drops results for fields that were never asked", () => {
    expect(parseDraftResponse(draft({ field_identifier: "other" }), asked)).toEqual([]);
  });

  it("drops unknown statuses and malformed shapes", () => {
    expect(parseDraftResponse(draft({ generation_status: "approved" }), asked)).toEqual([]);
    expect(parseDraftResponse({ drafts: "nope" }, asked)).toEqual([]);
    expect(parseDraftResponse(null, asked)).toEqual([]);
    expect(parseDraftResponse({ drafts: [null, 3, "x"] }, asked)).toEqual([]);
  });

  it("never turns a refusal into text, even if the server sent some", () => {
    const [result] = parseDraftResponse(draft({ generation_status: "needs_user_answer", proposed_answer: "Yes, I am authorized." }), asked);
    expect(result).toMatchObject({ status: "needs_user_answer", text: "" });
  });

  it("re-enforces the employer's character limit", () => {
    const [result] = parseDraftResponse(draft({ proposed_answer: "x".repeat(101) }), asked);
    expect(result).toMatchObject({ status: "invalid_response", text: "" });
  });

  it("keeps what the applicant must add when the draft is partial", () => {
    const [result] = parseDraftResponse(draft({ generation_status: "partial", missing_information: ["the evaluation method"] }), asked);
    expect(result.missing).toEqual(["the evaluation method"]);
  });
});

describe("applying", () => {
  it("is blocked when the box has text, so the applicant's words are never overwritten", () => {
    expect(applyBlockedReason("")).toBeNull();
    expect(applyBlockedReason("   ")).toBeNull();
    expect(applyBlockedReason("typed by the applicant")).toMatch(/already has text/);
  });
});

describe("failure wording", () => {
  it("is plain and never echoes server detail", () => {
    expect(describeDraftError("DRAFTING_DISABLED")).toMatch(/aren’t available/);
    expect(describeDraftError("RATE_LIMITED")).toMatch(/wait/);
    expect(describeDraftError("HANDOFF_EXPIRED")).toMatch(/session has ended/);
    expect(describeDraftError("whatever")).toMatch(/write your answers yourself/);
  });
});

describe("transport", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("posts only the questions to the session's own draft endpoint with the session token", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ drafts: [], drafted: 0 }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("chrome", { storage: { local: { get: async () => ({}) } } });
    await draftAnswers("sess-token", 42, [{ field_identifier: "u1", question: "Why us, in detail?" }]);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toMatch(/\/application-sessions\/42\/draft-answers$/);
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer sess-token");
    expect(JSON.parse(String(init.body))).toEqual({ questions: [{ field_identifier: "u1", question: "Why us, in detail?" }] });
  });

  it("surfaces the disabled gate's 503 as an ApiError with that status", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ detail: { code: "answer_drafting_disabled" } }), { status: 503 })));
    vi.stubGlobal("chrome", { storage: { local: { get: async () => ({}) } } });
    await expect(draftAnswers("t", 1, [])).rejects.toMatchObject({ status: 503 } satisfies Partial<ApiError>);
  });
});

describe("runtime message", () => {
  it("is a known runtime message", () => {
    expect(parseRuntimeMessage({ type: MSG.DRAFT_ANSWERS, sessionId: 1, questions: [] })).not.toBeNull();
  });

});

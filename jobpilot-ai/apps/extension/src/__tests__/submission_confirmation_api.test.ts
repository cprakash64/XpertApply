/**
 * The extension's half of the confirm-submission contract.
 *
 * Two properties matter here and are asserted directly:
 *   1. the request body carries EVIDENCE only — never a job id, user id, or
 *      status, so a compromised content script cannot redirect a confirmation;
 *   2. retrying is safe and converges on the same application record.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, confirmSubmission } from "../api/client";
import { MSG, parseRuntimeMessage } from "../messages";

type Captured = { url: string; init: RequestInit | undefined };

function mockFetch(
  responder: (call: Captured, index: number) => Response
): { calls: Captured[] } {
  const calls: Captured[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown, init?: RequestInit) => {
      const call = { url: String(input), init };
      calls.push(call);
      return responder(call, calls.length - 1);
    })
  );
  return { calls };
}

function successBody(overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    application: {
      id: 3,
      job_id: 42,
      status: "applied",
      applied_at: "2026-08-04T10:00:00Z",
      applied_source: "extension_confirmed"
    },
    created: true,
    already_applied: false,
    job_id: 42,
    ...overrides
  };
}

const BODY = {
  evidence_type: "success_page",
  submission_timestamp: "2026-08-04T10:00:00.000Z",
  submission_reference: "ACME-1",
  ats: "greenhouse"
};

afterEach(() => vi.unstubAllGlobals());

describe("confirmSubmission request", () => {
  it("posts to the session-scoped endpoint with the session token", async () => {
    const { calls } = mockFetch(() => new Response(JSON.stringify(successBody()), { status: 200 }));
    await confirmSubmission("sess-tok", 55, BODY);

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain("/application-sessions/55/submission-confirmed");
    expect(calls[0].init?.method).toBe("POST");
    const headers = calls[0].init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer sess-tok");
  });

  it("sends evidence only — never a job, user, or status", async () => {
    const { calls } = mockFetch(() => new Response(JSON.stringify(successBody()), { status: 200 }));
    await confirmSubmission("sess-tok", 55, BODY);

    const sent = JSON.parse(String(calls[0].init?.body));
    expect(sent).toEqual({
      evidence_type: "success_page",
      submission_timestamp: "2026-08-04T10:00:00.000Z",
      submission_reference: "ACME-1",
      ats: "greenhouse",
      confirmation_source: "extension_confirmed"
    });
    // The server derives all of these from the session; the browser is not
    // trusted to assert any of them.
    for (const forbidden of ["job_id", "user_id", "status", "resume_id", "company", "title"]) {
      expect(sent).not.toHaveProperty(forbidden);
    }
  });

  it("reports a repeat as already_applied rather than an error", async () => {
    mockFetch(() =>
      new Response(
        JSON.stringify(successBody({ created: false, already_applied: true })),
        { status: 200 }
      )
    );
    const result = await confirmSubmission("sess-tok", 55, BODY);
    expect(result.already_applied).toBe(true);
    expect(result.created).toBe(false);
  });

  it("sends an identical body on a retry, so the server can dedupe it", async () => {
    const { calls } = mockFetch((_call, index) =>
      index === 0
        ? new Response(JSON.stringify({ detail: "boom" }), { status: 503 })
        : new Response(JSON.stringify(successBody({ already_applied: true })), { status: 200 })
    );

    await expect(confirmSubmission("sess-tok", 55, BODY)).rejects.toBeInstanceOf(ApiError);
    const retry = await confirmSubmission("sess-tok", 55, BODY);

    expect(retry.already_applied).toBe(true);
    expect(JSON.parse(String(calls[0].init?.body))).toEqual(
      JSON.parse(String(calls[1].init?.body))
    );
  });

  it("surfaces a rejected (weak-evidence) confirmation as an ApiError", async () => {
    mockFetch(() => new Response(JSON.stringify({ detail: "insufficient" }), { status: 422 }));
    await expect(confirmSubmission("sess-tok", 55, { ...BODY, evidence_type: "submit_clicked" }))
      .rejects.toMatchObject({ status: 422 });
  });

  it("does not leak the response body into the error", async () => {
    mockFetch(() =>
      new Response(JSON.stringify({ detail: "user@example.com not permitted" }), { status: 403 })
    );
    const error = await confirmSubmission("sess-tok", 55, BODY).catch((err) => err);
    expect(error).toBeInstanceOf(ApiError);
    expect(String(error.message)).not.toContain("user@example.com");
  });
});

describe("submission confirmation messages", () => {
  it("accepts a well-formed confirmation message", () => {
    const parsed = parseRuntimeMessage({
      type: MSG.SUBMISSION_CONFIRMED,
      sessionId: 55,
      evidenceType: "success_page",
      submissionTimestamp: "2026-08-04T10:00:00.000Z",
      submissionReference: null,
      ats: "greenhouse"
    });
    expect(parsed?.type).toBe(MSG.SUBMISSION_CONFIRMED);
  });

  it("accepts the manual-confirmation-required message", () => {
    const parsed = parseRuntimeMessage({
      type: MSG.MANUAL_CONFIRMATION_REQUIRED,
      sessionId: 55,
      reason: "SUBMIT_CLICK_ONLY"
    });
    expect(parsed?.type).toBe(MSG.MANUAL_CONFIRMATION_REQUIRED);
  });

  it("rejects an unknown message type", () => {
    expect(parseRuntimeMessage({ type: "JOBPILOT_MARK_APPLIED", sessionId: 1 })).toBeNull();
  });
});

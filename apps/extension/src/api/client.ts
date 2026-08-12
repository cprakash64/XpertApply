/** Secure API client. Uses a session-scoped token (never the user's main login
 * token) and only ever touches endpoints for the one application session. */

import { getApiBase } from "../config";
import type { AutofillResult } from "../messages";
import type { ApplicationSessionData, SessionAnswer } from "../types";

/** Carries the HTTP status so callers (background.ts) can classify a failure
 * precisely — 401 vs. 404 vs. 410 vs. anything else — instead of guessing
 * from a string. Never carries the response body (may contain PII). */
export class ApiError extends Error {
  status: number;
  constructor(status: number, path: string) {
    super(`API ${status} for ${path}`);
    this.status = status;
  }
}

async function request<T>(path: string, token: string, init: RequestInit = {}): Promise<T> {
  const base = await getApiBase();
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, ...init.headers }
  });
  if (!res.ok) {
    throw new ApiError(res.status, path);
  }
  return (await res.json()) as T;
}

export async function exchangeLaunchToken(
  launchToken: string
): Promise<{ session_token: string; session: RawSession }> {
  const base = await getApiBase();
  const res = await fetch(`${base}/application-sessions/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ launch_token: launchToken })
  });
  if (!res.ok) {
    throw new ApiError(res.status, "/application-sessions/token");
  }
  return (await res.json()) as { session_token: string; session: RawSession };
}

type RawSession = {
  session_id: number;
  authenticated_user_id?: number;
  ats_type: string | null;
  official_application_url: string;
  job?: { title: string | null; company: string | null };
  resume?: { status: string; document_id: number | null; download_url: string | null };
  cover_letter?: { status: string; document_id: number | null; download_url: string | null };
  profile?: Record<string, unknown>;
};

export async function fetchSessionData(token: string, sessionId: number): Promise<ApplicationSessionData> {
  const session = await request<RawSession>(`/application-sessions/${sessionId}`, token);
  const answers = await request<{ answers: SessionAnswer[]; unresolved_questions: { canonical_key: string; reason?: string }[]; profile_revision?: string | null }>(
    `/application-sessions/${sessionId}/answers`,
    token
  );
  return {
    sessionId: session.session_id,
    authenticatedUserId: typeof session.authenticated_user_id === "number"
      ? session.authenticated_user_id
      : null,
    atsType: session.ats_type,
    officialUrl: session.official_application_url,
    jobTitle: session.job?.title ?? null,
    company: session.job?.company ?? null,
    profileData: session.profile ?? {},
    profileRevision: answers.profile_revision ?? null,
    answers: answers.answers,
    unresolvedQuestions: answers.unresolved_questions,
    documents: {
      resume: { status: session.resume?.status ?? "missing", documentId: session.resume?.document_id ?? null, downloadPath: session.resume?.download_url ?? null },
      coverLetter: { status: session.cover_letter?.status ?? "missing", documentId: session.cover_letter?.document_id ?? null, downloadPath: session.cover_letter?.download_url ?? null }
    }
  };
}

export async function postEvent(
  token: string,
  sessionId: number,
  event: { action_type: string; field_key?: string; status?: string; confidence?: number; metadata?: Record<string, unknown> }
): Promise<void> {
  await request(`/application-sessions/${sessionId}/events`, token, {
    method: "POST",
    body: JSON.stringify({ source: "extension", ...event })
  });
}

export async function patchStatus(token: string, sessionId: number, status: string): Promise<void> {
  await request(`/application-sessions/${sessionId}/status`, token, {
    method: "PATCH",
    body: JSON.stringify({ status })
  });
}

/** Record a safe, PII-free autofill result summary for the tracker/debugging. */
export async function reportAutofillResult(
  token: string,
  sessionId: number,
  result: AutofillResult
): Promise<void> {
  await request(`/application-sessions/${sessionId}/autofill-results`, token, {
    method: "POST",
    body: JSON.stringify(result)
  });
}

/** "Save for future applications" — the ONLY answer-vault write the extension
 * can make (it only ever holds a session-scoped token). Always the result of
 * an explicit user confirmation in the review widget. */
export async function saveSessionAnswer(
  token: string,
  sessionId: number,
  canonicalKey: string,
  body: { value: string; display_value?: string; scope?: string; company_key?: string }
): Promise<{ ok: boolean }> {
  return request(`/application-sessions/${sessionId}/answers/${encodeURIComponent(canonicalKey)}`, token, {
    method: "PUT",
    body: JSON.stringify(body)
  });
}

/**
 * Answer one question for THIS application only.
 *
 * The body is a single boolean. Ownership, the user, the job, the source, the
 * scope and the confirmation time are all derived server-side from the session
 * this token is scoped to — there is deliberately no field here in which the
 * browser could assert any of them.
 *
 * The reusable answer vault is untouched: `saveSessionAnswer` above is the only
 * call that writes it, and it is a separate, explicit user decision.
 */
export async function setApplicationOverride(
  token: string,
  sessionId: number,
  canonicalKey: string,
  body: { value: boolean }
): Promise<{ canonical_key: string; scope: string; answered: boolean; source_label: string }> {
  // Rebuilt from the one field that may cross, so a caller cannot widen it.
  return request(
    `/application-sessions/${sessionId}/answers/override/${encodeURIComponent(canonicalKey)}`,
    token,
    { method: "PUT", body: JSON.stringify({ value: body.value }) }
  );
}

/** Which questions the user has already answered for this application.
 * Values are deliberately absent — the employer control shows the answer. */
export async function fetchApplicationOverrides(
  token: string,
  sessionId: number
): Promise<{ overrides: { canonical_key: string; scope: string; source_label: string }[] }> {
  return request(`/application-sessions/${sessionId}/answers/override`, token);
}

export interface StructuredName {
  firstName: string;
  lastName: string;
  middleName?: string;
  preferredFirstName?: string;
  preferredLastName?: string;
}

/** Explicit structured-name confirmation — never inferred.
 *
 * Sends the legacy given_name/family_name keys alongside the new ones so an
 * extension update rolled out ahead of the API still works. */
export async function confirmSessionName(
  token: string,
  sessionId: number,
  name: StructuredName
): Promise<{ ok: boolean }> {
  return request(`/application-sessions/${sessionId}/profile/name`, token, {
    method: "PUT",
    body: JSON.stringify({
      first_name: name.firstName,
      middle_name: name.middleName || null,
      last_name: name.lastName,
      preferred_first_name: name.preferredFirstName || null,
      preferred_last_name: name.preferredLastName || null,
      given_name: name.firstName,
      family_name: name.lastName
    })
  });
}

/** Mark the session complete — only ever on explicit user confirmation. */
export async function completeSession(token: string, sessionId: number): Promise<void> {
  await request(`/application-sessions/${sessionId}/complete`, token, {
    method: "POST",
    body: JSON.stringify({ confirmed: true })
  });
}

export interface ConfirmedApplication {
  id: number;
  job_id: number;
  status: string;
  applied_at: string | null;
  applied_source: string | null;
}

export interface SubmissionConfirmationResult {
  ok: boolean;
  application: ConfirmedApplication;
  created: boolean;
  already_applied: boolean;
  job_id: number;
}

/**
 * Report a CONFIRMED ATS submission. The only automated path to "applied".
 *
 * The body carries evidence and a timestamp — never a job id, a user id, or a
 * status. The server derives all of those from the session this token is scoped
 * to, so this call can only ever affect the one application it belongs to.
 *
 * Safe to retry: the server resolves repeats onto the same application record
 * and reports them as ``already_applied``.
 */
export async function confirmSubmission(
  token: string,
  sessionId: number,
  body: {
    evidence_type: string;
    submission_timestamp: string;
    submission_reference: string | null;
    ats: string | null;
  }
): Promise<SubmissionConfirmationResult> {
  return request(`/application-sessions/${sessionId}/submission-confirmed`, token, {
    method: "POST",
    body: JSON.stringify({ ...body, confirmation_source: "extension_confirmed" })
  });
}

/** Fetch a generated document as a File for upload into the employer form. */
export async function fetchDocumentFile(
  token: string,
  sessionId: number,
  kind: "resume" | "cover-letter",
  filename: string
): Promise<File> {
  const base = await getApiBase();
  const res = await fetch(`${base}/application-sessions/${sessionId}/${kind}?fmt=pdf`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!res.ok) {
    throw new Error(`Document fetch failed (${res.status})`);
  }
  const blob = await res.blob();
  return new File([blob], filename, { type: blob.type || "application/pdf" });
}


// --------------------------------------------------------------------------- //
// Question resolution
// --------------------------------------------------------------------------- //
export interface ResolveQuestionsResponse {
  request_schema_version: number;
  registry_version: string;
  answer_contract_version: number;
  results: {
    field_ref: string;
    status: string;
    canonical_key: string | null;
    answer_type: string | null;
    selected_option_ref: string | null;
    safe_source: string;
    confidence: number;
    sensitivity: string | null;
    reason_code: string;
    resolution_method?: string;
    transform?: string;
    required_canonical_keys?: string[];
    typed_answer: boolean | null;
    display_answer: string | null;
    source_values: (boolean | null)[];
  }[];
}

/** Parse the resolver contract without truthiness coercion.
 *
 * In particular, ``false`` is a confirmed answer. Using ``value || null`` here
 * would recreate the production-only sponsorship failure at the transport
 * boundary.
 */
export function parseResolveQuestionsResponse(value: unknown): ResolveQuestionsResponse {
  if (!value || typeof value !== "object") throw new Error("Invalid resolver response");
  const body = value as Record<string, unknown>;
  if (!Array.isArray(body.results)) throw new Error("Invalid resolver results");
  const results = body.results.map((raw) => {
    if (!raw || typeof raw !== "object") throw new Error("Invalid resolver result");
    const result = raw as Record<string, unknown>;
    return {
      ...result,
      typed_answer: typeof result.typed_answer === "boolean" ? result.typed_answer : null,
      display_answer: typeof result.display_answer === "string" ? result.display_answer : null,
      source_values: Array.isArray(result.source_values)
        ? result.source_values.map((item) => typeof item === "boolean" ? item : null)
        : []
    } as ResolveQuestionsResponse["results"][number];
  });
  return {
    request_schema_version: typeof body.request_schema_version === "number"
      ? body.request_schema_version
      : 2,
    registry_version: typeof body.registry_version === "string" ? body.registry_version : "unknown",
    answer_contract_version: typeof body.answer_contract_version === "number"
      ? body.answer_contract_version
      : 0,
    results
  };
}

/**
 * Ask the backend which of the options this page shows should be selected.
 *
 * The session token is the credential, so ownership and the job are derived
 * server-side; the batch carries only what the page can see. The response
 * names an option reference, never an answer value.
 */
export async function resolveQuestions(
  token: string,
  sessionId: number,
  questions: unknown[]
): Promise<ResolveQuestionsResponse> {
  const response = await request<unknown>(
    `/application-sessions/${sessionId}/resolve-questions`,
    token,
    { method: "POST", body: JSON.stringify({ schema_version: 3, questions }) }
  );
  return parseResolveQuestionsResponse(response);
}

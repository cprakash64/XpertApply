/**
 * Automatic initial fit scoring (finding F2). A fake server reports `scoring` progress with `GET /jobs` and scores a batch per
 * `POST /jobs/scoring/advance`. These tests assert what the PAGE does: it starts scoring by itself, shows real progress, keeps one
 * call in flight, holds "Show more" while scores are partial, reloads ONCE at the end so the ranking is final, never polls
 * forever, and turns failures into a retry instead of an endless "Calculating".
 */
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JobDiscovery } from "../components/JobDiscovery";
import { clearPeopleCache } from "../lib/peopleClient";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const TOTAL = 30;
const BATCH = 10;

type Mode = "normal" | "incomplete" | "failed" | "no-scoring-block" | "advance-error" | "busy-first" | "complete";
let mode: Mode;
let scored: number;
let failedCount: number;
let listCalls: URLSearchParams[];
let advanceCalls: URLSearchParams[];
let inFlight: number;
let maxInFlight: number;
let busyOnce: boolean;
let advanceDelayMs: number;

const scoringBlock = () => {
  if (mode === "incomplete") return { state: "profile_incomplete", total: TOTAL, scored: 0, pending: 0, failed: 0 };
  if (mode === "failed" && scored >= TOTAL - 2) return { state: "failed", total: TOTAL, scored: TOTAL - 2, pending: 0, failed: 2 };
  return scored >= TOTAL
    ? { state: "complete", total: TOTAL, scored: TOTAL, pending: 0, failed: 0 }
    : { state: "scoring", total: TOTAL, scored, pending: TOTAL - scored, failed: 0 };
};

const makeJob = (id: number) => {
  const done = mode === "complete" || scored >= TOTAL || id <= scored;
  const match =
    mode === "incomplete"
      ? { fit_score: null, fit_label: null, score_state: "profile_incomplete", match_reasons: [], missing_skills: [], risk_factors: [] }
      : done
        ? { fit_score: 40 + id, fit_label: "Good fit", score_state: "scored", match_reasons: [], missing_skills: [], risk_factors: [] }
        : null;
  return {
    id, title: `Role ${String(id).padStart(3, "0")}`, company: `Company ${id}`, company_domain: "", company_logo_url: "", source: "greenhouse",
    location: "Remote", workplace_type: "remote", employment_type: "full-time", seniority_level: "mid",
    posted_at: new Date(Date.now() - id * 3_600_000).toISOString(), discovered_at: new Date().toISOString(),
    application_url: `https://boards.greenhouse.io/acme/${id}`, source_url: `https://boards.greenhouse.io/acme/${id}`,
    description_clean: "Build systems.", required_skills: ["Python"], preferred_skills: [], responsibilities: [], match
  };
};

function install() {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.startsWith("/jobs/tracker/")) return json({ applications: [] });
    if (url.pathname === "/jobs/scoring/advance" && init?.method === "POST") {
      advanceCalls.push(url.searchParams);
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, advanceDelayMs));
      inFlight -= 1;
      if (mode === "advance-error") return json({ detail: "boom" }, 500);
      if (mode === "busy-first" && busyOnce) {
        busyOnce = false;
        return json({ scoring: scoringBlock(), advanced: 0, busy: true, retry_after_seconds: 0.01 });
      }
      if (url.searchParams.get("retry_failed") === "true") {
        mode = "normal";
        scored = TOTAL;
        return json({ scoring: scoringBlock(), advanced: 2, busy: false });
      }
      scored = Math.min(TOTAL, scored + BATCH);
      return json({ scoring: scoringBlock(), advanced: BATCH, busy: false });
    }
    if (url.pathname !== "/jobs") return json({});
    listCalls.push(url.searchParams);
    const limit = Number(url.searchParams.get("limit") ?? TOTAL);
    const start = url.searchParams.get("cursor") ? Number(String(url.searchParams.get("cursor")).replace("c:", "")) : 0;
    const ids = Array.from({ length: TOTAL }, (_, i) => i + 1);
    // Partial scores rank everything by recency; once scoring is complete the server ranks by score (here: descending id).
    const ordered = scored >= TOTAL || mode === "complete" ? [...ids].reverse() : ids;
    const slice = ordered.slice(start, start + limit);
    const more = start + limit < ordered.length;
    const body: Record<string, unknown> = {
      profile_complete: mode !== "incomplete", criteria: { role_queries: [], skills: [], seniority_targets: [] },
      profile_filters: { target_roles: [], target_levels: [], preferred_locations: [], work_preference: "remote" },
      jobs: slice.map(makeJob),
      page: { sort: "best_recent", total: TOTAL, limit, returned: slice.length, has_more: more, next_cursor: more ? `c:${start + limit}` : null }
    };
    if (mode !== "no-scoring-block") body.scoring = scoringBlock();
    return json(body);
  });
}

const titles = () => screen.getAllByTestId("job-card").map((card) => within(card).getByRole("button", { name: /Role \d+/ }).textContent);
const cardTexts = () => screen.getAllByTestId("job-card").map((card) => card.textContent ?? "");

beforeEach(() => {
  localStorage.setItem("jobpilot_token", "token");
  window.history.replaceState(null, "", "/jobs");
  clearPeopleCache();
  mode = "normal"; scored = 0; failedCount = 0; busyOnce = true; advanceDelayMs = 5;
  listCalls = []; advanceCalls = []; inFlight = 0; maxInFlight = 0;
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("Jobs page: automatic initial scoring", () => {
  it("starts by itself, shows real progress, then reloads once so the ranking is final", async () => {
    install();
    render(React.createElement(JobDiscovery));
    await screen.findAllByTestId("job-card");
    expect(await screen.findByText(/Scoring your matches/)).toBeInTheDocument();
    await waitFor(() => expect(advanceCalls.length).toBe(TOTAL / BATCH));                       // one batch per call, 3 calls
    await waitFor(() => expect(screen.queryByText(/Scoring your matches/)).not.toBeInTheDocument());
    expect(titles()[0]).toBe("Role 030");                                                         // the final, score-based order
    expect(cardTexts().every((text) => /Good fit/.test(text) && !/Calculating fit/.test(text))).toBe(true);
    const firstPageLoads = listCalls.filter((call) => !call.has("cursor")).length;
    expect(firstPageLoads).toBe(2);                                                               // the initial load and ONE final reload
    expect(maxInFlight).toBe(1);                                                                  // never more than one advance in flight
    expect(advanceCalls.every((call) => call.get("posted_within_days") === "7" && !call.has("retry_failed"))).toBe(true);
  });

  it("shows the true counts while scoring and holds Show more until the scores are final", async () => {
    advanceDelayMs = 400;                                                                         // keep the in-progress state observable under load
    install();
    render(React.createElement(JobDiscovery));
    await screen.findAllByTestId("job-card");
    expect(await screen.findByText(/Scoring your matches… \d+ of 30 jobs scored/)).toBeInTheDocument();
    const paused = screen.getByRole("button", { name: "Waiting for fit scores…" });
    expect(paused).toBeDisabled();
    await waitFor(() => expect(screen.getByRole("button", { name: "Show more jobs" })).toBeEnabled(), { timeout: 5000 });
  });

  it("does nothing when scoring is already complete", async () => {
    mode = "complete"; scored = TOTAL;
    install();
    render(React.createElement(JobDiscovery));
    await screen.findAllByTestId("job-card");
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(advanceCalls).toHaveLength(0);
    expect(screen.queryByText(/Scoring your matches/)).not.toBeInTheDocument();
    expect(listCalls.filter((call) => !call.has("cursor"))).toHaveLength(1);
  });

  it("an incomplete profile gets an honest state: no scoring calls, no polling, no number", async () => {
    mode = "incomplete";
    install();
    render(React.createElement(JobDiscovery));
    await screen.findAllByTestId("job-card");
    vi.useFakeTimers({ toFake: ["setTimeout"], shouldAdvanceTime: true });
    await act(async () => { await vi.advanceTimersByTimeAsync(9000); });                        // two polling periods of the old behaviour
    vi.useRealTimers();
    expect(advanceCalls).toHaveLength(0);
    expect(listCalls.filter((call) => !call.has("cursor"))).toHaveLength(1);                     // not re-read forever
    expect(screen.queryByText(/Scoring your matches/)).not.toBeInTheDocument();
    expect(cardTexts().some((text) => /Calculating fit/.test(text))).toBe(false);
    expect(cardTexts().every((text) => /No fit score/.test(text))).toBe(true);
    expect(screen.queryAllByText(/\/ 100/)).toHaveLength(0);                                      // no fabricated score
  });

  it("a failure is a recoverable state with a retry that asks the server to retry failed pairs", async () => {
    mode = "failed";
    vi.useFakeTimers({ toFake: ["setTimeout"], shouldAdvanceTime: true });
    install();
    render(React.createElement(JobDiscovery));
    const alert = await screen.findByRole("alert", {}, { timeout: 3000 });
    expect(alert).toHaveTextContent("We couldn’t score 2 jobs.");
    const callsBefore = advanceCalls.length;
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(advanceCalls.length).toBe(callsBefore);                                                // stops, no endless retrying
    const listsBefore = listCalls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(9000); });                        // two periods of the old 4 s poll
    expect(listCalls.length).toBe(listsBefore);                                                   // the unscored cards are not re-read forever
    vi.useRealTimers();
    await userEvent.click(within(alert).getByRole("button", { name: "Retry scoring" }));
    await waitFor(() => expect(advanceCalls.at(-1)!.get("retry_failed")).toBe("true"));
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
    await waitFor(() => expect(cardTexts().every((text) => /Good fit/.test(text))).toBe(true));
  });

  it("a failed request to advance shows a retry, never an endless Calculating", async () => {
    mode = "advance-error";
    install();
    render(React.createElement(JobDiscovery));
    expect(await screen.findByText("We couldn’t finish scoring your matches.", {}, { timeout: 3000 })).toBeInTheDocument();
    expect(advanceCalls).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Retry scoring" })).toBeInTheDocument();
  });

  it("waits when the server says it is busy instead of hammering it, then continues", async () => {
    mode = "busy-first";
    install();
    render(React.createElement(JobDiscovery));
    await screen.findAllByTestId("job-card");
    await waitFor(() => expect(screen.queryByText(/Scoring your matches/)).not.toBeInTheDocument(), { timeout: 4000 });
    expect(advanceCalls.length).toBe(1 + TOTAL / BATCH);                                          // one refused call, then the 3 real ones
    expect(maxInFlight).toBe(1);
  });

  it("changing the window restarts scoring for the NEW window only", async () => {
    install();
    render(React.createElement(JobDiscovery));
    await screen.findAllByTestId("job-card");
    await userEvent.selectOptions(screen.getByLabelText("Posted within days"), "14");
    await waitFor(() => expect(advanceCalls.some((call) => call.get("posted_within_days") === "14")).toBe(true));
    expect(maxInFlight).toBeLessThanOrEqual(2);                                                   // a superseded call may finish; never a burst
  });

  it("while scoring is running the page does not also poll the list in the background", async () => {
    advanceDelayMs = 20000;                                                                       // a slow advance call, held open
    vi.useFakeTimers({ toFake: ["setTimeout"], shouldAdvanceTime: true });                          // before render: the page's timers must be fake too
    install();
    render(React.createElement(JobDiscovery));
    await screen.findAllByTestId("job-card");
    expect(await screen.findByText(/Scoring your matches/)).toBeInTheDocument();
    const lists = listCalls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(9000); });                        // two periods of the old 4 s poll
    expect(listCalls.length).toBe(lists);
    expect(advanceCalls).toHaveLength(1);                                                         // and still exactly one call in flight
    await act(async () => { await vi.advanceTimersByTimeAsync(20000); });
    vi.useRealTimers();
  });

  it("an older API without the scoring block keeps the previous behaviour and is never asked to advance", async () => {
    mode = "no-scoring-block";
    install();
    render(React.createElement(JobDiscovery));
    await screen.findAllByTestId("job-card");
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(advanceCalls).toHaveLength(0);
    expect(screen.queryByText(/Scoring your matches/)).not.toBeInTheDocument();
  });
});

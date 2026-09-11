import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TrackerClient } from "../components/TrackerClient";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const job = {
  id: 101, title: "Current mutable title", company: "Current Company", company_domain: null,
  company_logo_url: null, company_logo_proxy_path: null, location: "Remote", workplace_type: "remote",
  employment_type: "Full-time", posted_at: "2026-06-01T00:00:00Z",
  application_url: "https://current.example/job", match: { fit_score: 80 }
};

const tracker = {
  id: 11, job_id: 101, status: "applied", applied_at: "2026-07-20T12:00:00Z",
  snapshot_available: true, snapshot_count: 1,
  documents: { resume: { id: 999, title: "current-resume.docx", created_at: null }, cover_letter: null },
  job
};

function snapshot(overrides: Record<string, unknown> = {}) {
  return {
    id: 501, application_tracker_id: 11, attempt_number: 1,
    confirmation_source: "user_confirmed", submission_evidence_type: "manual",
    job_title: "Historical Engineer", company_name: "Historical Co",
    job_url: "https://historical.example/job", source_url: null,
    job_description_snapshot: "Historical description\nSecond paragraph",
    resume: { document_id: 77, filename: "submitted-resume.pdf", content_hash: "resume-hash" },
    resume_used: true, resume_provenance: "upload_verified",
    cover_letter_used: true, cover_letter_mode: "file",
    cover_letter: { document_id: 78, filename: "submitted-letter.docx", content_hash: "letter-hash" },
    cover_letter_text_snapshot: null, answers: [], applied_at: "2026-07-20T12:00:00Z",
    created_at: "2026-07-20T12:01:00Z", ...overrides
  };
}

function mockTracker(applications: unknown[], snapshots: unknown[] | (() => Promise<Response>) = [snapshot()], cancelFails = false) {
  vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
    const url = String(input);
    if (url.endsWith("/jobs/tracker/submitted")) return Promise.resolve(json({ applications }));
    if (url.endsWith("/jobs/tracker/11/snapshots")) {
      return typeof snapshots === "function" ? snapshots() : Promise.resolve(json({ snapshots }));
    }
    if (url.endsWith("/jobs/tracker/11/cancel-deletion") && init?.method === "POST") {
      if (cancelFails) return Promise.resolve(json({ detail: "Cancellation unavailable" }, 503));
      return Promise.resolve(json({ tracker: { id: 11, status: "rejected", deletion_scheduled_at: null, deletion_cancelled_at: "2026-09-10T12:00:00Z" } }));
    }
    if (url.endsWith("/jobs/101/tracker") && init?.method === "PUT") {
      return Promise.resolve(json({ tracker: { id: 11, status: "rejected", deletion_scheduled_at: "2026-09-17T12:00:00Z" } }));
    }
    if (url.includes("/jobs/documents/")) return Promise.resolve(json({ detail: "Not found" }, 404));
    return Promise.resolve(json({}));
  });
}

describe("Tracker application memory", () => {
  beforeEach(() => localStorage.setItem("jobpilot_token", "token"));
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it("loads the exact historical record only after opening and closes accessibly", async () => {
    mockTracker([tracker]);
    render(<TrackerClient />);
    const open = await screen.findByRole("button", { name: "Application details" });
    expect(fetch).not.toHaveBeenCalledWith(expect.stringContaining("/snapshots"), expect.anything());
    await userEvent.click(open);
    const dialog = await screen.findByRole("dialog", { name: "Application details" });
    expect(within(dialog).getByText("Historical Engineer")).toBeInTheDocument();
    expect(within(dialog).getByText("Historical Co")).toBeInTheDocument();
    expect(within(dialog).getByText("submitted-resume.pdf")).toBeInTheDocument();
    expect(within(dialog).getByText("submitted-letter.docx")).toBeInTheDocument();
    expect(within(dialog).getByRole("heading", { name: "Resume used" })).toBeInTheDocument();
    expect(within(dialog).queryByText("current-resume.docx")).not.toBeInTheDocument();
    expect(within(dialog).getByRole("link", { name: /Historical job link/ })).toHaveAttribute("href", "https://historical.example/job");
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(open).toHaveFocus();
  });

  it("selects the latest attempt and switches exact artifacts", async () => {
    mockTracker([{ ...tracker, snapshot_count: 2 }], [
      snapshot(),
      snapshot({ id: 502, attempt_number: 2, job_title: "Historical Staff Engineer", job_description_snapshot: "Attempt two description", resume: { document_id: 88, filename: "attempt-two.pdf", content_hash: "two" }, cover_letter_used: false, cover_letter_mode: "unused", cover_letter: { document_id: null, filename: null, content_hash: null } })
    ]);
    render(<TrackerClient />);
    await userEvent.click(await screen.findByRole("button", { name: "Application details" }));
    expect(await screen.findByText("attempt-two.pdf")).toBeInTheDocument();
    expect(screen.getByText("No cover letter used")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /View job description/ }));
    expect(screen.getByText("Attempt two description")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /Attempt 1/ }));
    expect(screen.getByText("submitted-resume.pdf")).toBeInTheDocument();
    expect(screen.queryByText("attempt-two.pdf")).not.toBeInTheDocument();
    expect(screen.queryByText("Attempt two description")).not.toBeInTheDocument();
    expect(screen.getByText("submitted-letter.docx")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /View job description/ }));
    expect(screen.getByText(/Historical description/)).toBeInTheDocument();
  });

  it("distinguishes selected-only resume and pasted cover-letter text", async () => {
    mockTracker([tracker], [snapshot({ resume_used: false, resume_provenance: "selected_for_session", cover_letter_mode: "pasted_text", cover_letter: { document_id: null, filename: null, content_hash: null }, cover_letter_text_snapshot: "Dear team,\nExact preserved text." })]);
    render(<TrackerClient />);
    await userEvent.click(await screen.findByRole("button", { name: "Application details" }));
    expect(await screen.findByRole("heading", { name: "Resume selected for this application" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Resume used" })).not.toBeInTheDocument();
    expect(screen.getByText(/Exact preserved text/)).toBeInTheDocument();
  });

  it("does not invent a resume and maps assisted confirmation to user-facing copy", async () => {
    mockTracker([tracker], [snapshot({ confirmation_source: "auto_apply_confirmed", resume: { document_id: null, filename: null, content_hash: null }, resume_used: false, resume_provenance: null, job_url: "data:text/html,unsafe", source_url: null })]);
    render(<TrackerClient />);
    await userEvent.click(await screen.findByRole("button", { name: "Application details" }));
    expect(await screen.findByText("No resume recorded for this attempt")).toBeInTheDocument();
    expect(screen.getByText("Submission confirmed automatically")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Historical job link/ })).not.toBeInTheDocument();
  });

  it("reports a missing historical artifact without falling back", async () => {
    mockTracker([tracker]);
    render(<TrackerClient />);
    await userEvent.click(await screen.findByRole("button", { name: "Application details" }));
    await userEvent.click(await screen.findByRole("button", { name: "View resume" }));
    expect(await screen.findByText("This historical resume is currently unavailable.")).toBeInTheDocument();
    expect(screen.queryByText("current-resume.docx")).not.toBeInTheDocument();
    expect(screen.getByText("Current mutable title")).toBeInTheDocument();
  });

  it("renders employer text inert and does not activate unsafe URLs", async () => {
    const malicious = "<script>alert(1)</script> Ω";
    mockTracker([tracker], [snapshot({ job_title: malicious, job_url: "javascript:alert(1)", source_url: "not-a-url", job_description_snapshot: `<img src=x onerror=alert(1)> ${"long ".repeat(200)}`, cover_letter_mode: "pasted_text", cover_letter_text_snapshot: malicious })]);
    render(<TrackerClient />);
    await userEvent.click(await screen.findByRole("button", { name: "Application details" }));
    expect((await screen.findAllByText(malicious)).length).toBeGreaterThan(0);
    expect(document.querySelector("script")).toBeNull();
    expect(screen.queryByRole("link", { name: /Historical job link/ })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /View job description/ }));
    expect(screen.getByText(/<img src=x onerror=alert\(1\)>/)).toBeInTheDocument();
  });

  it("keeps legacy rows compact without fabricating details", async () => {
    mockTracker([{ ...tracker, snapshot_available: false, snapshot_count: 0 }]);
    render(<TrackerClient />);
    await screen.findByText("Current mutable title");
    expect(screen.queryByRole("button", { name: "Application details" })).not.toBeInTheDocument();
  });

  it("shows and cancels a backend-scheduled deletion without changing rejected status", async () => {
    mockTracker([{ ...tracker, status: "rejected", deletion_scheduled_at: "2099-09-17T12:00:00Z" }]);
    render(<TrackerClient />);
    expect(await screen.findByText(/Scheduled for deletion/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Undo deletion" }));
    await waitFor(() => expect(screen.queryByText(/Scheduled for deletion/)).not.toBeInTheDocument());
    expect(screen.getByLabelText("Update status for Current mutable title")).toHaveValue("rejected");
  });

  it("preserves the warning and rejected status when Undo fails", async () => {
    mockTracker([{ ...tracker, status: "rejected", deletion_scheduled_at: "2099-09-17T12:00:00Z" }], [snapshot()], true);
    render(<TrackerClient />);
    await userEvent.click(await screen.findByRole("button", { name: "Undo deletion" }));
    expect(await screen.findByText("Cancellation unavailable")).toBeInTheDocument();
    expect(screen.getByText(/Scheduled for deletion/)).toBeInTheDocument();
    expect(screen.getByLabelText("Update status for Current mutable title")).toHaveValue("rejected");
  });

  it("renders a terminal deadline only from the mutation response", async () => {
    mockTracker([tracker]);
    render(<TrackerClient />);
    expect(await screen.findByText("Current mutable title")).toBeInTheDocument();
    expect(screen.queryByText(/Scheduled for deletion/)).not.toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText("Update status for Current mutable title"), "rejected");
    expect(await screen.findByText(/Scheduled for deletion/)).toBeInTheDocument();
  });

  it("contains snapshot failures, supports retry, and keeps Tracker usable", async () => {
    let attempts = 0;
    mockTracker([tracker], () => Promise.resolve(attempts++ === 0 ? json({ detail: "Temporary failure" }, 503) : json({ snapshots: [snapshot()] })));
    render(<TrackerClient />);
    await userEvent.click(await screen.findByRole("button", { name: "Application details" }));
    expect(await screen.findByText("Temporary failure")).toBeInTheDocument();
    expect(screen.getByText("Current mutable title")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("submitted-resume.pdf")).toBeInTheDocument();
  });

  it("caches successful details by tracker and does not accumulate repeat-open requests", async () => {
    mockTracker([tracker]);
    render(<TrackerClient />);
    const open = await screen.findByRole("button", { name: "Application details" });
    await userEvent.click(open);
    await screen.findByText("submitted-resume.pdf");
    await userEvent.click(screen.getByRole("button", { name: "Close application details" }));
    await userEvent.click(open);
    await screen.findByText("submitted-resume.pdf");
    const snapshotCalls = vi.mocked(fetch).mock.calls.filter(([input]) => String(input).endsWith("/jobs/tracker/11/snapshots"));
    expect(snapshotCalls).toHaveLength(1);
  });

  it("ignores a slow response after the dialog is closed", async () => {
    let resolveRequest!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => { resolveRequest = resolve; });
    mockTracker([tracker], () => pending);
    render(<TrackerClient />);
    await userEvent.click(await screen.findByRole("button", { name: "Application details" }));
    expect(await screen.findByText("Loading application details…")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Close application details" }));
    resolveRequest(json({ snapshots: [snapshot({ job_title: "Late stale response" })] }));
    await Promise.resolve();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByText("Late stale response")).not.toBeInTheDocument();
  });

  it("cannot let a late Tracker A response overwrite open Tracker B details", async () => {
    let resolveA!: (response: Response) => void;
    const pendingA = new Promise<Response>((resolve) => { resolveA = resolve; });
    const trackerB = { ...tracker, id: 12, job_id: 102, job: { ...job, id: 102, title: "Current B" } };
    vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      const url = String(input);
      if (url.endsWith("/jobs/tracker/submitted")) return Promise.resolve(json({ applications: [tracker, trackerB] }));
      if (url.endsWith("/jobs/tracker/11/snapshots")) return pendingA;
      if (url.endsWith("/jobs/tracker/12/snapshots")) return Promise.resolve(json({ snapshots: [snapshot({ id: 601, application_tracker_id: 12, job_title: "Snapshot B", resume: { document_id: 92, filename: "resume-b.pdf", content_hash: "b" } })] }));
      return Promise.resolve(json({}));
    });
    render(<TrackerClient />);
    const buttons = await screen.findAllByRole("button", { name: "Application details" });
    await userEvent.click(buttons[0]);
    await screen.findByText("Loading application details…");
    await userEvent.click(screen.getByRole("button", { name: "Close application details" }));
    await userEvent.click(buttons[1]);
    expect(await screen.findByText("Snapshot B")).toBeInTheDocument();
    resolveA(json({ snapshots: [snapshot({ job_title: "Late Snapshot A" })] }));
    await waitFor(() => expect(screen.queryByText("Late Snapshot A")).not.toBeInTheDocument());
    expect(screen.getByText("Snapshot B")).toBeInTheDocument();
    expect(screen.getByText("resume-b.pdf")).toBeInTheDocument();
  });
});

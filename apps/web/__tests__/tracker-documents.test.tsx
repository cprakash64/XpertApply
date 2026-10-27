import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TrackerClient } from "../components/TrackerClient";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const job = (id: number, company: string, title: string) => ({
  id, title, company, company_domain: null, company_logo_url: null, company_logo_proxy_path: null, location: "Remote",
  workplace_type: "remote", employment_type: "Full-time", posted_at: "2026-07-18T12:00:00Z", application_url: `https://x.test/${id}`, match: { fit_score: 80 }
});
const doc = (extra: Record<string, unknown> = {}) => ({
  id: 1, title: "t", created_at: "2026-07-20T12:00:00Z", prepared_for_application: true, attached_by_extension: false, frozen: true,
  formats: ["pdf", "docx"], download_path: "/jobs/tracker/11/documents/resume", ...extra
});
const app = (id: number, documents: unknown, company = "Plaid") => ({
  id, job_id: 100 + id, status: "applied", applied_at: "2026-07-20T12:00:00Z", created_at: "2026-07-20T12:00:00Z", updated_at: "2026-07-20T12:00:00Z",
  documents, job: job(100 + id, company, `Engineer ${id}`)
});

let applications: unknown[];
let downloads: Array<{ url: string; accept: string | null }>;
let downloadResponse: () => Response;
let anchorClicks: Array<{ download: string; href: string }>;

beforeEach(() => {
  localStorage.setItem("jobpilot_token", "token");
  downloads = [];
  anchorClicks = [];
  downloadResponse = () => new Response(new Blob(["%PDF-1.4 test"]), { status: 200, headers: { "Content-Type": "application/pdf", "Content-Disposition": 'attachment; filename="Plaid_Resume_2026-07-20.pdf"' } });
  vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
    const url = String(input);
    if (url.includes("/documents/")) {
      downloads.push({ url, accept: new Headers(init?.headers).get("Accept") });
      return Promise.resolve(downloadResponse());
    }
    if (url.endsWith("/jobs/tracker/submitted")) return Promise.resolve(json({ applications }));
    return Promise.resolve(json({}));
  });
  Object.assign(URL, { createObjectURL: vi.fn(() => "blob:test"), revokeObjectURL: vi.fn() });
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
    anchorClicks.push({ download: this.download, href: this.href });
  });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("Tracker document downloads", () => {
  it("offers Download resume and Download cover letter for an application that has both, and downloads the stored file", async () => {
    applications = [app(11, { resume: doc(), cover_letter: doc({ download_path: "/jobs/tracker/11/documents/cover-letter" }) })];
    render(React.createElement(TrackerClient));
    const resume = await screen.findByRole("button", { name: /Download resume for Engineer 11 at Plaid/i });
    expect(screen.getByRole("button", { name: /Download cover letter for Engineer 11 at Plaid/i })).toBeInTheDocument();
    await userEvent.click(resume);
    await waitFor(() => expect(anchorClicks).toHaveLength(1));
    expect(downloads[0].url).toBe("http://localhost:8000/jobs/tracker/11/documents/resume?fmt=pdf");
    expect(anchorClicks[0].download).toBe("Plaid_Resume_2026-07-20.pdf");       // the server's filename, not a guess
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
  });

  it("downloads the cover letter, and a Word copy, from the right URLs", async () => {
    applications = [app(11, { resume: doc(), cover_letter: doc() })];
    render(React.createElement(TrackerClient));
    await userEvent.click(await screen.findByRole("button", { name: /Download cover letter for/i }));
    await waitFor(() => expect(downloads).toHaveLength(1));
    expect(downloads[0].url).toContain("/jobs/tracker/11/documents/cover-letter?fmt=pdf");
    await userEvent.click(screen.getByRole("button", { name: /Download resume as Word document/i }));
    await waitFor(() => expect(downloads).toHaveLength(2));
    expect(downloads[1].url).toContain("/jobs/tracker/11/documents/resume?fmt=docx");
  });

  it("with one document, offers that one and says Not available for the other", async () => {
    applications = [app(11, { resume: doc(), cover_letter: null })];
    render(React.createElement(TrackerClient));
    await screen.findByRole("button", { name: /Download resume for/i });
    expect(screen.queryByRole("button", { name: /Download cover letter for/i })).not.toBeInTheDocument();
    const group = screen.getByLabelText(/Documents for Engineer 11/i);
    expect(within(group).getByText(/cover letter/i, { selector: "span" }).parentElement).toHaveTextContent("cover letter: Not available");
  });

  it("older records with no document references, or no documents field at all, still render and offer nothing", async () => {
    applications = [app(11, { resume: null, cover_letter: null }), { ...app(12, undefined), documents: undefined }];
    render(React.createElement(TrackerClient));
    expect(await screen.findByText("Engineer 11")).toBeInTheDocument();
    expect(screen.getByText("Engineer 12")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Download/i })).not.toBeInTheDocument();
    expect(screen.getAllByText(/Not available/i).length).toBe(4);
  });

  it.each([
    ["unknown_association", /can.t tell which saved documents were used/i],
    ["no_session", /recorded without an XpertApply session/i],
    ["documents_not_prepared", /didn.t prepare a resume or cover letter/i],
    ["job_documents_not_linked", /nothing links them to this application/i]
  ])("explains why nothing is available (%s) instead of offering a guess", async (reason, wording) => {
    applications = [{ ...app(11, { resume: null, cover_letter: null }), documents_availability: "none", documents_unavailable_reason: reason }];
    render(React.createElement(TrackerClient));
    await screen.findByText("Engineer 11");
    expect(screen.queryByRole("button", { name: /^Download/i })).not.toBeInTheDocument();
    expect(screen.getAllByText(wording).length).toBe(2);
  });

  it("gives no reason when the server recorded none", async () => {
    applications = [app(11, { resume: null, cover_letter: null })];
    render(React.createElement(TrackerClient));
    await screen.findByText("Engineer 11");
    expect(screen.getAllByText(/Not available/i).length).toBe(2);
    expect(screen.queryByText(/XpertApply session|didn.t prepare|can.t tell|nothing links/i)).not.toBeInTheDocument();
  });

  it("keeps applications of the same company apart", async () => {
    applications = [app(11, { resume: doc({ download_path: "/jobs/tracker/11/documents/resume" }), cover_letter: null }), app(12, { resume: doc(), cover_letter: null })];
    render(React.createElement(TrackerClient));
    await userEvent.click(await screen.findByRole("button", { name: /Download resume for Engineer 12 at Plaid/i }));
    await waitFor(() => expect(downloads).toHaveLength(1));
    expect(downloads[0].url).toContain("/jobs/tracker/12/documents/resume");
  });

  it("shows a loading state and blocks a second click while one download runs", async () => {
    applications = [app(11, { resume: doc(), cover_letter: doc() })];
    let release: (r: Response) => void = () => undefined;
    downloadResponse = () => { throw new Error("replaced below"); };
    vi.mocked(fetch).mockImplementation((input) => {
      const url = String(input);
      if (url.includes("/documents/")) { downloads.push({ url, accept: null }); return new Promise<Response>((resolve) => { release = resolve; }); }
      return Promise.resolve(json({ applications }));
    });
    render(React.createElement(TrackerClient));
    await userEvent.click(await screen.findByRole("button", { name: /Download resume for/i }));
    const busy = await screen.findByRole("button", { name: /Download resume for/i });
    expect(busy).toHaveTextContent("Preparing…");
    expect(busy).toBeDisabled();
    expect(screen.getByRole("button", { name: /Download cover letter for/i })).toBeDisabled();
    release(new Response(new Blob(["x"]), { status: 200 }));
    await waitFor(() => expect(screen.getByRole("button", { name: /Download resume for/i })).toHaveTextContent("Download resume"));
    expect(downloads).toHaveLength(1);
  });

  it.each([
    [404, /no longer available/i],
    [409, /can.t be opened/i],
    [401, /session expired/i],
    [500, /couldn.t download/i]
  ])("a %s answer is shown as a readable, per-document error and nothing is saved", async (status, message) => {
    applications = [app(11, { resume: doc(), cover_letter: doc() })];
    downloadResponse = () => json({ detail: "internal path /srv/generated/document-7.pdf" }, status);
    render(React.createElement(TrackerClient));
    await userEvent.click(await screen.findByRole("button", { name: /Download resume for/i }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(message);
    expect(alert.textContent).not.toMatch(/srv|generated|document-7|path/i);          // server detail never reaches the user
    expect(anchorClicks).toHaveLength(0);
    expect(screen.getByRole("button", { name: /Download resume for/i })).toBeEnabled();     // can retry
  });

  it("a network failure is a retryable error", async () => {
    applications = [app(11, { resume: doc(), cover_letter: null })];
    vi.mocked(fetch).mockImplementation((input) => {
      if (String(input).includes("/documents/")) return Promise.reject(new TypeError("Failed to fetch"));
      return Promise.resolve(json({ applications }));
    });
    render(React.createElement(TrackerClient));
    await userEvent.click(await screen.findByRole("button", { name: /Download resume for/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/check your connection/i);
  });

  it("says 'prepared', and never 'uploaded', unless the extension reported attaching the file", async () => {
    applications = [app(11, { resume: doc({ attached_by_extension: true }), cover_letter: doc({ attached_by_extension: false }) })];
    render(React.createElement(TrackerClient));
    await screen.findByRole("button", { name: /Download resume for/i });
    const group = screen.getByLabelText(/Documents for Engineer 11/i);
    const text = group.textContent ?? "";
    expect(text).toMatch(/Saved document prepared for this application/);
    expect(text).toMatch(/Re-created from the saved text/);          // never "the exact file you attached"
    expect(text).not.toMatch(/exact file|identical|same file/i);
    expect(text).toMatch(/reported attaching it on the employer.s form \(not confirmed by the employer\)/);
    expect(text).toMatch(/Not confirmed as uploaded to the employer/);
    expect(text).not.toMatch(/submitted to the employer|sent to the employer|uploaded to the employer\./i);
  });

  it("labels an older, unfrozen copy as the current saved copy", async () => {
    applications = [app(11, { resume: doc({ frozen: false }), cover_letter: null })];
    render(React.createElement(TrackerClient));
    await screen.findByRole("button", { name: /Download resume for/i });
    expect(screen.getByLabelText(/Documents for Engineer 11/i)).toHaveTextContent("current saved copy; may have changed since");
  });

  it("works on a phone: tap targets are at least 40px and the two documents stack", async () => {
    applications = [app(11, { resume: doc(), cover_letter: doc() })];
    render(React.createElement(TrackerClient));
    const button = await screen.findByRole("button", { name: /Download resume for/i });
    expect(button.className).toMatch(/min-h-10/);
    expect(screen.getByLabelText(/Documents for Engineer 11/i).className).toMatch(/grid-cols-2/);
    expect(screen.getByLabelText(/Documents for Engineer 11/i).className).toMatch(/sm:grid-cols-2/);     // one column below sm
  });

  it("changing the status still works with documents present", async () => {
    applications = [app(11, { resume: doc(), cover_letter: null })];
    render(React.createElement(TrackerClient));
    await userEvent.selectOptions(await screen.findByLabelText("Update status for Engineer 11"), "interview");
    await waitFor(() => expect(fetch).toHaveBeenCalledWith("http://localhost:8000/jobs/111/tracker", expect.objectContaining({ method: "PUT" })));
  });
});

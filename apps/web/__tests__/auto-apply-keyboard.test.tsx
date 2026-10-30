/**
 * Keyboard behaviour of the Apply dialog (finding F4): it declared `role="dialog" aria-modal="true"` but ignored Escape, did not
 * move or trap focus, and did not restore it. It now uses the shared `useDialogFocus` hook. Escape must behave exactly like the
 * Close button: no application submitted, no status change, no employer-site navigation, no extra write.
 */
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React, { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/autoApply", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/autoApply")>();
  return {
    ...actual,
    detectExtension: vi.fn().mockResolvedValue(false),
    detectExtensionState: vi.fn().mockResolvedValue({ present: false }),
    stageLaunch: vi.fn(),
    startAssistedApply: vi.fn().mockResolvedValue({ ok: true, applicationId: "55", tabId: 99 }),
    openOfficialSite: vi.fn().mockReturnValue({} as Window)
  };
});

import { AutoApplyModal } from "../components/AutoApplyModal";
import * as autoApply from "@/lib/autoApply";

const SESSION = {
  session_id: 55, status: "ready", official_application_url: "https://boards.greenhouse.io/acme/1", ats_type: "greenhouse",
  job: { id: 1, title: "Backend Engineer", company: "Acme", location: "Remote" },
  resume: { status: "ready", document_id: 7, download_url: "/application-sessions/55/resume" },
  cover_letter: { status: "ready", document_id: 8, download_url: "/application-sessions/55/cover-letter" },
  answers_available: 6, review_required_count: 2, unresolved_questions: [], warnings: [], extension_launch_token: "launch-token-abc"
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

type Call = { url: string; method: string };
let calls: Call[];
let holdSession: Promise<void> | null;

function mockFetch() {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({ url, method });
    if (url.endsWith("/application-sessions") && method === "POST") {
      if (holdSession) await holdSession;
      return json(SESSION, 201);
    }
    return json({});
  });
}
const writes = () => calls.filter((c) => c.method !== "GET");
const sessionCreations = () => calls.filter((c) => c.url.endsWith("/application-sessions") && c.method === "POST").length;

/** A page with an underlying control, an Apply button, and the dialog it opens. */
function Page({ onClosed, onMarkApplied = () => undefined }: { onClosed?: (generation: number) => void; onMarkApplied?: () => void }) {
  const [open, setOpen] = useState(false);
  const [generation, setGeneration] = useState(0);
  return (
    <>
      <button type="button">Underlying action</button>
      <button type="button" onClick={() => setGeneration((g) => g + 1)}>Re-render page</button>
      <button type="button" onClick={() => setOpen(true)}>Apply on official site</button>
      {open && (
        <AutoApplyModal
          jobId={1}
          jobTitle="Backend Engineer"
          company="Acme"
          officialUrl="https://boards.greenhouse.io/acme/1"
          onMarkApplied={onMarkApplied}
          // A NEW function every render that reads page state: Escape must run this latest one.
          onClose={() => { onClosed?.(generation); setOpen(false); }}
        />
      )}
    </>
  );
}

const opener = () => screen.getByRole("button", { name: "Apply on official site" });
const dialog = () => screen.getByRole("dialog", { name: "Assisted application" });
const ready = async () => { await screen.findByText("Tailored resume"); };
/** The header X (first in DOM order); the footer also has a button named Close. */
const headerClose = () => within(dialog()).getAllByRole("button", { name: "Close" })[0];

beforeEach(() => {
  calls = []; holdSession = null;
  mockFetch();
  vi.mocked(autoApply.startAssistedApply).mockClear();
  vi.mocked(autoApply.openOfficialSite).mockClear();
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("Apply dialog: keyboard accessibility", () => {
  it("opens by mouse and moves focus into the dialog", async () => {
    render(<Page />);
    await userEvent.click(opener());
    await ready();
    expect(dialog()).toContainElement(document.activeElement as HTMLElement);
    expect(document.activeElement).toBe(headerClose());
  });

  it("opens by keyboard, closes with Escape, and returns focus to the Apply button", async () => {
    render(<Page />);
    opener().focus();
    await userEvent.keyboard("{Enter}");
    await ready();
    expect(dialog()).toContainElement(document.activeElement as HTMLElement);
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(document.activeElement).toBe(opener());
  });

  it("Escape submits nothing, changes no status, navigates nowhere and sends no request", async () => {
    render(<Page />);
    await userEvent.click(opener());
    await ready();
    const before = calls.length;
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(calls.length).toBe(before);                                                            // no request at all from Escape
    expect(writes().map((c) => `${c.method} ${c.url}`)).toEqual([expect.stringContaining("/application-sessions")]);   // only the session created on open
    expect(calls.some((c) => c.url.includes("/status"))).toBe(false);                             // no status PATCH
    expect(autoApply.startAssistedApply).not.toHaveBeenCalled();
    expect(autoApply.openOfficialSite).not.toHaveBeenCalled();                                    // no employer-site navigation
  });

  it("Escape does not mark the job applied, even after the employer site was opened", async () => {
    const onMarkApplied = vi.fn();
    render(<Page onMarkApplied={onMarkApplied} />);
    await userEvent.click(opener());
    await ready();
    await userEvent.click(within(dialog()).getByRole("button", { name: /Open official application/ }));
    await screen.findByText("Finished applying on the employer’s site?");
    const patches = calls.filter((c) => c.method === "PATCH").length;                             // the existing 'opened' telemetry
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(onMarkApplied).not.toHaveBeenCalled();
    expect(calls.filter((c) => c.method === "PATCH").length).toBe(patches);                       // Escape added no mutation
    expect(calls.some((c) => /applied|confirm/i.test(c.url))).toBe(false);
  });

  it("Escape while the application is still being prepared closes safely and leaves no side effect", async () => {
    let release: () => void = () => undefined;
    holdSession = new Promise<void>((resolve) => { release = resolve; });
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    render(<Page />);
    await userEvent.click(opener());
    await screen.findByText(/Understanding|Preparing/i, {}, { timeout: 2000 }).catch(() => undefined);
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await act(async () => { release(); await new Promise((resolve) => setTimeout(resolve, 20)); });
    expect(autoApply.openOfficialSite).not.toHaveBeenCalled();
    expect(calls.filter((c) => c.method === "PATCH")).toHaveLength(0);                            // nothing is marked opened or applied
    expect(errors).not.toHaveBeenCalled();                                                        // no React warning from the late response
  });

  it("keeps Tab and Shift+Tab inside the dialog and never reaches the page behind it", async () => {
    render(<Page />);
    await userEvent.click(opener());
    await ready();
    const inside = new Set<Element>();
    for (let i = 0; i < 12; i += 1) {
      await userEvent.tab();
      expect(dialog()).toContainElement(document.activeElement as HTMLElement);
      inside.add(document.activeElement as Element);
    }
    expect(inside.size).toBeGreaterThan(1);                                                       // it really cycles through controls
    for (let i = 0; i < 12; i += 1) {
      await userEvent.tab({ shift: true });
      expect(dialog()).toContainElement(document.activeElement as HTMLElement);
    }
    expect(document.activeElement).not.toBe(screen.getByRole("button", { name: "Underlying action" }));
    // Shift+Tab from the first control wraps to the last one
    headerClose().focus();
    await userEvent.tab({ shift: true });
    const focusables = Array.from(dialog().querySelectorAll<HTMLElement>('a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])'));
    expect(document.activeElement).toBe(focusables.at(-1));
  });

  it("the Close button still closes it (and returns focus), and the dialog can be reopened after Escape", async () => {
    render(<Page />);
    await userEvent.click(opener());
    await ready();
    await userEvent.click(headerClose());
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(document.activeElement).toBe(opener());
    await userEvent.click(opener());                                                              // reopen
    await ready();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await userEvent.click(opener());                                                              // and again after Escape
    await ready();
    expect(dialog()).toContainElement(document.activeElement as HTMLElement);
    expect(sessionCreations()).toBe(3);                                                           // one session per open, nothing else
    await userEvent.keyboard("{Escape}");
    expect(document.activeElement).toBe(opener());
  });

  it("Escape runs the page's CURRENT close handler, not the one from the render that opened the dialog", async () => {
    const closed = vi.fn();
    render(<Page onClosed={closed} />);
    await userEvent.click(opener());
    await ready();
    // Re-rendering the page gives the dialog a new onClose that reads newer state; Escape must use it.
    within(document.body).getByRole("button", { name: "Re-render page" }).focus();
    await act(async () => { screen.getByRole("button", { name: "Re-render page" }).click(); });
    headerClose().focus();
    await userEvent.keyboard("{Escape}");
    expect(closed).toHaveBeenCalledTimes(1);
    expect(closed).toHaveBeenCalledWith(1);                                                       // the generation after the re-render
  });

  it("a second Escape after it closed is harmless", async () => {
    const closed = vi.fn();
    render(<Page onClosed={closed} />);
    await userEvent.click(opener());
    await ready();
    await userEvent.keyboard("{Escape}{Escape}");
    expect(closed).toHaveBeenCalledTimes(1);
    expect(sessionCreations()).toBe(1);
  });

  it("declares itself modal and labelled", async () => {
    render(<Page />);
    await userEvent.click(opener());
    await ready();
    expect(dialog()).toHaveAttribute("aria-modal", "true");
    await waitFor(() => expect(dialog()).toHaveAccessibleName("Assisted application"));
  });
});

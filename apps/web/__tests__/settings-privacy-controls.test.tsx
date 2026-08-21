import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PrivacyControls } from "../components/PrivacyControls";

const invalidateAuthSession = vi.hoisted(() => vi.fn());
vi.mock("../lib/authSession", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/authSession")>()),
  invalidateAuthSession
}));

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/** Requests actually issued, so "did DELETE fire?" is answered by evidence. */
function mockApi(handlers: {
  exportStatus?: number;
  deleteStatus?: number;
  deleteDetail?: string;
  deleteNetworkError?: boolean;
} = {}) {
  const calls: string[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
    const url = new URL(String(input), "http://localhost:8000");
    const method = init?.method ?? "GET";
    calls.push(`${method} ${url.pathname}`);
    if (url.pathname === "/privacy/export") {
      const status = handlers.exportStatus ?? 200;
      return Promise.resolve(
        status === 200
          ? jsonResponse({ profile: { name: "Chandra" } })
          : jsonResponse({ detail: [{ loc: ["body"], msg: "boom", type: "server_error" }] }, status)
      );
    }
    if (url.pathname === "/privacy/account") {
      if (handlers.deleteNetworkError) return Promise.reject(new TypeError("Failed to fetch"));
      const status = handlers.deleteStatus ?? 200;
      return Promise.resolve(
        status === 200
          ? jsonResponse({})
          // The real operator-facing text the shared auth dependency returns
          // when the database is unreachable. It must never be shown.
          : jsonResponse(
              { detail: handlers.deleteDetail ?? "Database unavailable or not migrated. Run alembic upgrade head." },
              status
            )
      );
    }
    return Promise.resolve(jsonResponse({}));
  });
  return { calls, deletes: () => calls.filter((c) => c === "DELETE /privacy/account") };
}

const deleteTrigger = () => screen.getByRole("button", { name: /Delete account/ });
const dialog = () => screen.getByRole("alertdialog");
const confirmButton = () => within(dialog()).getByRole("button", { name: /Delete account|Deleting/ });

async function openDialog() {
  await userEvent.click(deleteTrigger());
  return dialog();
}

describe("PrivacyControls — account deletion safety", () => {
  beforeEach(() => {
    localStorage.setItem("jobpilot_token", "token");
    invalidateAuthSession.mockClear();
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("does not delete anything when the destructive button is clicked", async () => {
    const api = mockApi();
    render(React.createElement(PrivacyControls));

    await userEvent.click(deleteTrigger());

    // The whole point: opening the confirmation must not be the deletion.
    expect(api.deletes()).toHaveLength(0);
    expect(await screen.findByRole("alertdialog")).toBeInTheDocument();
  });

  it("keeps the destructive confirm disabled until the phrase matches exactly", async () => {
    mockApi();
    render(React.createElement(PrivacyControls));
    await openDialog();

    expect(confirmButton()).toBeDisabled();

    const field = screen.getByLabelText(/Type DELETE to confirm/);
    await userEvent.type(field, "delete");
    expect(confirmButton()).toBeDisabled();

    await userEvent.clear(field);
    await userEvent.type(field, "DELETE ME");
    expect(confirmButton()).toBeDisabled();

    await userEvent.clear(field);
    await userEvent.type(field, "DELETE");
    expect(confirmButton()).toBeEnabled();
  });

  it("cancels without deleting and returns focus to the trigger", async () => {
    const api = mockApi();
    render(React.createElement(PrivacyControls));
    await openDialog();

    await userEvent.click(within(dialog()).getByRole("button", { name: "Cancel" }));

    expect(api.deletes()).toHaveLength(0);
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    await waitFor(() => expect(deleteTrigger()).toHaveFocus());
  });

  it("closes on Escape without deleting", async () => {
    const api = mockApi();
    render(React.createElement(PrivacyControls));
    await openDialog();

    await userEvent.keyboard("{Escape}");

    expect(api.deletes()).toHaveLength(0);
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  it("sends exactly one DELETE and invalidates the session on success", async () => {
    const api = mockApi();
    render(React.createElement(PrivacyControls));
    await openDialog();
    await userEvent.type(screen.getByLabelText(/Type DELETE to confirm/), "DELETE");
    await userEvent.click(confirmButton());

    await waitFor(() => expect(api.deletes()).toHaveLength(1));
    expect(api.calls).toContain("DELETE /privacy/account");
    await waitFor(() =>
      expect(invalidateAuthSession).toHaveBeenCalledWith({ reason: "account_deleted", returnTo: null })
    );
  });

  it("does not send duplicate DELETEs while one is in flight", async () => {
    let release: (value: Response) => void = () => {};
    const calls: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      const url = new URL(String(input), "http://localhost:8000");
      calls.push(`${init?.method ?? "GET"} ${url.pathname}`);
      if (url.pathname === "/privacy/account") {
        return new Promise<Response>((resolve) => {
          release = resolve;
        });
      }
      return Promise.resolve(jsonResponse({}));
    });

    render(React.createElement(PrivacyControls));
    await openDialog();
    await userEvent.type(screen.getByLabelText(/Type DELETE to confirm/), "DELETE");

    const confirm = confirmButton();
    await userEvent.click(confirm);
    // The control is disabled while pending, so further clicks are inert.
    expect(confirm).toBeDisabled();
    await userEvent.click(confirm, { pointerEventsCheck: 0 });
    await userEvent.click(confirm, { pointerEventsCheck: 0 });

    expect(calls.filter((c) => c === "DELETE /privacy/account")).toHaveLength(1);
    release(jsonResponse({}));
  });

  it.each([
    ["a 500", { deleteStatus: 500 }],
    ["a 403", { deleteStatus: 403 }],
    ["a 422", { deleteStatus: 422 }],
    ["a network failure", { deleteNetworkError: true }]
  ])("keeps the dialog open and stays signed in after %s", async (_label, handler) => {
    mockApi(handler);
    render(React.createElement(PrivacyControls));
    await openDialog();
    await userEvent.type(screen.getByLabelText(/Type DELETE to confirm/), "DELETE");
    await userEvent.click(confirmButton());

    const error = await within(dialog()).findByRole("alert");
    expect(error.textContent?.trim()).toBeTruthy();
    // A raw backend payload must never reach the user.
    expect(error.textContent).not.toMatch(/[[{]"?(detail|loc|msg|type)"?/);
    // Nor may operator/internal wording: `DELETE /privacy/account` defines no
    // user-facing failure of its own, so the copy is owned by the frontend.
    expect(error.textContent).toMatch(/couldn.t delete your account/i);
    expect(error.textContent).not.toMatch(/alembic|migrat|database|token|upgrade head/i);
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
    // Ordinary failures are not a session problem.
    expect(invalidateAuthSession).not.toHaveBeenCalled();
  });

  it("shows the same safe message however the backend words the failure", async () => {
    mockApi({ deleteStatus: 503, deleteDetail: "psycopg2.OperationalError: could not connect to server" });
    render(React.createElement(PrivacyControls));
    await openDialog();
    await userEvent.type(screen.getByLabelText(/Type DELETE to confirm/), "DELETE");
    await userEvent.click(confirmButton());

    const error = await within(dialog()).findByRole("alert");
    expect(error.textContent).toMatch(/couldn.t delete your account/i);
    expect(error.textContent).not.toMatch(/psycopg2|OperationalError|connect to server/i);
  });

  it("allows a retry to succeed after a failure", async () => {
    let fail = true;
    const calls: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      const url = new URL(String(input), "http://localhost:8000");
      calls.push(`${init?.method ?? "GET"} ${url.pathname}`);
      if (url.pathname === "/privacy/account") {
        if (fail) {
          fail = false;
          return Promise.resolve(jsonResponse({ detail: "nope" }, 500));
        }
        return Promise.resolve(jsonResponse({}));
      }
      return Promise.resolve(jsonResponse({}));
    });

    render(React.createElement(PrivacyControls));
    await openDialog();
    await userEvent.type(screen.getByLabelText(/Type DELETE to confirm/), "DELETE");
    await userEvent.click(confirmButton());
    await within(dialog()).findByRole("alert");

    await userEvent.click(confirmButton());
    await waitFor(() =>
      expect(invalidateAuthSession).toHaveBeenCalledWith({ reason: "account_deleted", returnTo: null })
    );
    expect(calls.filter((c) => c === "DELETE /privacy/account")).toHaveLength(2);
  });
});

describe("PrivacyControls — data export", () => {
  beforeEach(() => {
    localStorage.setItem("jobpilot_token", "token");
    invalidateAuthSession.mockClear();
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("still exports on success", async () => {
    const api = mockApi();
    render(React.createElement(PrivacyControls));

    await userEvent.click(screen.getByRole("button", { name: /Export JSON/ }));

    await waitFor(() => expect(api.calls).toContain("GET /privacy/export"));
    expect(await screen.findByText(/"Chandra"/)).toBeInTheDocument();
  });

  it.each([
    ["a 500", { exportStatus: 500 }],
    ["a 503", { exportStatus: 503 }]
  ])("shows a recoverable error after %s", async (_label, handler) => {
    mockApi(handler);
    render(React.createElement(PrivacyControls));

    await userEvent.click(screen.getByRole("button", { name: /Export JSON/ }));

    const error = await screen.findByRole("alert");
    expect(error.textContent?.trim()).toBeTruthy();
    expect(error.textContent).not.toMatch(/[[{]"?(detail|loc|msg|type)"?/);
    // A failed export is not a session problem, and nothing stale is rendered.
    expect(invalidateAuthSession).not.toHaveBeenCalled();
    expect(screen.queryByText(/"Chandra"/)).not.toBeInTheDocument();
  });

  it("recovers when a retry succeeds", async () => {
    let fail = true;
    vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      const url = new URL(String(input), "http://localhost:8000");
      if (url.pathname === "/privacy/export") {
        if (fail) {
          fail = false;
          return Promise.resolve(jsonResponse({ detail: "nope" }, 500));
        }
        return Promise.resolve(jsonResponse({ profile: { name: "Chandra" } }));
      }
      return Promise.resolve(jsonResponse({}));
    });

    render(React.createElement(PrivacyControls));
    const button = screen.getByRole("button", { name: /Export JSON/ });
    await userEvent.click(button);
    await screen.findByRole("alert");

    await userEvent.click(screen.getByRole("button", { name: /Export JSON/ }));
    expect(await screen.findByText(/"Chandra"/)).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});

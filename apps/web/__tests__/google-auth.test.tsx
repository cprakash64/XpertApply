import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import LoginPage from "../app/login/page";
import SignupPage from "../app/signup/page";
import GoogleCallbackPage from "../app/auth/google/callback/page";
import { GOOGLE_HANDOFF_VERIFIER_KEY, prepareGoogleAuth, sha256Challenge } from "../lib/googleAuth";

const routerMock = vi.hoisted(() => ({ replace: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => routerMock }));

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("Google authentication", () => {
  beforeEach(() => {
    cleanup();
    localStorage.clear();
    sessionStorage.clear();
    routerMock.replace.mockClear();
    window.history.replaceState({}, "", "/login");
    vi.restoreAllMocks();
  });

  it.each([[LoginPage, "Sign in to XpertApply"], [SignupPage, "Create your account"]])(
    "shows an accessible Google button when enabled",
    async (Page, heading) => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(json({ google: { enabled: true } }));
      render(React.createElement(Page));
      expect(screen.getByRole("heading", { name: heading })).toBeInTheDocument();
      expect(await screen.findByRole("button", { name: "Continue with Google" })).toHaveClass("focus-ring");
    }
  );

  it("does not present a dead Google button when disabled", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(json({ google: { enabled: false } }));
    render(React.createElement(LoginPage));
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: /Google/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Log in" })).toBeEnabled();
  });

  it("creates a Web Crypto verifier and stores it only in sessionStorage", async () => {
    const digest = await sha256Challenge("v".repeat(43));
    expect(digest).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const destination = new URL(await prepareGoogleAuth("https://evil.test"));
    expect(sessionStorage.getItem(GOOGLE_HANDOFF_VERIFIER_KEY)).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(localStorage.getItem(GOOGLE_HANDOFF_VERIFIER_KEY)).toBeNull();
    expect(destination.pathname).toBe("/auth/google/start");
    expect(destination.searchParams.get("return_to")).toBe("/dashboard");
    expect([...destination.searchParams.keys()].sort()).toEqual(["handoff_challenge", "return_to"]);
  });

  it("clears the callback URL, exchanges the code, stores JWT, and redirects safely", async () => {
    sessionStorage.setItem(GOOGLE_HANDOFF_VERIFIER_KEY, "v".repeat(43));
    window.history.replaceState({}, "", "/auth/google/callback?code=opaque-completion");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(json({ result: "authenticated", access_token: "xpert-jwt", return_to: "/profile" }));
    render(React.createElement(GoogleCallbackPage));
    await waitFor(() => expect(localStorage.getItem("jobpilot_token")).toBe("xpert-jwt"));
    expect(window.location.search).toBe("");
    expect(sessionStorage.getItem(GOOGLE_HANDOFF_VERIFIER_KEY)).toBeNull();
    expect(routerMock.replace).toHaveBeenCalledWith("/profile");
  });

  it("renders link-required reauthentication and keeps wrong-password errors generic", async () => {
    sessionStorage.setItem(GOOGLE_HANDOFF_VERIFIER_KEY, "v".repeat(43));
    window.history.replaceState({}, "", "/auth/google/callback?code=opaque-completion");
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(json({ result: "link_required", link_ticket: "opaque-link", return_to: "/dashboard" }))
      .mockResolvedValueOnce(json({ error: { code: "GOOGLE_LINK_INVALID", message: "Unable to connect Google." } }, 401));
    render(React.createElement(GoogleCallbackPage));
    const password = await screen.findByLabelText("Password");
    await userEvent.type(password, "wrong-password");
    await userEvent.click(screen.getByRole("button", { name: "Sign in and connect Google" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("The password was not accepted.");
  });

  it("renders a safe OAuth error after removing it from browser history", async () => {
    window.history.replaceState({}, "", "/auth/google/callback?error=GOOGLE_AUTH_CANCELLED&state=secret");
    render(React.createElement(GoogleCallbackPage));
    expect(await screen.findByRole("alert")).toHaveTextContent("Google sign-in was cancelled.");
    expect(window.location.search).toBe("");
    expect(screen.queryByText(/secret/)).not.toBeInTheDocument();
  });

  it("links after password reauthentication and uses a safe return path", async () => {
    sessionStorage.setItem(GOOGLE_HANDOFF_VERIFIER_KEY, "v".repeat(43));
    window.history.replaceState({}, "", "/auth/google/callback?code=opaque-completion");
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(json({ result: "link_required", link_ticket: "opaque-link", return_to: "https://evil.test" }))
      .mockResolvedValueOnce(json({ access_token: "linked-jwt" }));
    render(React.createElement(GoogleCallbackPage));
    await userEvent.type(await screen.findByLabelText("Password"), "correct-password");
    await userEvent.click(screen.getByRole("button", { name: "Sign in and connect Google" }));
    await waitFor(() => expect(localStorage.getItem("jobpilot_token")).toBe("linked-jwt"));
    expect(routerMock.replace).toHaveBeenCalledWith("/dashboard");
  });
});

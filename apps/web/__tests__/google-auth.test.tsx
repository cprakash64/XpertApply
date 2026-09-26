import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React, { StrictMode } from "react";
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
      const button = await screen.findByRole("button", { name: "Continue with Google" });
      expect(button).toHaveClass("ds-focus-ring");
      expect(button.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
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
    render(<StrictMode><GoogleCallbackPage /></StrictMode>);
    await waitFor(() => expect(localStorage.getItem("jobpilot_token")).toBe("xpert-jwt"));
    expect(window.location.search).toBe("");
    expect(sessionStorage.getItem(GOOGLE_HANDOFF_VERIFIER_KEY)).toBeNull();
    expect(routerMock.replace).toHaveBeenCalledWith("/profile");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("renders the exact safe wrong-password linking error", async () => {
    sessionStorage.setItem(GOOGLE_HANDOFF_VERIFIER_KEY, "v".repeat(43));
    window.history.replaceState({}, "", "/auth/google/callback?code=opaque-completion");
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(json({ result: "link_required", link_ticket: "opaque-link", return_to: "/dashboard" }))
      .mockResolvedValueOnce(json({ error: { code: "GOOGLE_LINK_INVALID", message: "Unable to connect Google." } }, 401));
    render(React.createElement(GoogleCallbackPage));
    const password = await screen.findByLabelText("Password");
    await userEvent.type(password, "wrong-password");
    await userEvent.click(screen.getByRole("button", { name: "Sign in and connect Google" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Wrong password, please try again.");
    expect(password).toHaveAttribute("aria-invalid", "true");
    await waitFor(() => expect(password).toHaveFocus());
  });

  it("validates an empty linking password next to the field", async () => {
    sessionStorage.setItem(GOOGLE_HANDOFF_VERIFIER_KEY, "v".repeat(43));
    window.history.replaceState({}, "", "/auth/google/callback?code=opaque-completion");
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(json({ result: "link_required", link_ticket: "opaque-link", return_to: "/dashboard" }));
    render(React.createElement(GoogleCallbackPage));
    const password = await screen.findByLabelText("Password");
    await userEvent.click(screen.getByRole("button", { name: "Sign in and connect Google" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Enter your password.");
    expect(password).toHaveAttribute("aria-describedby", "google-link-error");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    [400, "GOOGLE_LINK_EXPIRED", "This Google connection request expired. Start Google sign-in again."],
    [429, "GOOGLE_LINK_INVALID", "Too many attempts. Please wait and try again."],
    [409, "GOOGLE_PROVIDER_CONFLICT", "We couldn't connect Google to this account. Please sign in again and retry."]
  ])("maps linking failures without rendering backend details", async (status, code, message) => {
    sessionStorage.setItem(GOOGLE_HANDOFF_VERIFIER_KEY, "v".repeat(43));
    window.history.replaceState({}, "", "/auth/google/callback?code=opaque-completion");
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(json({ result: "link_required", link_ticket: "opaque-link", return_to: "/dashboard" }))
      .mockResolvedValueOnce(json({ error: { code, message: "raw provider diagnostic" } }, status));
    render(React.createElement(GoogleCallbackPage));
    await userEvent.type(await screen.findByLabelText("Password"), "password-value");
    await userEvent.click(screen.getByRole("button", { name: "Sign in and connect Google" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(message);
    expect(document.body).not.toHaveTextContent("raw provider diagnostic");
  });

  it("renders a safe OAuth error after removing it from browser history", async () => {
    window.history.replaceState({}, "", "/auth/google/callback?error=GOOGLE_AUTH_CANCELLED&state=secret");
    const fetchMock = vi.spyOn(globalThis, "fetch");
    render(<StrictMode><GoogleCallbackPage /></StrictMode>);
    expect(await screen.findByRole("alert")).toHaveTextContent("Google sign-in was cancelled.");
    await Promise.resolve();
    expect(screen.getByRole("alert")).toHaveTextContent("Google sign-in was cancelled.");
    expect(window.location.search).toBe("");
    expect(screen.queryByText(/secret/)).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports a genuinely missing callback completion", async () => {
    window.history.replaceState({}, "", "/auth/google/callback");
    render(<StrictMode><GoogleCallbackPage /></StrictMode>);
    expect(await screen.findByRole("alert")).toHaveTextContent("The Google sign-in completion is missing.");
  });

  it("distinguishes a missing verifier from a missing completion", async () => {
    window.history.replaceState({}, "", "/auth/google/callback?code=opaque-completion");
    render(<StrictMode><GoogleCallbackPage /></StrictMode>);
    expect(await screen.findByRole("alert")).toHaveTextContent("Your Google sign-in session expired. Please try again.");
    expect(window.location.search).toBe("");
  });

  it.each([
    ["GOOGLE_SESSION_EXPIRED", "Your Google sign-in session expired. Please try again."],
    ["GOOGLE_AUTH_UNAVAILABLE", "Google sign-in is currently unavailable."],
    ["OAUTH_TEMPORARY_FAILURE", "Google sign-in is temporarily unavailable. Please try again."],
    ["invalid_client", "We couldn't sign you in with Google. Please try again."]
  ])("maps callback category %s to safe copy", async (code, message) => {
    window.history.replaceState({}, "", `/auth/google/callback?error=${code}&error_description=raw-secret-detail`);
    render(React.createElement(GoogleCallbackPage));
    expect(await screen.findByRole("alert")).toHaveTextContent(message);
    expect(document.body).not.toHaveTextContent(/invalid_client|raw-secret-detail/);
    expect(window.location.search).toBe("");
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

/**
 * Password recovery pages.
 *
 * The API is a fetch stub, but each assertion is about what the PERSON sees and
 * what the page sends: generic confirmation, honest unavailability, the reset
 * token kept out of the URL, storage and every request but the two that need it.
 */
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ForgotPasswordForm, ResetPasswordForm } from "../components/PasswordRecovery";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }), usePathname: () => "/reset-password" }));

type Call = { url: string; method: string; body: unknown };
let calls: Call[];
let handler: (url: string, body: unknown) => Response | Promise<Response>;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const TOKEN = "Zk3q9XvV1pQmWb7nR2sT5uYc8dFgHjLaEoNiMtBeUwA";

beforeEach(() => {
  calls = [];
  handler = (url) => (url.endsWith("/availability") ? json({ available: true }) : json({}));
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, method: init?.method ?? "GET", body });
    return handler(url, body);
  });
  localStorage.clear();
  sessionStorage.clear();
  window.history.pushState({}, "", "/");
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const posted = (suffix: string) => calls.filter((call) => call.url.endsWith(suffix));

describe("forgot password", () => {
  it("asks only for an email, and offers a way back to sign in", async () => {
    render(React.createElement(ForgotPasswordForm));
    expect(await screen.findByLabelText("Email address")).toBeEnabled();
    expect(screen.getByRole("heading", { name: "Forgot your password?" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Back to sign in" })).toHaveAttribute("href", "/login");
    expect(screen.getByRole("link", { name: "XpertApply" })).toHaveAttribute("href", "/");
    expect(screen.queryByText(/Private by default/)).toBeNull();
  });

  it("is honest when no email delivery is configured: no form, a clear message", async () => {
    handler = () => json({ available: false });
    render(React.createElement(ForgotPasswordForm));
    expect(await screen.findByRole("heading", { name: "Password recovery is unavailable" })).toBeInTheDocument();
    expect(screen.queryByLabelText("Email address")).toBeNull();
    expect(screen.getByRole("link", { name: "Back to sign in" })).toBeInTheDocument();
  });

  it.each([["", "Enter your email address."], ["not-an-email", "Enter a valid email address."]])(
    "refuses %j on the client without calling the API",
    async (value, message) => {
      render(React.createElement(ForgotPasswordForm));
      const input = await screen.findByLabelText("Email address");
      if (value) await userEvent.type(input, value);
      await userEvent.click(screen.getByRole("button", { name: "Send reset link" }));
      expect(await screen.findByRole("alert")).toHaveTextContent(message);
      expect(input).toHaveAttribute("aria-invalid", "true");
      expect(posted("/request")).toHaveLength(0);
    }
  );

  it("shows the same generic confirmation, and never claims the account exists", async () => {
    handler = (url) => (url.endsWith("/availability") ? json({ available: true }) : json({ status: "accepted" }, 202));
    render(React.createElement(ForgotPasswordForm));
    await userEvent.type(await screen.findByLabelText("Email address"), "nobody@example.com");
    await userEvent.click(screen.getByRole("button", { name: "Send reset link" }));
    expect(await screen.findByRole("heading", { name: "Check your email" })).toBeInTheDocument();
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent(/If an account exists for nobody@example.com/);
    expect(status).toHaveTextContent("expires in 30 minutes");
    expect(posted("/request")[0].body).toEqual({ email: "nobody@example.com" });
    await userEvent.click(screen.getByRole("button", { name: "Use a different email" }));
    expect(await screen.findByLabelText("Email address")).toBeInTheDocument();
  });

  it.each([
    [429, /Too many attempts/],
    [500, /couldn.t send the link/i]
  ])("a %s answer is a readable form error", async (status, message) => {
    handler = (url) => (url.endsWith("/availability") ? json({ available: true }) : json({ detail: "x" }, status));
    render(React.createElement(ForgotPasswordForm));
    await userEvent.type(await screen.findByLabelText("Email address"), "ada@example.com");
    await userEvent.click(screen.getByRole("button", { name: "Send reset link" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(message);
  });

  it("a 503 from the request turns into the unavailable state", async () => {
    handler = (url) => (url.endsWith("/availability") ? json({ available: true }) : json({ detail: "n/a" }, 503));
    render(React.createElement(ForgotPasswordForm));
    await userEvent.type(await screen.findByLabelText("Email address"), "ada@example.com");
    await userEvent.click(screen.getByRole("button", { name: "Send reset link" }));
    expect(await screen.findByRole("heading", { name: "Password recovery is unavailable" })).toBeInTheDocument();
  });

  it("a network failure is retryable and says so", async () => {
    render(React.createElement(ForgotPasswordForm));
    const input = await screen.findByLabelText("Email address");
    vi.mocked(fetch).mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await userEvent.type(input, "ada@example.com");
    await userEvent.click(screen.getByRole("button", { name: "Send reset link" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/check your connection/i);
    expect(screen.getByRole("button", { name: "Send reset link" })).toBeEnabled();
  });

  it("lets password managers and keyboards work: labelled, email-typed, autocomplete=email", async () => {
    render(React.createElement(ForgotPasswordForm));
    const input = await screen.findByLabelText("Email address");
    expect(input).toHaveAttribute("type", "email");
    expect(input).toHaveAttribute("autocomplete", "email");
    expect(input).toHaveAttribute("name", "email");
  });
});

describe("reset password", () => {
  const open = (hash = `#token=${TOKEN}`) => window.history.pushState({}, "", `/reset-password${hash}`);

  it("a link with no token is a final, honest state with a way forward", async () => {
    open("");
    render(React.createElement(ResetPasswordForm));
    expect(await screen.findByRole("heading", { name: "This link can't be used" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Request a new link" })).toHaveAttribute("href", "/forgot-password");
    expect(posted("/verify")).toHaveLength(0);
  });

  it("takes the token out of the address bar and storage before doing anything else", async () => {
    open();
    handler = () => json({ valid: true });
    render(React.createElement(ResetPasswordForm));
    await screen.findByLabelText("New password");
    expect(window.location.hash).toBe("");
    expect(window.location.href).not.toContain(TOKEN);
    expect(JSON.stringify({ ...localStorage })).not.toContain(TOKEN);
    expect(JSON.stringify({ ...sessionStorage })).not.toContain(TOKEN);
    // The token goes only in request BODIES, never in a URL.
    expect(calls.every((call) => !call.url.includes(TOKEN))).toBe(true);
    expect(posted("/verify")[0].body).toEqual({ token: TOKEN });
  });

  it.each([[false, "This link can't be used"], [true, "Choose a new password"]])(
    "verify=%s decides which page is shown",
    async (valid, heading) => {
      open();
      handler = () => json({ valid });
      render(React.createElement(ResetPasswordForm));
      expect(await screen.findByRole("heading", { name: heading })).toBeInTheDocument();
    }
  );

  async function ready() {
    open();
    handler = (url) => (url.endsWith("/verify") ? json({ valid: true }) : json({ status: "password_updated" }));
    render(React.createElement(ResetPasswordForm));
    const password = await screen.findByLabelText("New password");
    const confirm = screen.getByLabelText("Confirm new password");
    return { password, confirm };
  }

  it("states the requirements and uses new-password autocomplete on both fields", async () => {
    const { password, confirm } = await ready();
    expect(screen.getByText(/at least 10 characters/i)).toBeInTheDocument();
    expect(password).toHaveAttribute("autocomplete", "new-password");
    expect(confirm).toHaveAttribute("autocomplete", "new-password");
    expect(password).toHaveAttribute("aria-describedby", "new-password-help");
    expect(screen.getByRole("link", { name: "Back to sign in" })).toHaveAttribute("href", "/login");
  });

  it("show/hide toggles each field and exposes its state", async () => {
    const { password } = await ready();
    const toggle = screen.getByRole("button", { name: "Show new password" });
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    await userEvent.click(toggle);
    expect(password).toHaveAttribute("type", "text");
    expect(screen.getByRole("button", { name: "Hide new password" })).toHaveAttribute("aria-pressed", "true");
  });

  it("refuses a short password and a mismatch locally, with announced errors", async () => {
    const { password, confirm } = await ready();
    await userEvent.type(password, "short");
    await userEvent.type(confirm, "short");
    await userEvent.click(screen.getByRole("button", { name: "Update password" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Password must be at least 10 characters.");
    expect(password).toHaveAttribute("aria-invalid", "true");
    await userEvent.clear(password);
    await userEvent.type(password, "a long enough one");
    await userEvent.click(screen.getByRole("button", { name: "Update password" }));
    expect(await screen.findByText("The passwords don't match.")).toBeInTheDocument();
    expect(posted("/confirm")).toHaveLength(0);
  });

  it("updates the password, shows the confirmation, and does not log the person in", async () => {
    const { password, confirm } = await ready();
    await userEvent.type(password, "a brand new passphrase");
    await userEvent.type(confirm, "a brand new passphrase");
    await userEvent.click(screen.getByRole("button", { name: "Update password" }));
    expect(await screen.findByRole("heading", { name: "Password updated" })).toBeInTheDocument();
    expect(posted("/confirm")[0].body).toEqual({ token: TOKEN, new_password: "a brand new passphrase" });
    expect(screen.getByRole("link", { name: /Go to sign in/ })).toHaveAttribute("href", "/login");
    expect(localStorage.getItem("jobpilot_token")).toBeNull();
    expect(screen.queryByLabelText("New password")).toBeNull();
  });

  it("an expired or reused link on submit becomes the can't-be-used page", async () => {
    const { password, confirm } = await ready();
    handler = (url) => (url.endsWith("/verify") ? json({ valid: true }) : json({ detail: "This reset link is invalid or has expired." }, 400));
    await userEvent.type(password, "a brand new passphrase");
    await userEvent.type(confirm, "a brand new passphrase");
    await userEvent.click(screen.getByRole("button", { name: "Update password" }));
    expect(await screen.findByRole("heading", { name: "This link can't be used" })).toBeInTheDocument();
  });

  it("a server policy rejection and a rate limit are readable and keep the form", async () => {
    const { password, confirm } = await ready();
    handler = (url) => (url.endsWith("/verify") ? json({ valid: true }) : json({ detail: [{ loc: ["body", "new_password"], msg: "x" }] }, 422));
    await userEvent.type(password, "a brand new passphrase");
    await userEvent.type(confirm, "a brand new passphrase");
    await userEvent.click(screen.getByRole("button", { name: "Update password" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/not your email address/);
    handler = (url) => (url.endsWith("/verify") ? json({ valid: true }) : json({ detail: "x" }, 429));
    await userEvent.click(screen.getByRole("button", { name: "Update password" }));
    await waitFor(() => expect(screen.getAllByRole("alert").some((el) => /Too many attempts/.test(el.textContent ?? ""))).toBe(true));
    expect(within(screen.getByRole("main")).getByLabelText("New password")).toBeInTheDocument();
  });
});

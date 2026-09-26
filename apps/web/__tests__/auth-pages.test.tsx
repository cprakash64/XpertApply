import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import LoginPage from "../app/login/page";
import SignupPage from "../app/signup/page";
import HomePage from "../app/page";

const routerMock = vi.hoisted(() => ({
  replace: vi.fn()
}));

vi.mock("next/navigation", () => ({
  useRouter: () => routerMock
}));

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

/**
 * Fill the form the way a user has to.
 *
 * The fields no longer ship pre-filled with the seed script's demo account, so
 * a test that just clicks Submit would be exercising an empty, invalid form.
 */
async function fillCredentials(email = "person@work.test", password = "correct-horse-battery") {
  await userEvent.type(screen.getByLabelText("Email address"), email);
  await userEvent.type(screen.getByLabelText("Password"), password);
}

describe("auth pages", () => {
  beforeEach(() => {
    cleanup();
    localStorage.clear();
    routerMock.replace.mockClear();
    window.history.replaceState({}, "", "/login");
    vi.restoreAllMocks();
  });

  it("signup submits, stores token, and redirects to dashboard", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ access_token: "signup-token", token_type: "bearer" })
    );

    render(React.createElement(SignupPage));
    await fillCredentials();
    await userEvent.click(screen.getByRole("button", { name: "Create account" }));

    await waitFor(() => expect(localStorage.getItem("jobpilot_token")).toBe("signup-token"));
    expect(routerMock.replace).toHaveBeenCalledWith("/dashboard");
    expect(fetch).toHaveBeenCalledWith(
      "http://localhost:8000/auth/signup",
      expect.objectContaining({ method: "POST" })
    );
  });

  it("signup displays a safe duplicate-account form error", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ detail: "Email already registered" }, 409)
    );

    render(React.createElement(SignupPage));
    await fillCredentials();
    await userEvent.click(screen.getByRole("button", { name: "Create account" }));

    expect(
      await screen.findByText("We couldn't create this account. Try signing in instead.")
    ).toHaveAttribute("role", "alert");
    expect(document.body).not.toHaveTextContent("Email already registered");
  });

  it.each([
    ["email", "Email address", "value is not a valid email address", "Enter a valid email address."],
    ["password", "Password", "String should have at least 10 characters", "Password must be at least 10 characters."]
  ])("maps server validation safely onto the %s field", async (field, label, backendMessage, safeMessage) => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(
        {
          detail: [
            {
              type: "value_error",
              loc: ["body", field],
              msg: backendMessage,
              input: "redacted"
            }
          ]
        },
        422
      )
    );

    render(React.createElement(SignupPage));
    await fillCredentials();
    await userEvent.click(screen.getByRole("button", { name: "Create account" }));

    const input = screen.getByLabelText(label);
    const error = await screen.findByText(safeMessage);
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(input).toHaveAttribute("aria-describedby", error.id);
    await waitFor(() => expect(input).toHaveFocus());
    expect(document.body).not.toHaveTextContent(backendMessage);
  });

  it.each([
    [LoginPage, "Log in", "Enter your email address.", "Enter your password."],
    [SignupPage, "Create account", "Enter your email address.", "Create a password."]
  ])("shows exact empty-field guidance", async (Page, button, emailMessage, passwordMessage) => {
    render(React.createElement(Page));
    await userEvent.click(screen.getByRole("button", { name: button }));
    expect(screen.getByText(emailMessage)).toHaveAttribute("role", "alert");
    expect(screen.getByText(passwordMessage)).toHaveAttribute("role", "alert");
    await waitFor(() => expect(screen.getByLabelText("Email address")).toHaveFocus());
  });

  it.each([[LoginPage, "Log in"], [SignupPage, "Create account"]])(
    "shows exact malformed-email guidance",
    async (Page, button) => {
      render(React.createElement(Page));
      await fillCredentials("not-an-email");
      await userEvent.click(screen.getByRole("button", { name: button }));
      expect(screen.getByText("Enter a valid email address.")).toHaveAttribute("role", "alert");
      await waitFor(() => expect(screen.getByLabelText("Email address")).toHaveFocus());
    }
  );

  it("shows the exact client-side signup minimum", async () => {
    render(React.createElement(SignupPage));
    await fillCredentials("person@work.test", "short");
    await userEvent.click(screen.getByRole("button", { name: "Create account" }));
    expect(screen.getByText("Password must be at least 10 characters.")).toHaveAttribute("role", "alert");
    await waitFor(() => expect(screen.getByLabelText("Password")).toHaveFocus());
  });

  it("keeps the browser password rule aligned with the backend", () => {
    render(React.createElement(SignupPage));

    expect(screen.getByLabelText("Password")).toHaveAttribute("minlength", "10");
    expect(screen.getByText("Use at least 10 characters.")).toHaveAttribute(
      "id",
      "auth-password-help"
    );
  });

  it("shows a safe retry message for an unexpected server error", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("upstream stack trace must not render", { status: 500 })
    );

    render(React.createElement(SignupPage));
    await fillCredentials();
    await userEvent.click(screen.getByRole("button", { name: "Create account" }));

    expect(
      await screen.findByText("We couldn't create your account. Please try again.")
    ).toHaveAttribute("role", "alert");
    expect(document.body).not.toHaveTextContent("upstream stack trace");
  });

  it("shows a safe connection message when the backend is unavailable", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("connection refused"));

    render(React.createElement(SignupPage));
    await fillCredentials();
    await userEvent.click(screen.getByRole("button", { name: "Create account" }));

    expect(
      await screen.findByText("We couldn't create your account. Check your connection and try again.")
    ).toHaveAttribute("role", "alert");
    expect(document.body).not.toHaveTextContent("connection refused");
  });

  it("login submits, stores token, and redirects to dashboard", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ access_token: "login-token", token_type: "bearer" })
    );

    render(React.createElement(LoginPage));
    await fillCredentials();
    await userEvent.click(screen.getByRole("button", { name: "Log in" }));

    await waitFor(() => expect(localStorage.getItem("jobpilot_token")).toBe("login-token"));
    expect(routerMock.replace).toHaveBeenCalledWith("/dashboard");
    expect(fetch).toHaveBeenCalledWith(
      "http://localhost:8000/auth/login",
      expect.objectContaining({ method: "POST" })
    );
  });

  it("coalesces duplicate login submissions while replacement is pending", async () => {
    let release!: (response: Response) => void;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(
      () => new Promise<Response>((resolve) => { release = resolve; })
    );
    render(React.createElement(LoginPage));
    await fillCredentials();
    const form = screen.getByRole("button", { name: "Log in" }).closest("form");
    expect(form).not.toBeNull();
    fireEvent.submit(form!);
    fireEvent.submit(form!);
    expect(
      fetchMock.mock.calls.filter(([input]) => String(input).endsWith("/auth/login"))
    ).toHaveLength(1);
    release(jsonResponse({ access_token: "login-token", token_type: "bearer" }));
    await waitFor(() => expect(routerMock.replace).toHaveBeenCalledWith("/dashboard"));
  });

  it.each(["unknown@work.test", "person@work.test"])(
    "login keeps incorrect credentials enumeration-safe for %s",
    async (email) => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ detail: "Invalid credentials" }, 401)
    );

    render(React.createElement(LoginPage));
    await fillCredentials(email);
    await userEvent.click(screen.getByRole("button", { name: "Log in" }));

    expect(await screen.findByText("Email or password is incorrect. Please try again.")).toHaveAttribute("role", "alert");
    expect(document.body).not.toHaveTextContent("Invalid credentials");
    }
  );

  it("shows a safe sign-in network failure", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("network internals"));
    render(React.createElement(LoginPage));
    await fillCredentials();
    await userEvent.click(screen.getByRole("button", { name: "Log in" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("We couldn't sign you in. Check your connection and try again.");
    expect(document.body).not.toHaveTextContent("network internals");
  });

  it.each([
    [LoginPage, "Log in", "Too many sign-in attempts. Please wait a few minutes and try again."],
    [SignupPage, "Create account", "Too many attempts. Please wait a few minutes and try again."]
  ])("shows a safe rate-limit message", async (Page, button, message) => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({ detail: "raw limiter detail" }, 429));
    render(React.createElement(Page));
    await fillCredentials();
    await userEvent.click(screen.getByRole("button", { name: button }));
    expect(await screen.findByRole("alert")).toHaveTextContent(message);
    expect(document.body).not.toHaveTextContent("raw limiter detail");
  });

  it("returns a successful login to a safe protected deep link", async () => {
    window.history.replaceState({}, "", "/login?next=%2Fprofile%2Fpreferences");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ access_token: "login-token", token_type: "bearer" })
    );

    render(React.createElement(LoginPage));
    await fillCredentials();
    await userEvent.click(screen.getByRole("button", { name: "Log in" }));

    await waitFor(() =>
      expect(routerMock.replace).toHaveBeenCalledWith("/profile/preferences")
    );
  });

  it("ignores an external return target and keeps a stale-token login page usable", async () => {
    window.history.replaceState(
      {},
      "",
      "/login?next=https%3A%2F%2Fattacker.example%2Fsteal"
    );
    localStorage.setItem("jobpilot_token", "stale-token");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ access_token: "fresh-token", token_type: "bearer" })
    );

    render(React.createElement(LoginPage));
    expect(screen.getByRole("heading", { name: "Sign in to XpertApply" })).toBeInTheDocument();
    await fillCredentials();
    await userEvent.click(screen.getByRole("button", { name: "Log in" }));

    await waitFor(
      () => expect(routerMock.replace).toHaveBeenCalledWith("/dashboard"),
      { timeout: 2_500 }
    );
    expect(localStorage.getItem("jobpilot_token")).toBe("fresh-token");
  });

  /*
   * The forms shipped pre-filled with the local seed script's demo account
   * (demo@example.com / demo-password). That is a working credential pair shown
   * to every visitor, so it must never reach a public deployment again.
   */
  describe("no credentials are pre-filled", () => {
    it.each([
      ["login", LoginPage, "current-password"],
      ["signup", SignupPage, "new-password"]
    ] as const)("%s starts empty with correct autocomplete semantics", (_name, Page, passwordPolicy) => {
      render(React.createElement(Page));

      const email = screen.getByLabelText("Email address");
      const password = screen.getByLabelText("Password");

      expect(email).toHaveValue("");
      expect(password).toHaveValue("");

      // Autocomplete must survive: password managers depend on it.
      expect(email).toHaveAttribute("autocomplete", "email");
      expect(password).toHaveAttribute("autocomplete", passwordPolicy);

      // Nothing anywhere on the page hands out the fixture account.
      expect(document.body.textContent).not.toMatch(/demo@example\.com|demo-password/);
      for (const input of document.querySelectorAll("input")) {
        expect(input.getAttribute("placeholder") ?? "").not.toMatch(/demo/i);
      }
    });
  });

  /*
   * The landing page used to open the auth form as a modal over itself. It now
   * sends visitors to the real /login and /signup routes instead: those pages
   * already exist, they are linkable and shareable, and it lets the landing page
   * stay a server-rendered tree with no auth state of its own.
   */
  it("sends landing-page visitors to the real auth routes", () => {
    render(React.createElement(HomePage));

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    for (const link of screen.getAllByRole("link", { name: /^Sign in$/ })) {
      expect(link).toHaveAttribute("href", "/login");
    }
    for (const link of screen.getAllByRole("link", { name: /^Get started/ })) {
      expect(link).toHaveAttribute("href", "/signup");
    }
  });

  it("still switches between login and signup in place on the auth page itself", async () => {
    render(React.createElement(SignupPage));

    const form = screen.getByRole("heading", { name: "Create your account" });
    expect(form).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(screen.getByRole("heading", { name: "Sign in to XpertApply" })).toBeInTheDocument();
  });
});

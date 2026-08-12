import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import LoginPage from "../app/login/page";
import SignupPage from "../app/signup/page";
import HomePage from "../app/page";

const routerMock = vi.hoisted(() => ({
  push: vi.fn()
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
    routerMock.push.mockClear();
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
    expect(routerMock.push).toHaveBeenCalledWith("/dashboard");
    expect(fetch).toHaveBeenCalledWith(
      "http://localhost:8000/auth/signup",
      expect.objectContaining({ method: "POST" })
    );
  });

  it("signup displays backend errors", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ detail: "Email already registered" }, 409)
    );

    render(React.createElement(SignupPage));
    await fillCredentials();
    await userEvent.click(screen.getByRole("button", { name: "Create account" }));

    expect(await screen.findByText("Email already registered")).toBeInTheDocument();
  });

  it("login submits, stores token, and redirects to dashboard", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ access_token: "login-token", token_type: "bearer" })
    );

    render(React.createElement(LoginPage));
    await fillCredentials();
    await userEvent.click(screen.getByRole("button", { name: "Log in" }));

    await waitFor(() => expect(localStorage.getItem("jobpilot_token")).toBe("login-token"));
    expect(routerMock.push).toHaveBeenCalledWith("/dashboard");
    expect(fetch).toHaveBeenCalledWith(
      "http://localhost:8000/auth/login",
      expect.objectContaining({ method: "POST" })
    );
  });

  it("login displays backend errors", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ detail: "Invalid credentials" }, 401)
    );

    render(React.createElement(LoginPage));
    await fillCredentials();
    await userEvent.click(screen.getByRole("button", { name: "Log in" }));

    expect(await screen.findByText("Invalid credentials")).toBeInTheDocument();
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
    for (const link of screen.getAllByRole("link", { name: /^Get started$/ })) {
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

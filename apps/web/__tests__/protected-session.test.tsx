import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import DashboardPage from "@/app/dashboard/page";
import SettingsPage from "@/app/settings/page";
import { AppShell } from "@/components/AppShell";
import { __resetAuthSessionForTests, storeAuthToken } from "@/lib/authSession";
import { __resetDashboardSummaryCache } from "@/lib/dashboardSummary";

const navigation = vi.hoisted(() => ({
  pathname: "/dashboard",
  replace: vi.fn()
}));

vi.mock("next/navigation", () => ({
  usePathname: () => navigation.pathname,
  useRouter: () => ({ replace: navigation.replace })
}));

function response(status: number, detail = "failure") {
  return new Response(JSON.stringify({ detail }), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

function expiredJwt(): string {
  const encode = (value: unknown) =>
    btoa(JSON.stringify(value)).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
  return `${encode({ alg: "HS256" })}.${encode({ sub: "1", exp: 1 })}.signature`;
}

describe("protected session boundary", () => {
  beforeEach(() => {
    cleanup();
    vi.restoreAllMocks();
    localStorage.clear();
    navigation.replace.mockClear();
    navigation.pathname = "/dashboard";
    window.history.replaceState({}, "", "/dashboard");
    __resetAuthSessionForTests();
    __resetDashboardSummaryCache();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    __resetDashboardSummaryCache();
  });

  it("does not render protected content without auth and preserves a deep link", async () => {
    navigation.pathname = "/profile/preferences";
    window.history.replaceState({}, "", "/profile/preferences");
    render(
      <AppShell>
        <p>Private profile content</p>
      </AppShell>
    );

    expect(screen.queryByText("Private profile content")).not.toBeInTheDocument();
    await waitFor(() =>
      expect(navigation.replace).toHaveBeenCalledWith(
        "/login?next=%2Fprofile%2Fpreferences"
      )
    );
    expect(screen.queryByRole("complementary", { name: "Primary" })).not.toBeInTheDocument();
  });

  it("rejects an expired JWT on reload before protected chrome renders", async () => {
    storeAuthToken(expiredJwt());
    render(<AppShell><p>Private dashboard</p></AppShell>);

    expect(screen.queryByText("Private dashboard")).not.toBeInTheDocument();
    await waitFor(() =>
      expect(navigation.replace).toHaveBeenCalledWith("/login?next=%2Fdashboard")
    );
    expect(localStorage.getItem("jobpilot_token")).toBeNull();
  });

  it("renders protected content for an available session", async () => {
    storeAuthToken("server-authoritative-token");
    render(<AppShell><p>Private dashboard</p></AppShell>);
    expect(await screen.findByText("Private dashboard")).toBeInTheDocument();
    expect(navigation.replace).not.toHaveBeenCalled();
  });

  it("turns a Dashboard 401 into login instead of the dashboard error state", async () => {
    storeAuthToken("stale-token");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(response(401, "Invalid token"));
    render(<DashboardPage />);

    await waitFor(() =>
      expect(navigation.replace).toHaveBeenCalledWith("/login?next=%2Fdashboard")
    );
    expect(screen.queryByText(/couldn’t load your dashboard/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("complementary", { name: "Primary" })).not.toBeInTheDocument();
  });

  it("turns a Settings 401 into login instead of rendering Invalid token", async () => {
    navigation.pathname = "/settings";
    window.history.replaceState({}, "", "/settings");
    storeAuthToken("stale-token");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(response(401, "Invalid token"));
    render(<SettingsPage />);

    await waitFor(() =>
      expect(navigation.replace).toHaveBeenCalledWith("/login?next=%2Fsettings")
    );
    expect(screen.queryByText("Invalid token")).not.toBeInTheDocument();
    expect(screen.queryByRole("complementary", { name: "Primary" })).not.toBeInTheDocument();
  });

  it("keeps Settings local error UI for an ordinary endpoint failure", async () => {
    navigation.pathname = "/settings";
    window.history.replaceState({}, "", "/settings");
    storeAuthToken("valid-token");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      response(500, "Accounts are temporarily unavailable")
    );
    render(<SettingsPage />);

    expect(await screen.findByText("Accounts are temporarily unavailable")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
    expect(navigation.replace).not.toHaveBeenCalled();
    expect(localStorage.getItem("jobpilot_token")).toBe("valid-token");
  });

  it("explicit logout uses canonical cleanup and removes protected chrome", async () => {
    storeAuthToken("valid-token");
    render(<AppShell><p>Private dashboard</p></AppShell>);
    await screen.findByText("Private dashboard");

    await userEvent.click(screen.getByRole("button", { name: "Log out" }));

    expect(localStorage.getItem("jobpilot_token")).toBeNull();
    expect(screen.queryByText("Private dashboard")).not.toBeInTheDocument();
    expect(navigation.replace).toHaveBeenCalledWith("/login");
  });
});

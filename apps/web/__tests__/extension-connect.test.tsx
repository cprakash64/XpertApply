import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ConnectExtensionPage from "../app/extension/connect/page";
import { AUTH_TOKEN_STORAGE_KEY } from "../lib/authToken";

const REDIRECT = `https://${"a".repeat(32)}.chromiumapp.org/xpertapply`;
const CHALLENGE = "c".repeat(43);

function openWith(search: string) {
  window.history.replaceState({}, "", `/extension/connect${search}`);
}

describe("extension connect page", () => {
  const assign = vi.fn();
  beforeEach(() => {
    window.localStorage.clear();
    assign.mockReset();
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...window.location, assign, search: window.location.search, href: window.location.href }
    });
  });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it("refuses a request whose redirect is not an extension origin", () => {
    window.localStorage.setItem(AUTH_TOKEN_STORAGE_KEY, "tok");
    Object.defineProperty(window.location, "search", { configurable: true, value: `?challenge=${CHALLENGE}&redirect_uri=${encodeURIComponent("https://evil.example/cb")}` });
    render(<ConnectExtensionPage />);
    expect(screen.getByText(/not a valid extension connection request/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /connect extension/i })).toBeNull();
  });

  it("asks a signed-out visitor to sign in first and offers no approval", () => {
    Object.defineProperty(window.location, "search", { configurable: true, value: `?challenge=${CHALLENGE}&redirect_uri=${encodeURIComponent(REDIRECT)}&state=s1` });
    render(<ConnectExtensionPage />);
    expect(screen.getByText(/sign in to xpertapply first/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /connect extension/i })).toBeNull();
  });

  it("mints a code only after the user approves, and returns it to the extension with the state", async () => {
    window.localStorage.setItem(AUTH_TOKEN_STORAGE_KEY, "website-token");
    Object.defineProperty(window.location, "search", { configurable: true, value: `?challenge=${CHALLENGE}&redirect_uri=${encodeURIComponent(REDIRECT)}&state=s1` });
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ code: "the-code" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    render(<ConnectExtensionPage />);
    expect(fetchMock).not.toHaveBeenCalled();             // nothing is granted by merely opening the page
    fireEvent.click(await screen.findByRole("button", { name: /connect extension/i }));
    await waitFor(() => expect(assign).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toMatch(/\/extension\/auth\/code$/);
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer website-token");
    expect(JSON.parse(String(init.body))).toEqual({ code_challenge: CHALLENGE, redirect_uri: REDIRECT });
    const target = new URL(String(assign.mock.calls[0][0]));
    expect(target.origin + target.pathname).toBe(REDIRECT);
    expect(target.searchParams.get("code")).toBe("the-code");
    expect(target.searchParams.get("state")).toBe("s1");
    // The website token itself is never handed to the extension.
    expect(String(assign.mock.calls[0][0])).not.toContain("website-token");
  });
});

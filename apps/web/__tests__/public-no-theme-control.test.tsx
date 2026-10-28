/**
 * The public website is always light, so no public surface offers a theme choice:
 * not the info pages' header, not login or signup. (The navbar is covered in the
 * homepage tests; the signed-in app keeps its control.)
 */
import { cleanup, render, screen } from "@testing-library/react";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthDialog } from "../components/AuthDialog";
import { PublicPage } from "../components/PublicPage";
import { publicViewport } from "../lib/publicViewport";
import { viewport as homeViewport } from "../app/page";
import { viewport as loginViewport } from "../app/login/page";
import { viewport as signupViewport } from "../app/signup/page";
import { viewport as pricingViewport } from "../app/pricing/page";
import { viewport as privacyViewport } from "../app/privacy/page";
import { viewport as openSourceViewport } from "../app/opensource/page";
import { viewport as forgotViewport } from "../app/forgot-password/page";
import { viewport as resetViewport } from "../app/reset-password/page";
import { viewport as callbackViewport } from "../app/auth/google/callback/layout";
import { viewport as rootViewport } from "../app/layout";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }), usePathname: () => "/" }));

afterEach(cleanup);

describe("public surfaces carry no theme switcher", () => {
  it.each(["login", "signup"] as const)("%s page", (mode) => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ google: { enabled: false } })));
    render(React.createElement(AuthDialog, { initialMode: mode, presentation: "page" }));
    expect(screen.queryByRole("radiogroup")).toBeNull();
    expect(screen.queryByRole("radio")).toBeNull();
  });

  it("info pages (pricing, privacy, open source)", () => {
    render(React.createElement(PublicPage, { title: "Pricing" }));
    expect(screen.queryByRole("radiogroup")).toBeNull();
    expect(screen.getByRole("link", { name: /Get started/ })).toHaveAttribute("href", "/signup");
  });

  it("declares a light viewport so the browser canvas and tab colour are light", () => {
    expect(publicViewport.colorScheme).toBe("light");
    expect(publicViewport.themeColor).toBe("#ffffff");
  });

  it("every public route opts into it, while the root layout keeps both schemes for the app", () => {
    for (const viewport of [homeViewport, loginViewport, signupViewport, pricingViewport, privacyViewport, openSourceViewport, callbackViewport, forgotViewport, resetViewport]) {
      expect(viewport).toBe(publicViewport);
    }
    expect(rootViewport.colorScheme).toBe("light dark");
  });
});

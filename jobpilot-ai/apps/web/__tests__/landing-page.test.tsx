/**
 * The public landing page.
 *
 * Two properties matter most here and are easy to regress:
 *
 *   1. It is PUBLIC. Rendering it must not touch the API — a signed-out visitor
 *      has no token, and a stray authenticated fetch would both fail and leak
 *      the fact that we tried.
 *   2. The Install-extension CTA must never become a dead link. It has exactly
 *      two legitimate shapes — a real Chrome Web Store link, or an explicitly
 *      unavailable control — and which one appears is decided by configuration
 *      alone, so publishing the extension needs no code change.
 */
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import HomePage, { metadata as landingMetadata } from "../app/page";
import { metadata as rootMetadata } from "../app/layout";

const STORE_URL = "https://chromewebstore.google.com/detail/ezjobfind/abcdefghijklmnopabcdefghijklmnop";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() })
}));

function renderLanding() {
  return render(React.createElement(HomePage));
}

describe("landing page", () => {
  beforeEach(() => {
    cleanup();
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("carries EZJobFind branding and never the retired name", () => {
    renderLanding();

    expect(screen.getByRole("link", { name: "EZJobFind home" })).toHaveAttribute("href", "/");
    expect(screen.getByText(/©\s*\d{4}\s*EZJobFind/)).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/JobPilot/i);
  });

  /*
   * Guards a defect this page actually shipped once: JSX ate the space around an
   * interpolated {PRODUCT_NAME} mid-paragraph and rendered "EZJobFindChrome
   * extension". Nothing about the brand name should ever be glued to the next
   * word.
   */
  it("never runs the brand name into the following word", () => {
    const { container } = renderLanding();

    // Prose elements only. Whole-body textContent would concatenate separate
    // elements ("EZJobFind" + "Features" in the nav) and report a false break.
    for (const el of container.querySelectorAll("p, h1, h2, h3")) {
      expect(el.textContent, el.textContent ?? "").not.toMatch(/EZJobFind[A-Za-z]/);
    }
    expect(container.textContent).toContain("EZJobFind Chrome extension");
  });

  it("leads with the hero headline, primary signup CTA, and the human-in-the-loop promise", () => {
    renderLanding();

    const heading = screen.getByRole("heading", { level: 1 });
    expect(heading).toHaveTextContent("Your job search, from discovery to application.");

    expect(screen.getByRole("link", { name: /Get started free/ })).toHaveAttribute("href", "/signup");
    expect(
      screen.getByText("You review every application before submission.")
    ).toBeInTheDocument();
  });

  it("points every auth CTA at a route that exists", () => {
    renderLanding();

    for (const link of screen.getAllByRole("link", { name: /^Sign in$/ })) {
      expect(link).toHaveAttribute("href", "/login");
    }
    expect(screen.getByRole("link", { name: /Create your profile/ })).toHaveAttribute(
      "href",
      "/signup"
    );
    // The footer links Privacy because /privacy exists. Terms does not exist
    // yet, so it must not be linked at all rather than 404.
    expect(screen.getByRole("link", { name: "Privacy" })).toHaveAttribute("href", "/privacy");
    expect(screen.queryByRole("link", { name: /^Terms$/ })).not.toBeInTheDocument();
  });

  it("renders every section the navigation scrolls to", () => {
    const { container } = renderLanding();

    for (const id of ["features", "how-it-works", "extension", "security"]) {
      expect(container.querySelector(`#${id}`)).not.toBeNull();
    }

    expect(
      screen.getByRole("heading", { name: "Everything you need for the job search" })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "From first search to final follow-up" })
    ).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Built for a global job search" })).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Maintain your career information once" })
    ).toBeInTheDocument();
  });

  it("describes the capabilities that actually ship", () => {
    renderLanding();

    for (const capability of [
      "Job discovery",
      "Fit intelligence",
      "Tailored resumes",
      "Cover letters",
      "Application autofill",
      "Application tracking",
      "People who can help",
      "Reusable career profile"
    ]) {
      expect(screen.getByRole("heading", { name: capability })).toBeInTheDocument();
    }

    // Eight numbered steps, in order.
    const steps = screen.getAllByText(/^0[1-8]$/).map((node) => node.textContent);
    expect(steps).toEqual(["01", "02", "03", "04", "05", "06", "07", "08"]);
  });

  it("does not fetch anything while rendering", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    renderLanding();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  describe("Install extension CTA", () => {
    it("opens the configured Chrome Web Store listing safely in a new tab", () => {
      vi.stubEnv("NEXT_PUBLIC_CHROME_EXTENSION_URL", STORE_URL);
      renderLanding();

      const links = screen.getAllByRole("link", { name: /Install/ });
      expect(links.length).toBeGreaterThan(0);
      for (const link of links) {
        expect(link).toHaveAttribute("href", STORE_URL);
        expect(link).toHaveAttribute("target", "_blank");
        expect(link).toHaveAttribute("rel", "noopener noreferrer");
      }

      expect(screen.queryByText(/coming soon/i)).not.toBeInTheDocument();
    });

    it("falls back to an announced unavailable state instead of a dead link", () => {
      renderLanding();

      const unavailable = screen.getAllByRole("button", { name: /coming soon/i });
      expect(unavailable.length).toBeGreaterThan(0);
      for (const control of unavailable) {
        expect(control).toHaveAttribute("aria-disabled", "true");
        // Focusable on purpose: a `disabled` button leaves the tab order and
        // would never be announced at all.
        expect(control).not.toHaveAttribute("disabled");
      }

      expect(screen.queryByRole("link", { name: /Install/ })).not.toBeInTheDocument();
      expect(
        screen.getAllByText(/not published to the Chrome Web Store yet/i).length
      ).toBeGreaterThan(0);
    });

    it("ignores a configured URL that is not a Chrome Web Store listing", () => {
      vi.stubEnv("NEXT_PUBLIC_CHROME_EXTENSION_URL", "https://example.com/definitely-not-the-store");
      renderLanding();

      expect(screen.queryByRole("link", { name: /Install/ })).not.toBeInTheDocument();
      expect(screen.getAllByRole("button", { name: /coming soon/i }).length).toBeGreaterThan(0);
    });
  });

  describe("mobile navigation", () => {
    it("opens and closes by keyboard, exposing the same destinations", async () => {
      const { container } = renderLanding();

      const toggle = screen.getByRole("button", { name: "Open menu" });
      expect(toggle).toHaveAttribute("aria-expanded", "false");
      expect(container.querySelector("#landing-mobile-menu")).toBeNull();

      // Keyboard only — no pointer events anywhere in this test.
      toggle.focus();
      await userEvent.keyboard("{Enter}");

      const panel = container.querySelector("#landing-mobile-menu");
      expect(panel).not.toBeNull();
      expect(screen.getByRole("button", { name: "Close menu" })).toHaveAttribute(
        "aria-expanded",
        "true"
      );

      const panelLinks = within(panel as HTMLElement)
        .getAllByRole("link")
        .map((link) => link.getAttribute("href"));
      expect(panelLinks).toEqual([
        "#features",
        "#how-it-works",
        "#extension",
        "#security",
        "/login",
        "/signup"
      ]);

      await userEvent.keyboard("{Escape}");
      expect(container.querySelector("#landing-mobile-menu")).toBeNull();
      expect(screen.getByRole("button", { name: "Open menu" })).toHaveAttribute(
        "aria-expanded",
        "false"
      );
    });

    it("closes after a section link is chosen", async () => {
      const { container } = renderLanding();

      await userEvent.click(screen.getByRole("button", { name: "Open menu" }));
      const panel = container.querySelector("#landing-mobile-menu") as HTMLElement;
      await userEvent.click(within(panel).getByRole("link", { name: "Extension" }));

      expect(container.querySelector("#landing-mobile-menu")).toBeNull();
    });
  });
});

describe("product metadata", () => {
  it("advertises EZJobFind, not the retired name", () => {
    expect(rootMetadata.applicationName).toBe("EZJobFind");
    expect(JSON.stringify(rootMetadata)).not.toMatch(/JobPilot/i);
    expect(landingMetadata.title).toEqual({
      absolute: "EZJobFind — Find, Prepare, and Apply Smarter"
    });
  });

  it("uses the production domain as the canonical identity by default", () => {
    expect(String(rootMetadata.metadataBase)).toContain("ezjobfind.com");
    expect(landingMetadata.alternates?.canonical).toBe("https://ezjobfind.com");
  });
});

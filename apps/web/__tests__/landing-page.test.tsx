/**
 * The public marketing homepage.
 *
 * The properties asserted here are the ones that are easy to regress and
 * expensive to get wrong:
 *
 *   1. It is PUBLIC. Rendering it must not touch the API — a signed-out visitor
 *      has no token, and a stray authenticated fetch would both fail and leak
 *      the fact that we tried.
 *   2. Every destination resolves. No fabricated route, and no dead
 *      Install-extension link: that CTA has exactly two legitimate shapes and
 *      which one appears is decided by configuration alone.
 *   3. The control story survives. "No auto-submit", the review promise, and the
 *      six-stage workflow are product claims, not decoration.
 *   4. The pricing overlay behaves like a dialog.
 */
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import HomePage, { metadata as landingMetadata } from "../app/page";
import { metadata as rootMetadata } from "../app/layout";
import { WORKFLOW_STAGES } from "../components/marketing/workflowStages";

const STORE_URL = "https://chromewebstore.google.com/detail/xpertapply/abcdefghijklmnopabcdefghijklmnop";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() })
}));

/*
 * jsdom implements neither observer. The page uses IntersectionObserver for
 * stage activation and ResizeObserver to re-measure the rail; both are guarded
 * in the component, but stubbing them here exercises the real code path rather
 * than the fallback.
 */
class NoopObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return [];
  }
}

function renderLanding() {
  return render(React.createElement(HomePage));
}

describe("marketing homepage", () => {
  beforeEach(() => {
    cleanup();
    vi.unstubAllEnvs();
    vi.stubGlobal("IntersectionObserver", NoopObserver);
    vi.stubGlobal("ResizeObserver", NoopObserver);
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      cb(0);
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {});
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("carries XpertApply branding and never the retired name", () => {
    renderLanding();

    expect(screen.getByRole("link", { name: "XpertApply home" })).toHaveAttribute("href", "/");
    expect(screen.getByText(/©\s*\d{4}\s*XpertApply/)).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/JobPilot/i);
    expect(document.body.textContent).not.toMatch(/EZ\s?Job\s?Find/i);
  });

  /*
   * The wordmark's two halves must never collapse into one colour. They are
   * separate elements carrying separate classes, and a single accessible name
   * sits alongside them so a screen reader hears "XpertApply", not "Xpert
   * Apply".
   */
  it("renders the wordmark in two brand colours with one accessible name", () => {
    const { container } = renderLanding();

    const xpert = container.querySelectorAll(".xa-wordmark__xpert");
    const apply = container.querySelectorAll(".xa-wordmark__apply");
    expect(xpert.length).toBeGreaterThan(0);
    expect(xpert.length).toBe(apply.length);
    for (const half of xpert) expect(half.textContent).toBe("Xpert");
    for (const half of apply) expect(half.textContent).toBe("Apply");
  });

  it("never runs the brand name into the following word", () => {
    const { container } = renderLanding();

    for (const el of container.querySelectorAll("p, h1, h2, h3")) {
      expect(el.textContent, el.textContent ?? "").not.toMatch(/XpertApply[A-Za-z]/);
    }
  });

  it("leads with the editorial hero, its CTAs, and the control promises", () => {
    renderLanding();

    const heading = screen.getByRole("heading", { level: 1 });
    expect(heading).toHaveTextContent("Find the right job.Apply with confidence.");

    expect(screen.getAllByRole("link", { name: /Get started free/ })[0]).toHaveAttribute(
      "href",
      "/signup"
    );
    expect(screen.getByRole("link", { name: /See XpertApply in action/ })).toHaveAttribute(
      "href",
      "#story"
    );

    for (const promise of [
      "No auto-submit",
      "You stay in control",
      "One profile across applications"
    ]) {
      expect(screen.getByText(promise)).toBeInTheDocument();
    }
  });

  it("points every auth CTA at a route that exists", () => {
    renderLanding();

    for (const link of screen.getAllByRole("link", { name: /^Sign in$/ })) {
      expect(link).toHaveAttribute("href", "/login");
    }
    for (const link of screen.getAllByRole("link", { name: /Get started/ })) {
      expect(link).toHaveAttribute("href", "/signup");
    }
    expect(screen.getByRole("link", { name: "Privacy" })).toHaveAttribute("href", "/privacy");
    expect(screen.getAllByRole("link", { name: "Extension" }).at(-1)).toHaveAttribute(
      "href",
      "#extension"
    );
    // No /terms route exists, so Terms remains text rather than a dead link.
    expect(screen.queryByRole("link", { name: /^Terms$/ })).not.toBeInTheDocument();
    expect(screen.getByText("Terms")).toBeInTheDocument();
  });

  /*
   * Guards the footer against the usual marketing-template links. Every in-page
   * anchor must have a matching element, and no link may point at a route this
   * app does not serve.
   */
  it("links only to destinations that exist", () => {
    const { container } = renderLanding();
    const routes = new Set(["/", "/login", "/signup", "/privacy"]);

    for (const link of container.querySelectorAll("a[href]")) {
      const href = link.getAttribute("href") as string;
      if (href.startsWith("#")) {
        expect(container.querySelector(href), `${href} has no target`).not.toBeNull();
      } else if (href.startsWith("/")) {
        expect(routes.has(href), `${href} is not a route in this app`).toBe(true);
      }
    }
  });

  it("renders every section the navigation scrolls to", () => {
    const { container } = renderLanding();

    for (const id of ["story", "extension", "security"]) {
      expect(container.querySelector(`#${id}`)).not.toBeNull();
    }

    expect(
      screen.getByRole("heading", { name: "From discovery to follow-up, it all stays connected." })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Stop filling out the same application over and over." })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Automation without losing control." })
    ).toBeInTheDocument();
  });

  describe("workflow story", () => {
    it("tells all six stages, in order, from one data source", () => {
      renderLanding();

      expect(WORKFLOW_STAGES.map((stage) => stage.number)).toEqual([
        "01",
        "02",
        "03",
        "04",
        "05",
        "06"
      ]);

      for (const stage of WORKFLOW_STAGES) {
        expect(screen.getByRole("heading", { name: stage.headline })).toBeInTheDocument();
        for (const benefit of stage.benefits) {
          expect(screen.getAllByText(benefit).length).toBeGreaterThan(0);
        }
      }
    });

    it("starts on Discover and marks it current in the controller", () => {
      const { container } = renderLanding();

      const controller = container.querySelector(".xa-controller") as HTMLElement;
      const current = within(controller)
        .getAllByRole("button")
        .filter((button) => button.getAttribute("aria-current") === "true");

      expect(current).toHaveLength(1);
      expect(current[0]).toHaveTextContent("Discover");
      expect(container.querySelector('.xa-stage[data-state="active"]')?.id).toBe(
        "stage-discover"
      );
    });

    it("moves the story when a controller stage is chosen", async () => {
      const scrollTo = vi.fn();
      vi.stubGlobal("scrollTo", scrollTo);
      const { container } = renderLanding();

      const controller = container.querySelector(".xa-controller") as HTMLElement;
      await userEvent.click(within(controller).getByRole("button", { name: "Track" }));

      expect(scrollTo).toHaveBeenCalledTimes(1);
      expect(scrollTo.mock.calls[0][0]).toMatchObject({ behavior: "smooth" });
    });

    it("uses the supplied extension-demo replacement caption", () => {
      renderLanding();
      expect(screen.getByText(/Replace this illustration with an 8–12 second recording/i)).toBeInTheDocument();
    });
  });

  it("does not fetch anything while rendering", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    renderLanding();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  describe("Add to Chrome CTA", () => {
    it("keeps the extension section focused on one primary action", () => {
      renderLanding();

      expect(screen.queryByRole("link", { name: /See how it works/i })).not.toBeInTheDocument();
    });

    it("opens the configured Chrome Web Store listing safely in a new tab", () => {
      vi.stubEnv("NEXT_PUBLIC_CHROME_EXTENSION_URL", STORE_URL);
      renderLanding();

      const link = screen.getByRole("link", { name: /Add to Chrome/ });
      expect(link).toHaveAttribute("href", STORE_URL);
      expect(link).toHaveAttribute("target", "_blank");
      expect(link).toHaveAttribute("rel", "noopener noreferrer");
      expect(screen.queryByText(/coming soon/i)).not.toBeInTheDocument();
    });

    it("falls back to an announced unavailable state instead of a dead link", () => {
      renderLanding();

      const control = screen.getByRole("button", { name: /Add to Chrome.*not available yet/i });
      expect(control).toHaveAttribute("aria-disabled", "true");
      // Focusable on purpose: a `disabled` button leaves the tab order and would
      // never be announced at all.
      expect(control).not.toHaveAttribute("disabled");
      expect(screen.queryByRole("link", { name: /Add to Chrome/ })).not.toBeInTheDocument();
      expect(screen.getByText(/not published to the Chrome Web Store yet/i)).toBeInTheDocument();
    });

    it("ignores a configured URL that is not a Chrome Web Store listing", () => {
      vi.stubEnv("NEXT_PUBLIC_CHROME_EXTENSION_URL", "https://example.com/definitely-not-the-store");
      renderLanding();

      expect(screen.queryByRole("link", { name: /Add to Chrome/ })).not.toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: /Add to Chrome.*not available yet/i })
      ).toBeInTheDocument();
    });
  });

  describe("pricing dialog", () => {
    it("opens from the navigation as a modal dialog and closes on Escape", async () => {
      renderLanding();

      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

      await userEvent.click(screen.getAllByRole("button", { name: "Pricing" })[0]);

      const dialog = screen.getByRole("dialog");
      expect(dialog).toHaveAttribute("aria-modal", "true");
      expect(dialog).toHaveAccessibleName("Pick the level of help you need.");
      // The page behind must not scroll under the overlay.
      expect(document.body.style.overflow).toBe("hidden");

      for (const plan of ["Free", "Pro", "Pro + Outreach"]) {
        expect(within(dialog).getByText(plan)).toBeInTheDocument();
      }
      expect(within(dialog).getByText("$0")).toBeInTheDocument();
      expect(within(dialog).getByText("$4.99")).toBeInTheDocument();
      expect(within(dialog).getByText("$9.99")).toBeInTheDocument();

      await userEvent.keyboard("{Escape}");
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(document.body.style.overflow).toBe("");
    });

    /*
     * The overlay renders as a SIBLING of the page element, so it does not
     * inherit the brand tokens declared there. Without `xa-theme` on its own
     * root every var() inside it resolves to nothing and the primary plan
     * button renders white-on-white — a defect this page actually shipped once
     * in review.
     */
    it("carries the brand token scope on its own root", async () => {
      renderLanding();

      await userEvent.click(screen.getAllByRole("button", { name: "Pricing" })[0]);
      expect(document.querySelector(".xa-pricing__backdrop")).toHaveClass("xa-theme");
    });

    it("closes from its own close button", async () => {
      renderLanding();

      await userEvent.click(screen.getAllByRole("button", { name: "Pricing" })[0]);
      await userEvent.click(screen.getByRole("button", { name: "Close pricing" }));

      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    it("sends every plan to the real signup route", async () => {
      renderLanding();

      await userEvent.click(screen.getAllByRole("button", { name: "Pricing" })[0]);
      const dialog = screen.getByRole("dialog");

      const ctas = within(dialog).getAllByRole("link");
      expect(ctas).toHaveLength(3);
      for (const cta of ctas) expect(cta).toHaveAttribute("href", "/signup");
    });
  });

  describe("mobile navigation", () => {
    it("opens and closes by keyboard, exposing the same destinations", async () => {
      const { container } = renderLanding();

      const toggle = screen.getByRole("button", { name: "Open menu" });
      expect(toggle).toHaveAttribute("aria-expanded", "false");
      expect(container.querySelector("#xa-mobile-menu")).toBeNull();

      toggle.focus();
      await userEvent.keyboard("{Enter}");

      const panel = container.querySelector("#xa-mobile-menu") as HTMLElement;
      expect(panel).not.toBeNull();
      expect(screen.getByRole("button", { name: "Close menu" })).toHaveAttribute(
        "aria-expanded",
        "true"
      );
      expect(
        within(panel)
          .getAllByRole("link")
          .map((link) => link.getAttribute("href"))
      ).toEqual(["#story", "#extension", "#security", "/login", "/signup"]);

      await userEvent.keyboard("{Escape}");
      expect(container.querySelector("#xa-mobile-menu")).toBeNull();
    });

    it("closes after a section link is chosen", async () => {
      const { container } = renderLanding();

      await userEvent.click(screen.getByRole("button", { name: "Open menu" }));
      const panel = container.querySelector("#xa-mobile-menu") as HTMLElement;
      await userEvent.click(within(panel).getByRole("link", { name: "Extension" }));

      expect(container.querySelector("#xa-mobile-menu")).toBeNull();
    });
  });
});

describe("product metadata", () => {
  it("advertises XpertApply, not a retired name", () => {
    expect(rootMetadata.applicationName).toBe("XpertApply");
    const serialized = JSON.stringify(rootMetadata);
    expect(serialized).not.toMatch(/JobPilot/i);
    expect(serialized).not.toMatch(/EZ\s?Job\s?Find/i);
  });

  it("states the homepage's own positioning", () => {
    expect(landingMetadata.title).toEqual({
      absolute: "XpertApply — Find the right job. Apply with confidence."
    });
    expect(landingMetadata.description).toContain("Discover better-fit jobs");
    expect(landingMetadata.openGraph?.title).toBe(
      "XpertApply — Find the right job. Apply with confidence."
    );
  });

  it("keeps the shared title template and canonical identity", () => {
    expect(rootMetadata.title).toMatchObject({
      default: "XpertApply | AI Job Application Copilot",
      template: "%s · XpertApply"
    });
    expect(String(rootMetadata.metadataBase)).toContain("xpertapply.com");
    expect(landingMetadata.alternates?.canonical).toBe("https://xpertapply.com");
  });
});

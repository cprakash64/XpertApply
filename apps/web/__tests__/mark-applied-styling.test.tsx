import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { MarkAppliedDialog } from "../components/jobs/MarkAppliedDialog";

/** Read a repo file relative to apps/web (vitest runs with that as cwd). */
function readSource(relative: string): string {
  return readFileSync(resolve(process.cwd(), relative), "utf8");
}

/**
 * The manual "Mark as applied" action: green, prominent, keyboard-reachable,
 * and safe against duplicate clicks.
 *
 * These assert on the shared `mark-applied-action` class rather than on literal
 * colours, because the colour comes from the `--success*` theme tokens and must
 * keep following light/dark. A hard-coded hex here would pass while the button
 * was invisible in dark mode.
 */

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function renderDialog(overrides: Partial<React.ComponentProps<typeof MarkAppliedDialog>> = {}) {
  const props = {
    jobTitle: "Machine Learning Engineer",
    company: "Acme AI",
    submitting: false,
    error: "",
    onConfirm: vi.fn(),
    onCancel: vi.fn(),
    ...overrides
  };
  return { ...render(<MarkAppliedDialog {...props} />), props };
}

describe("mark-applied-action styling contract", () => {
  it("is defined once in the theme and built from success tokens", async () => {
    const css = readSource("app/globals.css");

    const block = css.slice(css.indexOf(".mark-applied-action {"));
    expect(block).toContain("var(--success-border)");
    expect(block).toContain("var(--success-surface)");
    expect(block).toContain("var(--success)");

    // Hover strengthens to a solid green with a paired foreground.
    expect(css).toMatch(/\.mark-applied-action:hover:not\(:disabled\)\s*\{[^}]*var\(--success\)/);
    expect(css).toMatch(/\.mark-applied-action:hover:not\(:disabled\)\s*\{[^}]*var\(--accent-foreground\)/);
    // Keyboard focus is visible.
    expect(css).toMatch(/\.mark-applied-action:focus-visible\s*\{[^}]*var\(--focus-ring\)/);
    // Disabled is visually distinct so the loading state reads as inert.
    expect(css).toMatch(/\.mark-applied-action:disabled\s*\{[^}]*cursor:\s*not-allowed/);
  });

  it("never hard-codes a green hex on the action itself", async () => {
    for (const file of ["components/jobs/JobDetailPanel.tsx", "components/AutoApplyModal.tsx"]) {
      const source = readSource(file);
      const line = source
        .split("\n")
        .find((entry) => entry.includes("mark-applied-action"));
      expect(line, `${file} should use the shared class`).toBeTruthy();
      expect(line).not.toMatch(/#[0-9a-f]{3,8}/i);
      expect(line).not.toMatch(/\bbg-(green|emerald|lime)-/);
    }
  });

  it("keeps the visible label inside the accessible name (WCAG 2.5.3)", () => {
    // A label like "Mark <job> at <company> as applied" reads fine to a screen
    // reader but leaves voice-control users unable to say what they can see.
    for (const file of ["components/jobs/JobDetailPanel.tsx", "components/AutoApplyModal.tsx"]) {
      const source = readSource(file);
      const label = source.match(/aria-label=\{`(Mark[^`]*)`\}/)?.[1];
      expect(label, `${file} should label the mark-applied action`).toBeTruthy();
      expect(label!.startsWith("Mark as applied"), `${file}: ${label}`).toBe(true);
    }
  });

  it("uses the same shared class in every place the action appears", async () => {
    const panel = readSource("components/jobs/JobDetailPanel.tsx");
    const modal = readSource("components/AutoApplyModal.tsx");
    expect(panel).toContain("mark-applied-action");
    expect(modal).toContain("mark-applied-action");
    // Both expose the same test hook, so a future third location is obvious.
    expect(panel).toContain('data-testid="mark-applied-action"');
    expect(modal).toContain('data-testid="mark-applied-action"');
  });
});

describe("confirmation dialog accessibility and states", () => {
  it("is a labelled modal dialog", () => {
    renderDialog();
    const dialog = screen.getByRole("dialog", { name: /confirm application submitted/i });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
  });

  it("focuses the confirm action so it is reachable by keyboard alone", async () => {
    renderDialog();
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByTestId("mark-applied-confirm"))
    );
  });

  it("can be confirmed with the keyboard", async () => {
    const { props } = renderDialog();
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByTestId("mark-applied-confirm"))
    );
    await userEvent.keyboard("{Enter}");
    expect(props.onConfirm).toHaveBeenCalledTimes(1);
  });

  it("cancels on Escape without confirming", async () => {
    const { props } = renderDialog();
    await userEvent.keyboard("{Escape}");
    expect(props.onCancel).toHaveBeenCalledTimes(1);
    expect(props.onConfirm).not.toHaveBeenCalled();
  });

  it("shows an explicit loading label and disables both actions while submitting", () => {
    renderDialog({ submitting: true });
    const confirm = screen.getByTestId("mark-applied-confirm");
    expect(confirm).toHaveProperty("disabled", true);
    expect(confirm.getAttribute("aria-busy")).toBe("true");
    expect(confirm.textContent).toMatch(/marking as applied/i);
    expect(screen.getByRole("button", { name: /not yet/i })).toHaveProperty("disabled", true);
  });

  it("cannot be double-submitted while a request is in flight", async () => {
    const { props } = renderDialog({ submitting: true });
    const confirm = screen.getByTestId("mark-applied-confirm");
    await userEvent.click(confirm).catch(() => undefined);
    await userEvent.click(confirm).catch(() => undefined);
    expect(props.onConfirm).not.toHaveBeenCalled();
  });

  it("does not cancel on Escape mid-request", async () => {
    const { props } = renderDialog({ submitting: true });
    await userEvent.keyboard("{Escape}");
    expect(props.onCancel).not.toHaveBeenCalled();
  });

  it("announces a failure through an alert", () => {
    renderDialog({ error: "Could not mark this application as applied." });
    expect(screen.getByRole("alert").textContent).toMatch(/could not mark this application/i);
  });
});

/* eslint-disable @next/next/no-html-link-for-pages --
 * The harness below uses raw anchors on purpose. The guard works by
 * intercepting anchor clicks in the capture phase, and `next/link` renders a
 * plain <a> at runtime, so a raw anchor is exactly what it sees in production —
 * and it needs no router context to render.
 */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React, { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UnsavedChangesDialog } from "@/components/profile/UnsavedChangesDialog";
import { useUnsavedChangesGuard } from "@/lib/useUnsavedChangesGuard";

const routerPush = vi.fn();
const routerBack = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: routerPush, back: routerBack, replace: vi.fn(), prefetch: vi.fn() })
}));

/** A minimal editor: a dirty flag, an anchor to leave by, and the guard. */
function Harness({
  onSave,
  startDirty = true
}: {
  onSave?: () => Promise<void>;
  startDirty?: boolean;
}) {
  const [dirty, setDirty] = useState(startDirty);
  const guard = useUnsavedChangesGuard({
    dirty,
    onSave,
    onDiscard: () => setDirty(false)
  });
  return (
    <div>
      <a href="/profile">Back to profile</a>
      <a href="/jobs">Jobs</a>
      <a href="https://example.com/external">External</a>
      <a href="/downloads/cv.pdf" download>
        Download
      </a>
      <button type="button" onClick={() => setDirty(false)}>
        make clean
      </button>
      <UnsavedChangesDialog guard={guard} />
    </div>
  );
}

describe("useUnsavedChangesGuard", () => {
  beforeEach(() => {
    routerPush.mockClear();
    routerBack.mockClear();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  // ------------------------------------------------------------------ //
  // Clean state
  // ------------------------------------------------------------------ //
  it("does not warn when there is nothing to lose", async () => {
    const user = userEvent.setup();
    render(<Harness startDirty={false} />);

    await user.click(screen.getByRole("link", { name: "Back to profile" }));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  it("registers beforeunload only while dirty", async () => {
    const addSpy = vi.spyOn(window, "addEventListener");
    const removeSpy = vi.spyOn(window, "removeEventListener");

    const user = userEvent.setup();
    render(<Harness />);
    expect(addSpy.mock.calls.some(([name]) => name === "beforeunload")).toBe(true);

    // Going clean must tear the native prompt back down.
    await user.click(screen.getByRole("button", { name: "make clean" }));
    await waitFor(() =>
      expect(removeSpy.mock.calls.some(([name]) => name === "beforeunload")).toBe(true)
    );
  });

  // ------------------------------------------------------------------ //
  // Dirty state
  // ------------------------------------------------------------------ //
  it("intercepts an in-app link and shows the dialog", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(screen.getByRole("link", { name: "Back to profile" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("Unsaved changes");
    expect(dialog).toHaveTextContent("You have changes that haven’t been saved yet.");
    // Nothing navigated.
    expect(routerPush).not.toHaveBeenCalled();
  });

  it("intercepts sidebar-style navigation to any other section", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole("link", { name: "Jobs" }));
    expect(await screen.findByRole("alertdialog")).toBeInTheDocument();
  });

  it("intercepts browser back", async () => {
    render(<Harness />);
    window.dispatchEvent(new PopStateEvent("popstate"));
    expect(await screen.findByRole("alertdialog")).toBeInTheDocument();
  });

  it("leaves external links and downloads to the browser", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(screen.getByRole("link", { name: "External" }));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();

    await user.click(screen.getByRole("link", { name: "Download" }));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  it("leaves modified clicks alone so open-in-new-tab still works", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.keyboard("{Meta>}");
    await user.click(screen.getByRole("link", { name: "Back to profile" }));
    await user.keyboard("{/Meta}");
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  // ------------------------------------------------------------------ //
  // Dialog actions
  // ------------------------------------------------------------------ //
  it("Keep editing closes the dialog and stays put", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole("link", { name: "Back to profile" }));
    await screen.findByRole("alertdialog");

    await user.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(routerPush).not.toHaveBeenCalled();
  });

  it("Escape maps to Keep editing, never to discarding work", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole("link", { name: "Back to profile" }));
    await screen.findByRole("alertdialog");

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(routerPush).not.toHaveBeenCalled();
  });

  it("Discard changes navigates to the requested destination", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole("link", { name: "Back to profile" }));
    await screen.findByRole("alertdialog");

    await user.click(screen.getByRole("button", { name: "Discard changes" }));
    await waitFor(() => expect(routerPush).toHaveBeenCalledWith("/profile"));
  });

  it("Save changes navigates only after the server confirms", async () => {
    const user = userEvent.setup();
    const order: string[] = [];
    const onSave = vi.fn(async () => {
      order.push("save");
    });
    render(<Harness onSave={onSave} />);
    await user.click(screen.getByRole("link", { name: "Back to profile" }));
    await screen.findByRole("alertdialog");

    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(routerPush).toHaveBeenCalledWith("/profile"));
    expect(onSave).toHaveBeenCalledTimes(1);
    order.push("navigate");
    expect(order).toEqual(["save", "navigate"]);
  });

  it("keeps the user on the page when the save fails", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn(async () => {
      throw new Error("Server said no.");
    });
    render(<Harness onSave={onSave} />);
    await user.click(screen.getByRole("link", { name: "Back to profile" }));
    await screen.findByRole("alertdialog");

    await user.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByText("Server said no.")).toBeInTheDocument();
    // Still on the page, dialog still open, edits still there.
    expect(routerPush).not.toHaveBeenCalled();
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
  });

  it("blocks duplicate submits while saving", async () => {
    const user = userEvent.setup();
    let release: () => void = () => {};
    const onSave = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        })
    );
    render(<Harness onSave={onSave} />);
    await user.click(screen.getByRole("link", { name: "Back to profile" }));
    await screen.findByRole("alertdialog");

    const save = screen.getByRole("button", { name: "Save changes" });
    await user.click(save);
    expect(await screen.findByRole("button", { name: /Saving/ })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: /Saving/ }));
    expect(onSave).toHaveBeenCalledTimes(1);

    release();
    await waitFor(() => expect(routerPush).toHaveBeenCalled());
  });

  // ------------------------------------------------------------------ //
  // Accessibility
  // ------------------------------------------------------------------ //
  it("is an alertdialog with an accessible name and description", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole("link", { name: "Back to profile" }));

    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toHaveAccessibleName("Unsaved changes");
    expect(dialog).toHaveAccessibleDescription("You have changes that haven’t been saved yet.");
  });

  it("focuses the non-destructive action on open", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole("link", { name: "Back to profile" }));
    await screen.findByRole("alertdialog");

    // A stray Enter must not discard anything.
    expect(screen.getByRole("button", { name: "Keep editing" })).toHaveFocus();
  });
});

import React, { useRef, useState } from "react";
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useDialogFocus } from "../lib/useDialogFocus";

function Dialog({ onClose }: { onClose: () => void }) {
  const ref = useRef<HTMLDivElement | null>(null);
  useDialogFocus(ref, onClose);
  return (
    <div ref={ref} role="dialog" aria-modal="true" aria-label="Test dialog">
      <button data-autofocus type="button">Close</button>
      <button type="button">Middle</button>
      <button type="button">Last</button>
    </div>
  );
}

function Harness() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>Open</button>
      {open && <Dialog onClose={() => setOpen(false)} />}
    </>
  );
}

function BusyOpener() {
  // Mimics "Resume": the button is disabled while work runs, so focus drops to <body> before the dialog mounts.
  const [state, setState] = useState<"idle" | "busy" | "open">("idle");
  return (
    <>
      <button type="button" disabled={state === "busy"} onClick={() => { setState("busy"); setTimeout(() => setState("open"), 10); }}>Generate</button>
      {state === "open" && <Dialog onClose={() => setState("idle")} />}
    </>
  );
}

describe("useDialogFocus", () => {
  it("returns focus to the opener even when it was disabled (focus on <body>) as the dialog mounted", async () => {
    render(<BusyOpener />);
    const opener = screen.getByRole("button", { name: "Generate" });
    await userEvent.click(opener);
    await screen.findByRole("dialog", { name: "Test dialog" });
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Generate" }));
  });

  it("moves focus in, wraps Tab, closes on Escape, and restores focus to the opener", async () => {
    render(<Harness />);
    const opener = screen.getByRole("button", { name: "Open" });
    await userEvent.click(opener);

    const dialog = screen.getByRole("dialog", { name: "Test dialog" });
    expect(dialog).toContainElement(document.activeElement as HTMLElement);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Close" }));

    await userEvent.tab();
    await userEvent.tab();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Last" }));
    await userEvent.tab(); // wraps to the first control, never leaves the dialog
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Close" }));
    await userEvent.tab({ shift: true }); // wraps backwards
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Last" }));

    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(document.activeElement).toBe(opener);
  });
});

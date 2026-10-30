import React, { useRef, useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useDialogFocus } from "../lib/useDialogFocus";

function Dialog({ onClose }: { onClose: () => void }) {
  const ref = useRef<HTMLDivElement | null>(null);
  useDialogFocus(ref, onClose);
  return (
    <div ref={ref} role="dialog" aria-modal="true" aria-label="Test dialog">
      <button data-autofocus type="button" onClick={onClose}>Close</button>
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
  afterEach(() => { cleanup(); document.body.innerHTML = ""; });
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

  describe("invoker recorded from the click (Safari/WebKit does not focus a button on mouse click)", () => {
    function Page({ extra }: { extra?: React.ReactNode }) {
      const [open, setOpen] = useState(false);
      return (
        <main>
          <input aria-label="Search" />
          <button type="button" onClick={() => setOpen(true)}>Open</button>
          {extra}
          {open && <Dialog onClose={() => setOpen(false)} />}
        </main>
      );
    }
    // fireEvent.click dispatches the click without moving focus, exactly like a Safari mouse click on a button.
    const safariClick = (el: HTMLElement) => fireEvent.click(el);

    it("restores focus to the clicked control when the click never focused it and nothing else had focus", async () => {
      render(<Page />);
      const opener = screen.getByRole("button", { name: "Open" });
      safariClick(opener);
      await screen.findByRole("dialog", { name: "Test dialog" });
      await userEvent.keyboard("{Escape}");
      expect(document.activeElement).toBe(opener);
      expect(document.activeElement).not.toBe(document.body);
    });

    it("restores focus to the clicked control, not to an unrelated control that held focus earlier", async () => {
      render(<Page />);
      const search = screen.getByRole("textbox", { name: "Search" });
      search.focus();
      const opener = screen.getByRole("button", { name: "Open" });
      safariClick(opener); // Safari: the click does not move focus off the search box
      await screen.findByRole("dialog", { name: "Test dialog" });
      await userEvent.keyboard("{Escape}");
      expect(document.activeElement).toBe(opener);
    });

    it("restores focus after the Close button as well", async () => {
      render(<Page />);
      const opener = screen.getByRole("button", { name: "Open" });
      safariClick(opener);
      await screen.findByRole("dialog", { name: "Test dialog" });
      await userEvent.click(screen.getByRole("button", { name: "Close" }));
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(document.activeElement).toBe(opener);
    });

    it("restores focus to a keyboard-activated opener (Enter and Space)", async () => {
      render(<Page />);
      const opener = screen.getByRole("button", { name: "Open" });
      opener.focus();
      await userEvent.keyboard("{Enter}");
      await screen.findByRole("dialog", { name: "Test dialog" });
      await userEvent.keyboard("{Escape}");
      expect(document.activeElement).toBe(opener);
      await userEvent.keyboard(" ");
      await screen.findByRole("dialog", { name: "Test dialog" });
      await userEvent.keyboard("{Escape}");
      expect(document.activeElement).toBe(opener);
    });

    it("falls back to the main landmark, never <body>, when the opener was removed while the dialog was open", async () => {
      function Removable() {
        const [show, setShow] = useState(true);
        const [open, setOpen] = useState(false);
        return (
          <main>
            {show && <button type="button" onClick={() => { setOpen(true); setTimeout(() => setShow(false), 0); }}>Open</button>}
            {open && <Dialog onClose={() => setOpen(false)} />}
          </main>
        );
      }
      render(<Removable />);
      safariClick(screen.getByRole("button", { name: "Open" }));
      await screen.findByRole("dialog", { name: "Test dialog" });
      await new Promise((r) => setTimeout(r, 10));
      expect(screen.queryByRole("button", { name: "Open" })).not.toBeInTheDocument();
      await userEvent.keyboard("{Escape}");
      expect(document.activeElement).toBe(document.querySelector("main"));
      expect(document.activeElement).not.toBe(document.body);
    });

    it("falls back to the main landmark when the opener stays disabled", async () => {
      function Stuck() {
        const [open, setOpen] = useState(false);
        const [off, setOff] = useState(false);
        return (
          <main>
            <button type="button" disabled={off} onClick={() => { setOpen(true); setOff(true); }}>Open</button>
            {open && <Dialog onClose={() => setOpen(false)} />}
          </main>
        );
      }
      render(<Stuck />);
      safariClick(screen.getByRole("button", { name: "Open" }));
      await screen.findByRole("dialog", { name: "Test dialog" });
      await userEvent.keyboard("{Escape}");
      expect(document.activeElement).toBe(document.querySelector("main"));
    });
  });
});

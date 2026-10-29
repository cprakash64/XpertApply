import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TrackerClient } from "../components/TrackerClient";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

const APPLICATIONS = [
  {
    id: 11,
    job_id: 101,
    status: "applied",
    applied_at: "2026-07-20T12:00:00Z",
    created_at: "2026-07-20T12:00:00Z",
    updated_at: "2026-07-20T12:00:00Z",
    job: {
      id: 101,
      title: "Software Engineer",
      company: "Acme",
      company_domain: "acme.com",
      company_logo_url: null,
      company_logo_proxy_path: null,
      location: "New York, NY",
      workplace_type: "hybrid",
      employment_type: "Full-time",
      posted_at: "2026-07-18T12:00:00Z",
      application_url: "https://careers.acme.com/101",
      match: { fit_score: 84 }
    }
  },
  {
    id: 12,
    job_id: 102,
    status: "interview",
    applied_at: "2026-07-19T12:00:00Z",
    created_at: "2026-07-19T12:00:00Z",
    updated_at: "2026-07-21T12:00:00Z",
    job: {
      id: 102,
      title: "Backend Engineer",
      company: "Northstar",
      company_domain: "northstar.dev",
      company_logo_url: null,
      company_logo_proxy_path: null,
      location: "Remote",
      workplace_type: "remote",
      employment_type: "Full-time",
      posted_at: "2026-07-17T12:00:00Z",
      application_url: "https://northstar.dev/jobs/102",
      match: { fit_score: 91 }
    }
  }
];

/** A row in the "Tracked applications" list (one button per application). */
const row = (title: string) => screen.findByRole("button", { name: new RegExp(title) });
const list = () => screen.getByRole("list", { name: "Tracked applications" });

describe("TrackerClient", () => {
  beforeEach(() => {
    localStorage.setItem("jobpilot_token", "token");
    sessionStorage.clear();
    vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      const url = String(input);
      if (url.endsWith("/jobs/tracker/submitted")) {
        return Promise.resolve(jsonResponse({ applications: APPLICATIONS }));
      }
      if (url.endsWith("/jobs/101/tracker") && init?.method === "PUT") {
        return Promise.resolve(
          jsonResponse({ tracker: { id: 11, job_id: 101, status: "offer" } })
        );
      }
      return Promise.resolve(jsonResponse({}));
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  /**
   * The Tracker used to render `ApiError.message` verbatim. That message is
   * whatever the transport normalized — for `/jobs/tracker/*` that is either
   * the API's safe catch-all or an infrastructure `detail` written for an
   * operator (the shared auth dependency answers a database outage by naming
   * the migration command to run). Neither belongs in a banner above someone's
   * application list, and neither is something a user can act on.
   */
  it.each([
    ["a 500 with an operator detail", 500, "psycopg2.OperationalError: could not connect to server"],
    ["a 503 runbook message", 503, "Database unavailable or not migrated. Run alembic upgrade head."]
  ])("shows its own safe copy after %s", async (_label, status, detail) => {
    vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      const url = String(input);
      if (url.endsWith("/jobs/tracker/submitted")) {
        return Promise.resolve(jsonResponse({ detail }, status));
      }
      return Promise.resolve(jsonResponse({}));
    });

    render(React.createElement(TrackerClient));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/couldn.t load your applications/i);
    expect(alert.textContent).not.toMatch(/psycopg2|OperationalError|alembic|migrated|Database unavailable/i);
  });

  it("loads automatically and presents useful job information instead of IDs", async () => {
    render(React.createElement(TrackerClient));

    await row("Software Engineer");
    const rows = within(list());
    expect(rows.getByText("Software Engineer")).toBeInTheDocument();
    expect(rows.getByText("Acme")).toBeInTheDocument();
    expect(rows.getByText("Backend Engineer")).toBeInTheDocument();
    expect(rows.getByText("Northstar")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Load applications/i })).not.toBeInTheDocument();
    // The most recent application is open by default, with its real fields.
    const detail = screen.getByRole("region", { name: "Selected application" });
    expect(within(detail).getByRole("heading", { name: "Software Engineer" })).toBeInTheDocument();
    expect(within(detail).getByText("New York, NY")).toBeInTheDocument();
    expect(within(detail).getByText("84% fit")).toBeInTheDocument();
    expect(within(detail).getByRole("link", { name: /View job posting/i })).toHaveAttribute(
      "href",
      "https://careers.acme.com/101"
    );
  });

  it("has no summary statistic cards or stacked per-application cards", async () => {
    render(React.createElement(TrackerClient));
    await row("Software Engineer");
    expect(screen.queryByText("Total tracked")).not.toBeInTheDocument();
    // One status control and one document block: the selected application's, not one per row.
    expect(screen.getAllByLabelText(/Update status for/i)).toHaveLength(1);
    expect(screen.getAllByRole("article")).toHaveLength(1);
  });

  it("shows the selected application's details and follows the selection", async () => {
    render(React.createElement(TrackerClient));
    const first = await row("Software Engineer");
    const second = await row("Backend Engineer");
    expect(first).toHaveAttribute("aria-current", "true");
    expect(second).not.toHaveAttribute("aria-current");

    await userEvent.click(second);
    expect(second).toHaveAttribute("aria-current", "true");
    expect(first).not.toHaveAttribute("aria-current");
    const detail = screen.getByRole("region", { name: "Selected application" });
    expect(within(detail).getByRole("heading", { name: "Backend Engineer" })).toBeInTheDocument();
    expect(within(detail).getByText("91% fit")).toBeInTheDocument();
    expect(within(detail).getByRole("link", { name: /View job posting/i })).toHaveAttribute("href", "https://northstar.dev/jobs/102");
  });

  it("sorts by most recent date by default and can be reversed", async () => {
    render(React.createElement(TrackerClient));
    await row("Software Engineer");
    const titles = () => within(list()).getAllByRole("button").map((button) => button.textContent ?? "");
    expect(titles()[0]).toMatch(/Software Engineer/); // 2026-07-20 before 2026-07-19
    await userEvent.selectOptions(screen.getByLabelText("Sort applications"), "oldest");
    expect(titles()[0]).toMatch(/Backend Engineer/);
  });

  it("remembers the selected application for the browser tab", async () => {
    const first = render(React.createElement(TrackerClient));
    await userEvent.click(await row("Backend Engineer"));
    first.unmount();

    render(React.createElement(TrackerClient));
    expect(await row("Backend Engineer")).toHaveAttribute("aria-current", "true");
  });

  it("moves the details to the first listed application when a filter hides the selected one", async () => {
    render(React.createElement(TrackerClient));
    await userEvent.click(await row("Software Engineer"));
    await userEvent.click(screen.getByRole("button", { name: "Interviews" }));
    const detail = screen.getByRole("region", { name: "Selected application" });
    expect(within(detail).getByRole("heading", { name: "Backend Engineer" })).toBeInTheDocument();
  });

  it("opens details from the list and returns to it on a small screen", async () => {
    render(React.createElement(TrackerClient));
    await userEvent.click(await row("Backend Engineer"));
    // The back control exists for phones (it is hidden from tablet and desktop by CSS), and returns to the list.
    const back = screen.getByRole("button", { name: /All applications/i });
    expect(back.className).toMatch(/md:hidden/);
    expect(screen.getByRole("region", { name: "Selected application" }).className).not.toMatch(/(^|\s)hidden(\s|$)/);
    await userEvent.click(back);
    expect(screen.getByRole("region", { name: "Selected application" }).className).toMatch(/(^|\s)hidden(\s|$)/);
    expect(screen.getByRole("region", { name: "Selected application" }).className).toMatch(/md:block/);
  });

  it("does not claim the employer confirmed anything", async () => {
    render(React.createElement(TrackerClient));
    await row("Software Engineer");
    const detail = screen.getByRole("region", { name: "Selected application" });
    expect(detail).toHaveTextContent(/not an employer receipt/i);
    expect(detail.textContent).not.toMatch(/employer confirmed|confirmed by the employer\b(?! \()/i);
  });

  it("rows are single buttons with no nested interactive elements", async () => {
    render(React.createElement(TrackerClient));
    await row("Software Engineer");
    for (const button of within(list()).getAllByRole("button")) {
      expect(button.querySelector("a, button, input, select, textarea")).toBeNull();
    }
  });

  it("updates status from the application card", async () => {
    render(React.createElement(TrackerClient));
    const select = await screen.findByLabelText("Update status for Software Engineer");
    await userEvent.selectOptions(select, "offer");

    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(
        "http://localhost:8000/jobs/101/tracker",
        expect.objectContaining({
          method: "PUT",
          body: JSON.stringify({ status: "offer" })
        })
      )
    );
    const confirmation = await screen.findByText("Moved to Offer / selected.");
    expect(confirmation).toBeInTheDocument();
    expect(confirmation).toHaveAttribute("role", "status"); // announced to screen readers
    // The change is reflected in the list row and in the details, not only in the control.
    expect(within(list()).getByText("Offer / selected")).toBeInTheDocument();
  });

  it("keeps the old status and says so when the server refuses the change", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      const url = String(input);
      if (url.endsWith("/jobs/tracker/submitted")) return Promise.resolve(jsonResponse({ applications: APPLICATIONS }));
      if (url.endsWith("/jobs/101/tracker") && init?.method === "PUT") return Promise.resolve(jsonResponse({ detail: "boom" }, 500));
      return Promise.resolve(jsonResponse({}));
    });
    render(React.createElement(TrackerClient));
    await userEvent.selectOptions(await screen.findByLabelText("Update status for Software Engineer"), "offer");
    expect(await screen.findByRole("alert")).toHaveTextContent(/couldn.t update that application/i);
    expect(within(list()).queryByText("Offer / selected")).not.toBeInTheDocument();
  });

  it("filters applications by stage", async () => {
    render(React.createElement(TrackerClient));
    await row("Software Engineer");

    await userEvent.click(screen.getByRole("button", { name: "Interviews" }));
    expect(within(list()).getByText("Backend Engineer")).toBeInTheDocument();
    expect(within(list()).queryByText("Software Engineer")).not.toBeInTheDocument();
  });

  describe("XpertApply visual semantics", () => {
    it("announces the selected stage filter rather than only colouring it", async () => {
      render(React.createElement(TrackerClient));
      await row("Software Engineer");

      const all = screen.getByRole("button", { name: "All" });
      const interviews = screen.getByRole("button", { name: "Interviews" });
      expect(all).toHaveAttribute("aria-pressed", "true");
      expect(interviews).toHaveAttribute("aria-pressed", "false");

      await userEvent.click(interviews);
      expect(interviews).toHaveAttribute("aria-pressed", "true");
      expect(all).toHaveAttribute("aria-pressed", "false");
    });

    it("gives each stage its domain tone alongside a readable label", async () => {
      render(React.createElement(TrackerClient));
      await row("Software Engineer");

      // Scoped to the badge: "Applied" and "Interview" are also option labels
      // in the status select, and this is asserting the badge tone.
      const badge = (label: string) =>
        screen.getAllByText(label).find((node) => node.tagName === "SPAN");

      // An in-flight application is amber; an interview is informational.
      // Neither is green, which this screen reserves for an actual offer.
      const applied = badge("Applied");
      const interview = badge("Interview");
      expect(applied?.className).toMatch(/status-warning/);
      expect(interview?.className).toMatch(/status-info/);
      expect(interview?.className).not.toMatch(/status-success/);
      // Meaning never rests on colour alone.
      expect(interview).toHaveTextContent("Interview");
    });

    it("keeps the tracker's own wording for the offer stage", async () => {
      render(React.createElement(TrackerClient));
      const select = await screen.findByLabelText("Update status for Software Engineer");
      // The stage you move an application into is named in full here, even
      // though the Dashboard's dense badge says just "Offer".
      expect(within(select).getByRole("option", { name: "Offer / selected" })).toBeInTheDocument();
    });

    it("offers a way forward only when the tracker is genuinely empty", async () => {
      render(React.createElement(TrackerClient));
      await row("Software Engineer");

      // A search that matched nothing needs a different query, not a new job.
      await userEvent.type(screen.getByLabelText("Search applications"), "zzzzz");
      expect(await screen.findByText("No applications found")).toBeInTheDocument();
      expect(screen.queryByRole("link", { name: "Find jobs" })).not.toBeInTheDocument();
    });

    /**
     * A native <select> whose value matches no <option> renders its FIRST
     * option. Since the control only offers the four destinations a user may
     * move an application to, every other state — saved, applying, withdrawn,
     * or anything a later backend adds — used to read as "Applied".
     */
    describe("current state representation", () => {
      const withStatus = (status: string) => [
        { ...APPLICATIONS[0], id: 99, job_id: 199, status }
      ];

      const renderWithStatus = async (status: string) => {
        vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
          const url = String(input);
          if (url.endsWith("/jobs/tracker/submitted")) {
            return Promise.resolve(jsonResponse({ applications: withStatus(status) }));
          }
          return Promise.resolve(jsonResponse({}));
        });
        render(React.createElement(TrackerClient));
        return (await screen.findByLabelText(
          "Update status for Software Engineer"
        )) as HTMLSelectElement;
      };

      it.each([
        ["saved", "Saved"],
        ["ready_to_apply", "Saved"],
        ["applying", "Applying"],
        ["withdrawn", "Withdrawn"]
      ])("shows %s truthfully instead of falling back to Applied", async (status, label) => {
        const select = await renderWithStatus(status);

        // The control reports the real state, not the first option.
        expect(select.value).toBe(status);
        expect(select.selectedOptions[0]).toHaveTextContent(label);
        expect(select.selectedOptions[0]).not.toHaveTextContent("Applied");

        // ...and the badge agrees with it.
        const badge = screen.getAllByText(label).find((node) => node.tagName === "SPAN");
        expect(badge).toBeInTheDocument();

        // The current state is described, never offered as a destination.
        expect(select.selectedOptions[0]).toBeDisabled();
      });

      it.each(["applied", "interview", "offer", "rejected"])(
        "leaves %s behaving exactly as before",
        async (status) => {
          const select = await renderWithStatus(status);
          expect(select.value).toBe(status);
          // A normal destination is selectable, not a current-only description.
          expect(select.selectedOptions[0]).not.toBeDisabled();
        }
      );

      it("survives a status this build has never seen", async () => {
        const select = await renderWithStatus("ghosted");

        // No crash, no false "Applied", and the value stays truthful.
        expect(select.value).toBe("ghosted");
        expect(select.selectedOptions[0]).toHaveTextContent("Ghosted");
        expect(select.selectedOptions[0]).toBeDisabled();

        // Unknown means "no judgement" — never a status tone it did not earn.
        const badge = screen.getAllByText("Ghosted").find((node) => node.tagName === "SPAN");
        expect(badge?.className).toMatch(/status-neutral/);
      });

      /**
       * The display fix must not become a workflow change: injecting a
       * current-state option must never widen what a user can move an
       * application *to*.
       */
      it.each(["saved", "applying", "withdrawn", "ghosted", "applied", "offer"])(
        "keeps the permitted destinations unchanged while showing %s",
        async (status) => {
          const select = await renderWithStatus(status);
          const selectable = Array.from(select.options)
            .filter((option) => !option.disabled)
            .map((option) => option.value);
          expect(selectable).toEqual(["applied", "interview", "offer", "rejected"]);
        }
      );
    });

    it("no longer carries legacy brand styling", () => {
      const source = readFileSync(join(__dirname, "..", "components/TrackerClient.tsx"), "utf8");
      expect(source).not.toMatch(/text-pine|bg-pine|border-pine/);
      expect(source).not.toMatch(/--success-surface|--warning-surface|--danger-surface/);
      expect(source).not.toMatch(/\bfocus-ring\b(?<!ds-focus-ring)/);
      expect(source).toContain("bg-surface-card");
    });
  });
});

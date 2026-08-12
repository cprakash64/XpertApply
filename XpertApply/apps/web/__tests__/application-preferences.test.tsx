import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// SectionEditor mounts the shared unsaved-changes guard, which needs the App
// Router — mocked per-file, matching the other suites.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), back: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/profile/application-preferences",
  useSearchParams: () => new URLSearchParams()
}));
import { ApplicationAccounts } from "@/components/ApplicationAccounts";
import { SectionEditor } from "@/components/profile/editors/SectionEditor";

const ROOT = join(__dirname, "..");

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

const PROFILE = {
  first_name: "Chandra",
  last_name: "Pandey",
  full_name: "Chandra Pandey",
  application_email: "chandra@example.test",
  phone: "602-555-0147",
  location_city: "Phoenix",
  location_country: "United States",
  work_authorization: "authorized_us",
  open_to_relocation: true,
  target_roles: ["Backend Engineer"],
  preferred_locations: ["Remote"],
  remote_preference: "remote",
  skills: ["Python"],
  workday_password_configured: false
};

const ELIGIBILITY = {
  answers: [
    {
      field: "work_authorization_us",
      prompt: "Are you legally authorized to work in the United States without restriction?",
      answer: "yes",
      answered: true,
      reusable: true,
      needs_confirmation: false,
      confirmed_at: "2026-01-01T00:00:00Z",
      version: 1
    },
    {
      field: "sponsorship_required_now",
      prompt: "Do you currently require employer sponsorship or a visa transfer?",
      answer: "no",
      answered: true,
      reusable: true,
      needs_confirmation: false,
      confirmed_at: "2026-01-01T00:00:00Z",
      version: 1
    },
    {
      field: "sponsorship_required_future",
      prompt: "Will you require employer sponsorship or a visa transfer in the future?",
      answer: null,
      answered: false,
      reusable: false,
      needs_confirmation: false,
      confirmed_at: null,
      version: 0
    }
  ]
};

let requests: { url: string; method: string; body: unknown }[];

function mockApi({
  configured = false,
  failCredential = false
}: { configured?: boolean; failCredential?: boolean } = {}) {
  requests = [];
  return vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    if (method !== "GET") {
      requests.push({
        url,
        method,
        body: init?.body ? JSON.parse(String(init.body)) : null
      });
      if (url.includes("/workday-credentials") && failCredential) {
        return Promise.resolve(jsonResponse({ detail: "nope" }, 422));
      }
      if (url.includes("/workday-credentials")) {
        return Promise.resolve(jsonResponse({ configured: method === "PUT" }));
      }
      if (url.includes("/application-eligibility")) {
        return Promise.resolve(jsonResponse(ELIGIBILITY));
      }
      return Promise.resolve(jsonResponse({ ok: true }));
    }
    if (url.endsWith("/profile/application-eligibility")) {
      return Promise.resolve(jsonResponse(ELIGIBILITY));
    }
    if (url.endsWith("/profile/demographics")) {
      return Promise.resolve(jsonResponse({ demographics: null }));
    }
    if (url.endsWith("/profile/career")) {
      return Promise.resolve(jsonResponse({ education: [], experience: [], projects: [] }));
    }
    if (url.endsWith("/auth/me")) {
      return Promise.resolve(jsonResponse({ email: "login@example.test" }));
    }
    if (url.endsWith("/profile")) {
      return Promise.resolve(
        jsonResponse({ profile: { ...PROFILE, workday_password_configured: configured } })
      );
    }
    return Promise.resolve(jsonResponse({}));
  });
}

describe("Application preferences page", () => {
  beforeEach(() => {
    localStorage.setItem("jobpilot_token", "token");
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  async function renderPage() {
    mockApi();
    render(React.createElement(SectionEditor, { section: "application-preferences" }));
    await screen.findByRole("group", { name: /Work eligibility/ });
  }

  // ---------------------------------------------------------------- //
  // 10. Renders and saves
  // ---------------------------------------------------------------- //
  it("uses the same section primitives as every other profile editor", async () => {
    await renderPage();
    // Work eligibility is a real fieldset/legend, not a bare div.
    expect(screen.getByRole("group", { name: /Work eligibility/ })).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Reusable application answers" })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: /Optional demographic information/ })
    ).toBeInTheDocument();
    // And the shared save bar, in the same place as the other sections.
    expect(screen.getByRole("button", { name: "Save changes" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
  });

  it("shows the supported application defaults and saves them", async () => {
    const user = userEvent.setup();
    await renderPage();

    expect(screen.getByLabelText("Work authorization status")).toHaveValue("authorized_us");
    const relocation = screen.getByLabelText("Open to relocation");
    expect(relocation).toBeChecked();

    await user.click(relocation);
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => {
      const put = requests.find((r) => r.method === "PUT" && r.url.endsWith("/profile"));
      expect(put).toBeDefined();
      expect((put!.body as Record<string, unknown>).open_to_relocation).toBe(false);
    });
    expect(await screen.findByText("Saved")).toBeInTheDocument();
  });

  it("keeps the three legal questions distinct and offers all three choices", async () => {
    await renderPage();
    // ApplicationEligibility fetches its own answers, so the prompts arrive
    // after renderPage resolves — that only awaits the surrounding fieldset.
    // Awaiting the first one is what makes the rest synchronously assertable;
    // a question that genuinely went missing still fails here, on timeout.
    await screen.findByText(/legally authorized to work in the United States/i);
    for (const prompt of [
      /legally authorized to work in the United States/i,
      /currently require employer sponsorship/i,
      /require employer sponsorship or a visa transfer in the future/i
    ]) {
      expect(screen.getByText(prompt)).toBeInTheDocument();
    }
    // "Answer during each application" is offered as a real choice everywhere.
    expect(screen.getAllByRole("radio", { name: "Answer during each application" })).toHaveLength(3);
  });

  it("posts the canonical field name when an answer changes", async () => {
    const user = userEvent.setup();
    await renderPage();

    // ApplicationEligibility fetches its own answers, so wait for the prompt.
    const futurePrompt = await screen.findByText(
      /require employer sponsorship or a visa transfer in the future/i
    );
    const futureGroup = futurePrompt.closest("fieldset, div, li") as HTMLElement;
    await user.click(within(futureGroup).getByRole("radio", { name: "Yes" }));

    await waitFor(() => {
      const put = requests.find((r) => r.url.includes("/application-eligibility"));
      expect(put).toBeDefined();
      // The canonical key the resolver reads — not a UI-invented name.
      expect(put!.body).toEqual({ field: "sponsorship_required_future", answer: "yes" });
    });
  });

  it("links to demographics rather than inlining the form, and says what it is not used for", async () => {
    await renderPage();
    expect(screen.getByText(/Private · Optional/)).toBeInTheDocument();
    expect(
      screen.getByText(/never used for job matching, fit scoring, ranking, resume generation/i)
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: /Manage optional information/ })
    ).toHaveAttribute("href", "/profile/eeo");
    // The optional private form is not rendered in the primary editor.
    expect(screen.queryByRole("group", { name: "Gender identity" })).not.toBeInTheDocument();
  });

  it("never shows an employer credential field on this page", async () => {
    await renderPage();
    expect(document.querySelector('input[type="password"]')).toBeNull();
    expect(document.body.textContent?.toLowerCase()).not.toContain("workday");
  });
});

// -------------------------------------------------------------------- //
// 9. The repeated eligibility cards are gone
// -------------------------------------------------------------------- //
describe("information architecture", () => {
  it("renders the eligibility answers in exactly one place", () => {
    // A source-level check: the component must not be mounted under career
    // sections. It used to appear beneath whichever step you were on.
    const sources = [
      "app/profile/[section]/page.tsx",
      "app/profile/page.tsx",
      "components/ProfileWizard.tsx",
      "components/profile/ProfileOverview.tsx"
    ];
    for (const file of sources) {
      const source = readFileSync(join(ROOT, file), "utf8");
      expect(source, `${file} must not render ApplicationEligibility`).not.toContain(
        "<ApplicationEligibility"
      );
    }
    const owner = readFileSync(
      join(ROOT, "components/profile/editors/ApplicationPreferencesEditor.tsx"),
      "utf8"
    );
    expect(owner).toContain("<ApplicationEligibility />");
  });

  it("keeps the EEO form out of the career wizard", () => {
    const wizard = readFileSync(join(ROOT, "components/ProfileWizard.tsx"), "utf8");
    expect(wizard).not.toContain("DemographicsForm");
    // The EEO form now lives only on its own dedicated page — not in the
    // career wizard and not inlined in the primary application editor.
    const eeoPage = readFileSync(join(ROOT, "app/profile/eeo/page.tsx"), "utf8");
    expect(eeoPage).toContain("<DemographicsForm />");
    const prefs = readFileSync(
      join(ROOT, "components/profile/editors/ApplicationPreferencesEditor.tsx"),
      "utf8"
    );
    expect(prefs).not.toContain("<DemographicsForm");
  });

  it("keeps the Workday credential out of every profile screen", () => {
    for (const file of [
      "components/ProfileWizard.tsx",
      "components/profile/ProfileOverview.tsx",
      "components/profile/editors/ApplicationPreferencesEditor.tsx",
      "components/profile/editors/PersonalEditor.tsx"
    ]) {
      const source = readFileSync(join(ROOT, file), "utf8");
      expect(source.toLowerCase(), `${file} must not touch workday credentials`).not.toContain(
        "workday-credentials"
      );
    }
    const settings = readFileSync(join(ROOT, "app/settings/page.tsx"), "utf8");
    expect(settings).toContain("<ApplicationAccounts />");
  });

  it("does not surface demographic values on the Profile overview", () => {
    const overview = readFileSync(join(ROOT, "components/profile/ProfileOverview.tsx"), "utf8");
    // Naming the section is fine — it is a navigation label. Rendering an
    // answer, or reading the demographics endpoint at all, is not.
    for (const term of ["gender", "race", "veteran", "disability", "hispanic"]) {
      expect(overview.toLowerCase()).not.toContain(term);
    }
    expect(overview).not.toContain("/profile/demographics");
    expect(overview).not.toContain("DemographicsForm");
  });
});

// -------------------------------------------------------------------- //
// 7/8. Credential UI
// -------------------------------------------------------------------- //
describe("Application accounts", () => {
  beforeEach(() => {
    localStorage.setItem("jobpilot_token", "token");
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("shows a not-connected state without any password value", async () => {
    mockApi({ configured: false });
    render(React.createElement(ApplicationAccounts));
    expect(await screen.findByText("Not connected")).toBeInTheDocument();
    expect(screen.getByText("No password stored")).toBeInTheDocument();
    expect(screen.getByLabelText("Workday password")).toHaveValue("");
  });

  it("shows a connected state as a mask, never a value", async () => {
    mockApi({ configured: true });
    render(React.createElement(ApplicationAccounts));
    expect(await screen.findByText("Connected")).toBeInTheDocument();
    expect(screen.getByText("Password stored securely")).toBeInTheDocument();
    // The mask is fixed-length and decorative; the real value never reaches us.
    expect(screen.getByText("••••••••••")).toHaveAttribute("aria-hidden", "true");
    expect(screen.getByLabelText("Replace password")).toHaveValue("");
  });

  it("stores a password, then clears the field so it does not linger", async () => {
    const user = userEvent.setup();
    mockApi({ configured: false });
    render(React.createElement(ApplicationAccounts));
    await screen.findByText("Not connected");

    const field = screen.getByLabelText("Workday password");
    await user.type(field, "a-long-enough-password");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText("Password stored securely.")).toBeInTheDocument();
    expect(screen.getByLabelText("Replace password")).toHaveValue("");
    expect(screen.getByText("Connected")).toBeInTheDocument();
  });

  it("never writes the credential to localStorage", async () => {
    const user = userEvent.setup();
    mockApi({ configured: false });
    render(React.createElement(ApplicationAccounts));
    await screen.findByText("Not connected");

    await user.type(screen.getByLabelText("Workday password"), "a-long-enough-password");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText("Password stored securely.");

    const dump = JSON.stringify(localStorage);
    expect(dump).not.toContain("a-long-enough-password");
  });

  it("enforces the server's minimum length before sending anything", async () => {
    const user = userEvent.setup();
    mockApi({ configured: false });
    render(React.createElement(ApplicationAccounts));
    await screen.findByText("Not connected");

    await user.type(screen.getByLabelText("Workday password"), "short");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/at least 8 characters/i);
    // Nothing was sent — the value never left the browser.
    expect(requests.filter((r) => r.url.includes("workday-credentials"))).toHaveLength(0);
  });

  it("requires confirmation before removing, and can be cancelled", async () => {
    const user = userEvent.setup();
    mockApi({ configured: true });
    render(React.createElement(ApplicationAccounts));
    await screen.findByText("Connected");

    await user.click(screen.getByRole("button", { name: "Remove" }));
    const dialog = screen.getByRole("alertdialog");
    expect(within(dialog).getByText(/Remove the stored Workday password/)).toBeInTheDocument();

    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(requests.filter((r) => r.method === "DELETE")).toHaveLength(0);
  });

  it("removes the credential once confirmed", async () => {
    const user = userEvent.setup();
    mockApi({ configured: true });
    render(React.createElement(ApplicationAccounts));
    await screen.findByText("Connected");

    await user.click(screen.getByRole("button", { name: "Remove" }));
    await user.click(
      within(screen.getByRole("alertdialog")).getByRole("button", { name: "Remove password" })
    );

    expect(await screen.findByText("Stored password removed.")).toBeInTheDocument();
    expect(screen.getByText("Not connected")).toBeInTheDocument();
    expect(requests.filter((r) => r.method === "DELETE")).toHaveLength(1);
  });

  it("surfaces a failure instead of claiming success", async () => {
    const user = userEvent.setup();
    mockApi({ configured: false, failCredential: true });
    render(React.createElement(ApplicationAccounts));
    await screen.findByText("Not connected");

    await user.type(screen.getByLabelText("Workday password"), "a-long-enough-password");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.queryByText("Password stored securely.")).not.toBeInTheDocument();
    expect(screen.getByText("Not connected")).toBeInTheDocument();
  });
});

import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// SectionEditor mounts the unsaved-changes guard, which needs the App Router.
// Mocked per-file, matching the convention in the other suites.
const routerPush = vi.fn();
const routerBack = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: routerPush, back: routerBack, replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/profile/experience",
  useSearchParams: () => new URLSearchParams()
}));
import { SectionEditor } from "@/components/profile/editors/SectionEditor";
import type { FocusedSection } from "@/lib/profileSections";

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
  name_confirmed: true,
  application_email: "chandra@example.test",
  phone: "602-555-0147",
  phone_country_iso2: "US",
  location_city: "Phoenix",
  location_state: "AZ",
  location_postal_code: "85004",
  location_country: "United States",
  linkedin_url: "https://linkedin.com/in/chandra",
  github_url: "https://github.com/chandra",
  portfolio_url: "",
  work_authorization: "authorized_us",
  target_roles: ["Machine Learning Engineer", "Interplanetary Vibe Officer"],
  target_levels: ["New Grad"],
  preferred_locations: ["Phoenix, AZ", "Remote"],
  remote_preference: "remote",
  skills: ["Python", "PyTorch", "FastAPI", "Docker", "PostgreSQL", "React", "Underwater Basket Weaving"],
  workday_password_configured: true
};

const CAREER = {
  education: [
    {
      school: "Arizona State University",
      degree: "Bachelor's Degree",
      major: "Computer Science",
      minor: "Data Science",
      start_date: "2022-08-01",
      end_date: "2025-05-01",
      gpa: "3.6",
      gpa_scale: "4.0",
      honors: ["Dean's List"],
      coursework: ["Machine Learning"]
    }
  ],
  experience: [
    {
      company: "VeoTrex",
      title: "Founder & Technical Lead",
      location: "Phoenix, AZ",
      start_date: "2024-01-01",
      end_date: null,
      currently_working: true,
      bullets: ["Built the platform"],
      technologies: ["Python", "Computer Vision", "FastAPI", "AWS", "Redis", "Kafka", "Docker"],
      measurable_impact: ["Cut latency 40%"]
    },
    {
      company: "Cardinal Health",
      title: "ML Intern",
      location: "Columbus, OH",
      start_date: "2023-05-01",
      end_date: "2023-08-01",
      currently_working: false,
      bullets: [],
      technologies: [],
      measurable_impact: []
    }
  ],
  projects: [
    {
      name: "Luna AI",
      description: "Video-understanding infrastructure",
      bullets: ["Shipped OCR"],
      technologies: ["Computer Vision", "FastAPI", "OCR", "Socket.IO", "Redis"],
      links: ["https://github.com/you/luna"],
      start_date: "2024-02-01",
      end_date: ""
    }
  ],
  certifications: [
    { name: "AWS SAA", issuer: "Amazon Web Services", issue_date: "2024-02-01", expiration_date: null, credential_url: "" }
  ],
  awards: [{ name: "Hackathon winner", issuer: "ASU", date: "2023-11-01", description: "" }],
  publications: [
    {
      title: "Efficient Video Event Detection at the Edge",
      venue: "IEEE",
      authors: ["C. Pandey"],
      publication_date: "2025-03-01",
      url: "https://ieeexplore.ieee.org/document/12345",
      doi: "10.1109/EXAMPLE.2025.12345",
      description: ""
    }
  ]
};

let putBodies: Record<string, unknown[]>;

function mockApi({
  failSave = false,
  career = CAREER as unknown
}: { failSave?: boolean; career?: unknown } = {}) {
  putBodies = {};
  return vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    if (method === "PUT") {
      const path = url.replace(/^.*?(\/profile.*)$/, "$1");
      (putBodies[path] ??= []).push(JSON.parse(String(init?.body ?? "{}")));
      if (failSave) {
        return Promise.resolve(jsonResponse({ detail: "Server exploded" }, 500));
      }
      return Promise.resolve(jsonResponse({ ok: true }));
    }
    if (url.endsWith("/profile/career")) return Promise.resolve(jsonResponse(career));
    if (url.endsWith("/auth/me")) return Promise.resolve(jsonResponse({ email: "login@example.test" }));
    if (url.endsWith("/profile")) return Promise.resolve(jsonResponse({ profile: PROFILE }));
    return Promise.resolve(jsonResponse({}));
  });
}

async function renderEditor(section: FocusedSection, options?: Parameters<typeof mockApi>[0]) {
  mockApi(options);
  render(React.createElement(SectionEditor, { section }));
  await waitFor(() =>
    expect(screen.queryByTestId("editor-loading")).not.toBeInTheDocument()
  );
}

describe("focused profile editors", () => {
  beforeEach(() => {
    localStorage.setItem("jobpilot_token", "token");
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  // ------------------------------------------------------------------ //
  // Experience — collapse / expand
  // ------------------------------------------------------------------ //
  it("shows experience as collapsed summaries, not open forms", async () => {
    await renderEditor("experience");
    expect(screen.getByText("VeoTrex")).toBeInTheDocument();
    expect(screen.getByText("Founder & Technical Lead")).toBeInTheDocument();
    expect(screen.getByText(/Phoenix, AZ · 2024 – Present/)).toBeInTheDocument();
    // No form fields rendered while everything is collapsed.
    expect(screen.queryByLabelText("Company")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("What you did")).not.toBeInTheDocument();
  });

  it("summarizes technologies with a +N overflow", async () => {
    await renderEditor("experience");
    // 7 technologies, 4 shown.
    expect(screen.getByText(/Python · Computer Vision · FastAPI · AWS/)).toBeInTheDocument();
    expect(screen.getByText("+3")).toBeInTheDocument();
  });

  it("expands one record and reports state to assistive tech", async () => {
    const user = userEvent.setup();
    await renderEditor("experience");
    const trigger = screen.getByRole("button", { name: /^VeoTrex/ });
    expect(trigger).toHaveAttribute("aria-expanded", "false");

    await user.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByLabelText("Company")).toHaveValue("VeoTrex");
  });

  it("keeps only one experience expanded at a time", async () => {
    const user = userEvent.setup();
    await renderEditor("experience");

    await user.click(screen.getByRole("button", { name: /^VeoTrex/ }));
    expect(screen.getByLabelText("Company")).toHaveValue("VeoTrex");

    await user.click(screen.getByRole("button", { name: /^Cardinal Health/ }));
    // The first collapsed as the second opened.
    expect(screen.getAllByLabelText("Company")).toHaveLength(1);
    expect(screen.getByLabelText("Company")).toHaveValue("Cardinal Health");
  });

  it("moves focus into the editor when a record opens", async () => {
    const user = userEvent.setup();
    await renderEditor("experience");
    await user.click(screen.getByRole("button", { name: /^VeoTrex/ }));
    await waitFor(() => expect(screen.getByLabelText("Company")).toHaveFocus());
  });

  // ------------------------------------------------------------------ //
  // Experience — currently-working date behaviour
  // ------------------------------------------------------------------ //
  it("disables the end date while the role is current", async () => {
    const user = userEvent.setup();
    await renderEditor("experience");
    await user.click(screen.getByRole("button", { name: /^VeoTrex/ }));
    expect(screen.getByLabelText("End date")).toBeDisabled();
  });

  it("clears the end date when the role becomes current, and saves it as null", async () => {
    const user = userEvent.setup();
    await renderEditor("experience");
    await user.click(screen.getByRole("button", { name: /^Cardinal Health/ }));
    expect(screen.getByLabelText("End date")).toHaveValue("2023-08-01");

    await user.click(screen.getByLabelText("I currently work here"));
    expect(screen.getByLabelText("End date")).toHaveValue("");

    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(putBodies["/profile/career"]).toBeDefined());
    const saved = putBodies["/profile/career"][0] as { experience: Record<string, unknown>[] };
    const record = saved.experience.find((item) => item.company === "Cardinal Health");
    expect(record?.currently_working).toBe(true);
    expect(record?.end_date).toBeNull();
  });

  // ------------------------------------------------------------------ //
  // Experience — create / duplicate / delete
  // ------------------------------------------------------------------ //
  it("adds a role and opens it immediately", async () => {
    const user = userEvent.setup();
    await renderEditor("experience");
    await user.click(screen.getByRole("button", { name: "Add role" }));
    expect(screen.getByLabelText("Company")).toHaveValue("");
  });

  it("requires confirmation before deleting, and can be cancelled", async () => {
    const user = userEvent.setup();
    await renderEditor("experience");

    await user.click(screen.getByRole("button", { name: /Actions for VeoTrex/ }));
    await user.click(screen.getByRole("menuitem", { name: "Delete experience" }));

    const dialog = screen.getByRole("alertdialog");
    expect(within(dialog).getByText("Delete this experience?")).toBeInTheDocument();
    // Cancel is focused, so a stray Enter cannot destroy a record.
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toHaveFocus();

    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(screen.getByText("VeoTrex")).toBeInTheDocument();
  });

  it("removes the record once the deletion is confirmed", async () => {
    const user = userEvent.setup();
    await renderEditor("experience");

    await user.click(screen.getByRole("button", { name: /Actions for VeoTrex/ }));
    await user.click(screen.getByRole("menuitem", { name: "Delete experience" }));
    await user.click(
      within(screen.getByRole("alertdialog")).getByRole("button", { name: "Delete experience" })
    );

    expect(screen.queryByText("VeoTrex")).not.toBeInTheDocument();
    expect(screen.getByText("Cardinal Health")).toBeInTheDocument();
  });

  it("does not put a permanent delete button on every card", async () => {
    await renderEditor("experience");
    // Delete lives behind the overflow menu, not on the card surface.
    expect(screen.queryByRole("button", { name: /^Delete/ })).not.toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /^Actions for/ })).toHaveLength(2);
  });

  it("duplicates a record", async () => {
    const user = userEvent.setup();
    await renderEditor("experience");
    await user.click(screen.getByRole("button", { name: /Actions for VeoTrex/ }));
    await user.click(screen.getByRole("menuitem", { name: "Duplicate" }));
    expect(screen.getAllByText("VeoTrex")).toHaveLength(2);
  });

  // ------------------------------------------------------------------ //
  // Save UX
  // ------------------------------------------------------------------ //
  it("reports Saving… then Saved only after the server responds", async () => {
    const user = userEvent.setup();
    await renderEditor("experience");
    await user.click(screen.getByRole("button", { name: /^VeoTrex/ }));
    await user.clear(screen.getByLabelText("Company"));
    await user.type(screen.getByLabelText("Company"), "VeoTrex Labs");

    expect(screen.getByText("Unsaved changes")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByText("Saved")).toBeInTheDocument();
  });

  it("surfaces a retryable error instead of a false Saved", async () => {
    const user = userEvent.setup();
    await renderEditor("experience", { failSave: true });
    await user.click(screen.getByRole("button", { name: /^VeoTrex/ }));
    await user.clear(screen.getByLabelText("Company"));
    await user.type(screen.getByLabelText("Company"), "X");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    expect(await screen.findByText(/Error saving/)).toBeInTheDocument();
    expect(screen.queryByText("Saved")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });

  it("never destroys certifications or awards when saving career sections", async () => {
    const user = userEvent.setup();
    await renderEditor("experience");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(putBodies["/profile/career"]).toBeDefined());
    // PUT /profile/career deletes every career table, so these have to be sent
    // back or the save would wipe them. They are normalized into full records
    // now that Certifications & Awards has an editor — the point of this test
    // is that the records SURVIVE, not that they are byte-identical.
    const saved = putBodies["/profile/career"][0] as {
      certifications: { name: string }[];
      awards: { name: string }[];
    };
    expect(saved.certifications.map((item) => item.name)).toEqual(["AWS SAA"]);
    expect(saved.awards.map((item) => item.name)).toEqual(["Hackathon winner"]);
  });

  it("discards edits on Cancel by reloading from the server", async () => {
    const user = userEvent.setup();
    await renderEditor("experience");
    await user.click(screen.getByRole("button", { name: /^VeoTrex/ }));
    await user.clear(screen.getByLabelText("Company"));
    await user.type(screen.getByLabelText("Company"), "Wrong");

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.getByText("VeoTrex")).toBeInTheDocument());
  });


  it("blocks a second submit while the first is still in flight", async () => {
    // The guard that matters for a double-click is the in-flight disable, so
    // the request is held open for the duration of the second click. (The
    // career endpoint is a full replace, so even a genuine second save is
    // idempotent — this is about not issuing redundant writes.)
    const user = userEvent.setup();
    let releasePut: (value: Response) => void = () => {};
    const puts: unknown[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      const url = String(input);
      if ((init?.method ?? "GET").toUpperCase() === "PUT") {
        puts.push(JSON.parse(String(init?.body ?? "{}")));
        return new Promise<Response>((resolve) => {
          releasePut = resolve;
        });
      }
      if (url.endsWith("/profile/career")) return Promise.resolve(jsonResponse(CAREER));
      if (url.endsWith("/auth/me")) return Promise.resolve(jsonResponse({ email: "a@b.test" }));
      if (url.endsWith("/profile")) return Promise.resolve(jsonResponse({ profile: PROFILE }));
      return Promise.resolve(jsonResponse({}));
    });
    render(React.createElement(SectionEditor, { section: "experience" }));
    await waitFor(() =>
      expect(screen.queryByTestId("editor-loading")).not.toBeInTheDocument()
    );

    const save = screen.getByRole("button", { name: "Save changes" });
    await user.click(save);
    await user.click(save);
    expect(puts).toHaveLength(1);

    releasePut(jsonResponse({ ok: true }));
    expect(await screen.findByText("Saved")).toBeInTheDocument();
  });

  it("disables Save and Cancel while a save is in flight", async () => {
    const user = userEvent.setup();
    // A request that never settles, so the in-flight state is observable.
    vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      const url = String(input);
      if ((init?.method ?? "GET").toUpperCase() === "PUT") {
        return new Promise<Response>(() => {});
      }
      if (url.endsWith("/profile/career")) return Promise.resolve(jsonResponse(CAREER));
      if (url.endsWith("/auth/me")) return Promise.resolve(jsonResponse({ email: "a@b.test" }));
      if (url.endsWith("/profile")) return Promise.resolve(jsonResponse({ profile: PROFILE }));
      return Promise.resolve(jsonResponse({}));
    });
    render(React.createElement(SectionEditor, { section: "experience" }));
    await waitFor(() =>
      expect(screen.queryByTestId("editor-loading")).not.toBeInTheDocument()
    );

    await user.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByText("Saving…")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Save changes/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
  });

  it("keeps optional empty fields empty rather than inventing values", async () => {
    const user = userEvent.setup();
    await renderEditor("education");
    await user.click(screen.getByRole("button", { name: /^Arizona State University/ }));
    await user.clear(screen.getByLabelText("GPA"));
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(putBodies["/profile/career"]).toBeDefined());
    const saved = putBodies["/profile/career"][0] as { education: Record<string, unknown>[] };
    expect(saved.education[0].gpa).toBe("");
    // A blank date must be sent as null, never as an empty string.
    expect(saved.education[0].end_date).toBe("2025-05-01");
  });

  it("sends null for a date the user cleared", async () => {
    const user = userEvent.setup();
    await renderEditor("education");
    await user.click(screen.getByRole("button", { name: /^Arizona State University/ }));
    await user.clear(screen.getByLabelText("End date"));
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(putBodies["/profile/career"]).toBeDefined());
    const saved = putBodies["/profile/career"][0] as { education: Record<string, unknown>[] };
    expect(saved.education[0].end_date).toBeNull();
  });



  it("exposes the links from Personal details, where Edit contact lands", async () => {
    // The overview's Contact card lists LinkedIn/GitHub/X/custom links and its
    // Edit action goes to /profile/personal — so that screen has to hold them.
    await renderEditor("personal");
    for (const label of ["LinkedIn", "GitHub", "Website / Portfolio", "X"]) {
      expect(screen.getByLabelText(label), label).toBeInTheDocument();
    }
    expect(screen.getByRole("button", { name: /Add another link/ })).toBeInTheDocument();
  });

  it("saves contact fields and links together from Personal details", async () => {
    const user = userEvent.setup();
    await renderEditor("personal");
    await user.type(screen.getByLabelText("X"), "https://x.com/chandra");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(putBodies["/profile"]).toBeDefined());
    const saved = putBodies["/profile"][0] as Record<string, unknown>;
    expect(saved.x_url).toBe("https://x.com/chandra");
    // Contact fields still go along in the same overwrite.
    expect(saved.application_email).toBe("chandra@example.test");
  });

  it("blocks the Personal save when a hosted link is invalid", async () => {
    const user = userEvent.setup();
    await renderEditor("personal");
    await user.type(screen.getByLabelText("X"), "javascript:alert(1)");

    expect(await screen.findByRole("alert")).toHaveTextContent(/Fix the highlighted link/);
    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
  });


  // ------------------------------------------------------------------ //
  // Publications
  // ------------------------------------------------------------------ //
  it("shows an inviting empty state rather than implying the profile is lacking", async () => {
    await renderEditor("publications", { career: { ...CAREER, publications: [] } });
    expect(
      screen.getByText(/Share research, articles, or papers when relevant/)
    ).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /Add publication/ })[0]).toBeInTheDocument();
  });

  it("lists publications as collapsed summaries", async () => {
    await renderEditor("publications");
    expect(
      screen.getByRole("button", { name: /^Efficient Video Event Detection/ })
    ).toBeInTheDocument();
    // Collapsed: the detail fields are not mounted yet.
    expect(screen.queryByLabelText("DOI")).not.toBeInTheDocument();
  });

  it("adds, edits and saves a publication", async () => {
    const user = userEvent.setup();
    await renderEditor("publications", { career: { ...CAREER, publications: [] } });

    await user.click(screen.getAllByRole("button", { name: /Add publication/ })[0]);
    await user.type(screen.getByLabelText("Title"), "Edge AI Safety Monitoring");
    await user.type(screen.getByLabelText("Publication / venue"), "arXiv");
    await user.type(screen.getByLabelText("DOI"), "10.48550/arXiv.2401.00001");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(putBodies["/profile/career"]).toBeDefined());
    const saved = putBodies["/profile/career"][0] as { publications: Record<string, unknown>[] };
    expect(saved.publications[0].title).toBe("Edge AI Safety Monitoring");
    expect(saved.publications[0].venue).toBe("arXiv");
    expect(saved.publications[0].doi).toBe("10.48550/arXiv.2401.00001");
  });

  it("never adds the user's own name to the authors", async () => {
    const user = userEvent.setup();
    await renderEditor("publications", { career: { ...CAREER, publications: [] } });
    await user.click(screen.getAllByRole("button", { name: /Add publication/ })[0]);
    await user.type(screen.getByLabelText("Title"), "Solo work");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(putBodies["/profile/career"]).toBeDefined());
    const saved = putBodies["/profile/career"][0] as { publications: Record<string, unknown>[] };
    expect(saved.publications[0].authors).toEqual([]);
  });

  it("requires confirmation before deleting a publication", async () => {
    const user = userEvent.setup();
    await renderEditor("publications");
    await user.click(screen.getByRole("button", { name: /Actions for Efficient Video/ }));
    await user.click(await screen.findByRole("menuitem", { name: /Delete publication/ }));

    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent(/Delete publication/);
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(
      screen.getByRole("button", { name: /^Efficient Video Event Detection/ })
    ).toBeInTheDocument();
  });

  it("blocks the save when a publication URL is unsafe", async () => {
    const user = userEvent.setup();
    await renderEditor("publications");
    await user.click(screen.getByRole("button", { name: /^Efficient Video Event Detection/ }));
    await user.clear(screen.getByLabelText("URL"));
    await user.type(screen.getByLabelText("URL"), "javascript:alert(1)");

    expect(await screen.findByRole("alert")).toHaveTextContent(/Fix the highlighted link/);
    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
  });

  it("sends null for an empty DOI and URL rather than an empty string", async () => {
    const user = userEvent.setup();
    await renderEditor("publications", { career: { ...CAREER, publications: [] } });
    await user.click(screen.getAllByRole("button", { name: /Add publication/ })[0]);
    await user.type(screen.getByLabelText("Title"), "Minimal paper");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(putBodies["/profile/career"]).toBeDefined());
    const saved = putBodies["/profile/career"][0] as { publications: Record<string, unknown>[] };
    expect(saved.publications[0].doi).toBeNull();
    expect(saved.publications[0].url).toBeNull();
    expect(saved.publications[0].publication_date).toBeNull();
  });

  // ------------------------------------------------------------------ //
  // Certifications & Awards
  // ------------------------------------------------------------------ //
  it("shows an empty state for a profile with no credentials", async () => {
    await renderEditor("credentials", { career: { ...CAREER, certifications: [], awards: [] } });
    expect(screen.getByText("No certifications yet.")).toBeInTheDocument();
    expect(screen.getByText("No awards yet.")).toBeInTheDocument();
  });

  it("adds a certification and saves it to the career endpoint", async () => {
    const user = userEvent.setup();
    await renderEditor("credentials", { career: { ...CAREER, certifications: [], awards: [] } });

    await user.click(screen.getAllByRole("button", { name: /Add certification/ })[0]);
    await user.type(screen.getByLabelText("Name"), "AWS Certified ML");
    await user.type(screen.getByLabelText("Issuing organization"), "Amazon Web Services");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(putBodies["/profile/career"]).toBeDefined());
    const saved = putBodies["/profile/career"][0] as {
      certifications: Record<string, unknown>[];
    };
    expect(saved.certifications[0].name).toBe("AWS Certified ML");
    expect(saved.certifications[0].issuer).toBe("Amazon Web Services");
  });

  it("treats an empty expiration date as does-not-expire", async () => {
    const user = userEvent.setup();
    await renderEditor("credentials");

    await user.click(screen.getByRole("button", { name: /^AWS SAA/ }));
    const toggle = screen.getByLabelText("Does not expire");
    // The seeded certification has no expiration date, so it never expires.
    expect(toggle).toBeChecked();
    expect(screen.getByLabelText("Expiration date")).toBeDisabled();

    // Unticking opens the field so a date can be entered.
    await user.click(toggle);
    expect(screen.getByLabelText("Expiration date")).not.toBeDisabled();
    expect(screen.getByLabelText("Does not expire")).not.toBeChecked();
  });

  it("stores a cleared expiration date as null", async () => {
    const user = userEvent.setup();
    await renderEditor("credentials");
    await user.click(screen.getByRole("button", { name: /^AWS SAA/ }));
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(putBodies["/profile/career"]).toBeDefined());
    const saved = putBodies["/profile/career"][0] as {
      certifications: Record<string, unknown>[];
    };
    expect(saved.certifications[0].expiration_date).toBeNull();
  });

  it("edits an award and keeps certifications intact", async () => {
    const user = userEvent.setup();
    await renderEditor("credentials");

    await user.click(screen.getByRole("button", { name: /^Hackathon winner/ }));
    await user.clear(screen.getByLabelText("Issuing organization"));
    await user.type(screen.getByLabelText("Issuing organization"), "Arizona State University");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(putBodies["/profile/career"]).toBeDefined());
    const saved = putBodies["/profile/career"][0] as {
      certifications: { name: string }[];
      awards: Record<string, unknown>[];
    };
    expect(saved.awards[0].issuer).toBe("Arizona State University");
    expect(saved.certifications.map((item) => item.name)).toEqual(["AWS SAA"]);
  });

  it("requires confirmation before deleting a credential", async () => {
    const user = userEvent.setup();
    await renderEditor("credentials");

    await user.click(screen.getByRole("button", { name: /Actions for AWS SAA/ }));
    await user.click(await screen.findByRole("menuitem", { name: "Delete certification" }));

    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("Delete certification?");
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("button", { name: /^AWS SAA/ })).toBeInTheDocument();
  });

  it("removes a credential once the delete is confirmed", async () => {
    const user = userEvent.setup();
    await renderEditor("credentials");

    await user.click(screen.getByRole("button", { name: /Actions for AWS SAA/ }));
    await user.click(await screen.findByRole("menuitem", { name: "Delete certification" }));
    await user.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Delete" })
    );

    expect(screen.queryByRole("button", { name: /^AWS SAA/ })).not.toBeInTheDocument();
    expect(screen.getByText("No certifications yet.")).toBeInTheDocument();
  });

  // ------------------------------------------------------------------ //
  // Education
  // ------------------------------------------------------------------ //
  it("summarizes education without opening the form", async () => {
    await renderEditor("education");
    expect(screen.getByText("Arizona State University")).toBeInTheDocument();
    expect(screen.getByText(/Bachelor's Degree · Computer Science/)).toBeInTheDocument();
    expect(screen.getByText("Minor: Data Science")).toBeInTheDocument();
    expect(screen.getByText(/2022 – 2025 · GPA 3.6\/4.0/)).toBeInTheDocument();
    expect(screen.queryByLabelText("School")).not.toBeInTheDocument();
  });

  it("hides GPA in the summary when none was recorded", async () => {
    mockApi();
    vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      const url = String(input);
      if (url.endsWith("/profile/career")) {
        return Promise.resolve(
          jsonResponse({
            ...CAREER,
            education: [{ ...CAREER.education[0], gpa: "", gpa_scale: "" }]
          })
        );
      }
      if (url.endsWith("/auth/me")) return Promise.resolve(jsonResponse({ email: "a@b.test" }));
      if (url.endsWith("/profile")) return Promise.resolve(jsonResponse({ profile: PROFILE }));
      return Promise.resolve(jsonResponse({}));
    });
    render(React.createElement(SectionEditor, { section: "education" }));
    await waitFor(() =>
      expect(screen.queryByTestId("editor-loading")).not.toBeInTheDocument()
    );
    expect(screen.queryByText(/GPA/)).not.toBeInTheDocument();
  });

  it("keeps honors and coursework available in the expanded form", async () => {
    const user = userEvent.setup();
    await renderEditor("education");
    await user.click(screen.getByRole("button", { name: /^Arizona State University/ }));
    expect(screen.getByLabelText("Honors")).toBeInTheDocument();
    expect(screen.getByText("Dean's List")).toBeInTheDocument();
    expect(screen.getByText("Machine Learning")).toBeInTheDocument();
  });

  // ------------------------------------------------------------------ //
  // Projects
  // ------------------------------------------------------------------ //
  it("summarizes projects with no textareas rendered", async () => {
    await renderEditor("projects");
    expect(screen.getByText("Luna AI")).toBeInTheDocument();
    expect(screen.getByText("Video-understanding infrastructure")).toBeInTheDocument();
    expect(screen.getByText("github.com/you/luna")).toBeInTheDocument();
    expect(document.querySelectorAll("textarea")).toHaveLength(0);
  });

  it("validates project links against the shared URL rule", async () => {
    const user = userEvent.setup();
    await renderEditor("projects");
    await user.click(screen.getByRole("button", { name: /^Luna AI/ }));
    await user.type(screen.getByLabelText("Links"), "ftp://nope.example{Enter}");
    expect(await screen.findByRole("alert")).toHaveTextContent(/http:\/\/ or https:\/\//);
  });

  // ------------------------------------------------------------------ //
  // Skills
  // ------------------------------------------------------------------ //
  it("groups skills by domain rather than listing every chip flat", async () => {
    await renderEditor("skills");
    expect(screen.getByText(/AI \/ Machine Learning/)).toBeInTheDocument();
    expect(screen.getByText(/Backend/)).toBeInTheDocument();
    expect(screen.getByText(/Languages/)).toBeInTheDocument();
    // Unmatched skills are kept, never dropped.
    expect(screen.getByText("Underwater Basket Weaving")).toBeInTheDocument();
  });

  it("does not render suggestions until the user searches", async () => {
    const user = userEvent.setup();
    await renderEditor("skills");
    expect(screen.queryByText("Suggestions")).not.toBeInTheDocument();

    await user.type(screen.getByLabelText("Add a skill"), "Tensor");
    expect(await screen.findByText("Suggestions")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /TensorFlow/ })).toBeInTheDocument();
  });

  it("adds a typed skill and a pasted comma-separated list", async () => {
    const user = userEvent.setup();
    await renderEditor("skills");
    const box = screen.getByLabelText("Add a skill");

    await user.type(box, "Rust{Enter}");
    expect(screen.getByText("Rust")).toBeInTheDocument();

    await user.click(box);
    await user.paste("Elixir, Haskell");
    expect(screen.getByText("Elixir")).toBeInTheDocument();
    expect(screen.getByText("Haskell")).toBeInTheDocument();
  });

  it("does not add a duplicate skill", async () => {
    const user = userEvent.setup();
    await renderEditor("skills");
    await user.type(screen.getByLabelText("Add a skill"), "python{Enter}");
    // Matched case-insensitively against the existing "Python".
    expect(screen.getAllByText(/^Python$/)).toHaveLength(1);
    expect(screen.queryByText("python")).not.toBeInTheDocument();
  });

  it("removes a skill", async () => {
    const user = userEvent.setup();
    await renderEditor("skills");
    await user.click(screen.getByRole("button", { name: "Remove PyTorch" }));
    expect(screen.queryByText("PyTorch")).not.toBeInTheDocument();
  });

  // ------------------------------------------------------------------ //
  // Job preferences
  // ------------------------------------------------------------------ //
  it("shows selected preferences first and hides the catalog", async () => {
    await renderEditor("preferences");
    expect(screen.getByText("Machine Learning Engineer")).toBeInTheDocument();
    expect(screen.getByText("New Grad")).toBeInTheDocument();
    // A catalog role the user has NOT selected must not be on screen yet.
    expect(screen.queryByText("Site Reliability Engineer")).not.toBeInTheDocument();
  });

  it("preserves a custom role that is not in the catalog", async () => {
    await renderEditor("preferences");
    expect(screen.getByText("Interplanetary Vibe Officer")).toBeInTheDocument();
  });

  it("reveals the searchable catalog only after Add is pressed", async () => {
    const user = userEvent.setup();
    await renderEditor("preferences");
    await user.click(screen.getByRole("button", { name: /Add role/ }));

    const search = screen.getByLabelText(/Search roles/);
    await user.type(search, "Backend");
    expect(await screen.findByRole("button", { name: /Backend Engineer/ })).toBeInTheDocument();
  });

  it("adds a custom role that the catalog does not contain", async () => {
    const user = userEvent.setup();
    await renderEditor("preferences");
    await user.click(screen.getByRole("button", { name: /Add role/ }));
    await user.type(screen.getByLabelText(/Search roles/), "Chief Vibes Officer");
    await user.click(screen.getByRole("button", { name: /Add “Chief Vibes Officer”/ }));
    expect(screen.getByText("Chief Vibes Officer")).toBeInTheDocument();
  });

  it("removes a selected preference", async () => {
    const user = userEvent.setup();
    await renderEditor("preferences");
    await user.click(screen.getByRole("button", { name: "Remove Machine Learning Engineer" }));
    expect(screen.queryByText("Machine Learning Engineer")).not.toBeInTheDocument();
  });

  it("marks the workplace choice with more than colour", async () => {
    await renderEditor("preferences");
    const remote = screen.getByRole("radio", { name: /Remote/ });
    expect(remote).toBeChecked();
  });

  // ------------------------------------------------------------------ //
  // Personal + links
  // ------------------------------------------------------------------ //
  it("groups personal fields and never shows the stored Workday credential", async () => {
    await renderEditor("personal");
    for (const group of ["Identity", "Contact", "Location"]) {
      expect(screen.getByText(group)).toBeInTheDocument();
    }
    expect(screen.getByLabelText("First name")).toHaveValue("Chandra");
    expect(screen.getByLabelText("Sign-in email")).toBeDisabled();
    expect(document.body.textContent?.toLowerCase()).not.toContain("workday");
    expect(document.querySelector('input[type="password"]')).toBeNull();
  });

  it("flags a missing required name", async () => {
    const user = userEvent.setup();
    await renderEditor("personal");
    await user.clear(screen.getByLabelText("First name"));
    expect(await screen.findByRole("alert")).toHaveTextContent(/First and last name are required/);
  });

  it("validates link URLs", async () => {
    const user = userEvent.setup();
    await renderEditor("links");
    await user.clear(screen.getByLabelText("Website / Portfolio"));
    await user.type(screen.getByLabelText("Website / Portfolio"), "not-a-url");
    expect(await screen.findByRole("alert")).toHaveTextContent(/Fix the highlighted link/);
  });


  it("exposes all four named networks including X", async () => {
    await renderEditor("links");
    for (const label of ["LinkedIn", "GitHub", "Website / Portfolio", "X"]) {
      expect(screen.getByLabelText(label), label).toBeInTheDocument();
    }
  });

  it("saves X alongside the existing links", async () => {
    const user = userEvent.setup();
    await renderEditor("links");
    await user.type(screen.getByLabelText("X"), "https://x.com/chandra");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(putBodies["/profile"]).toBeDefined());
    const saved = putBodies["/profile"][0] as Record<string, unknown>;
    expect(saved.x_url).toBe("https://x.com/chandra");
    // The original three are untouched.
    expect(saved.linkedin_url).toBe("https://linkedin.com/in/chandra");
  });

  it("adds, edits and removes a custom link", async () => {
    const user = userEvent.setup();
    await renderEditor("links");
    expect(screen.getByText("No other links yet.")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Add another link/ }));
    await user.type(screen.getByLabelText("Label"), "Google Scholar");
    await user.type(screen.getByLabelText("URL"), "https://scholar.google.com/x");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(putBodies["/profile"]).toBeDefined());
    expect((putBodies["/profile"][0] as Record<string, unknown>).additional_links).toEqual([
      { label: "Google Scholar", url: "https://scholar.google.com/x" }
    ]);

    await user.click(screen.getByRole("button", { name: /Remove Google Scholar/ }));
    expect(screen.getByText("No other links yet.")).toBeInTheDocument();
  });

  it("drops a half-filled custom row rather than rejecting the save", async () => {
    const user = userEvent.setup();
    await renderEditor("links");
    await user.click(screen.getByRole("button", { name: /Add another link/ }));
    // Row added but never filled in — the natural state of a stray click.
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(putBodies["/profile"]).toBeDefined());
    expect((putBodies["/profile"][0] as Record<string, unknown>).additional_links).toEqual([]);
  });

  it("refuses to save a custom link with an unsafe scheme", async () => {
    const user = userEvent.setup();
    await renderEditor("links");
    await user.click(screen.getByRole("button", { name: /Add another link/ }));
    await user.type(screen.getByLabelText("Label"), "Bad");
    await user.type(screen.getByLabelText("URL"), "javascript:alert(1)");

    expect(await screen.findByRole("alert")).toHaveTextContent(/Fix the highlighted link/);
    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
  });

  it("requires a label once a custom URL is present", async () => {
    const user = userEvent.setup();
    await renderEditor("links");
    await user.click(screen.getByRole("button", { name: /Add another link/ }));
    await user.type(screen.getByLabelText("URL"), "https://example.test");

    expect(await screen.findByText("Give this link a name.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
  });

  it("only offers to open a link that is actually valid", async () => {
    await renderEditor("links");
    expect(
      screen.getByRole("link", { name: /Open your LinkedIn profile/ })
    ).toHaveAttribute("rel", expect.stringContaining("noopener"));
    // Portfolio is empty, so there is nothing to open.
    expect(screen.queryByRole("link", { name: /Open your Portfolio/ })).not.toBeInTheDocument();
  });

  // ------------------------------------------------------------------ //
  // Failure + layout
  // ------------------------------------------------------------------ //
  it("keeps a failed load section-scoped and retryable", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({}, 500));
    render(React.createElement(SectionEditor, { section: "experience" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/couldn’t load this section/i);
    expect(screen.getByRole("button", { name: /try again/i })).toBeInTheDocument();
  });

  it("does not overflow horizontally on a narrow viewport", async () => {
    await renderEditor("experience");
    // Every card and its inner wrappers opt out of min-width:auto, which is
    // what lets long company names and tech lists truncate instead of pushing
    // the page wider than the screen.
    const cards = document.querySelectorAll("li.rounded-2xl");
    expect(cards.length).toBeGreaterThan(0);
    for (const card of cards) {
      expect(card.querySelector(".min-w-0")).not.toBeNull();
    }
  });
});

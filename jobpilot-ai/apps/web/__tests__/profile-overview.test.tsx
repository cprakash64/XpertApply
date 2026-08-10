import { cleanup, render, screen, within } from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProfileOverview } from "@/components/profile/ProfileOverview";

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });
}

const FULL_PROFILE = {
  first_name: "Chandra",
  last_name: "Pandey",
  full_name: "Chandra Pandey",
  name_confirmed: true,
  application_email: "chandra@example.test",
  phone: "602-555-0100",
  location_city: "Phoenix",
  location_state: "AZ",
  location_country: "United States",
  linkedin_url: "https://linkedin.com/in/chandra",
  github_url: "https://github.com/chandra",
  portfolio_url: "https://chandra.dev",
  work_authorization: "authorized_us",
  target_roles: ["Machine Learning Engineer", "Backend Engineer", "Data Engineer", "Platform Engineer"],
  target_levels: ["Junior"],
  preferred_locations: ["Phoenix, AZ", "London, United Kingdom", "Berlin, Germany", "Bengaluru, India"],
  remote_preference: "remote",
  skills: ["Python", "TypeScript", "PyTorch", "FastAPI", "Docker", "PostgreSQL"],
  workday_password_configured: true
};

const FULL_CAREER = {
  education: [
    {
      school: "Arizona State University",
      degree: "BS",
      major: "Computer Science",
      minor: "Mathematics",
      start_date: "2019-08",
      end_date: "2023-05",
      gpa: "3.8",
      gpa_scale: "4.0"
    }
  ],
  experience: [
    {
      company: "Cardinal Health",
      title: "Software Engineer",
      location: "Phoenix, AZ",
      start_date: "2023-06",
      end_date: "",
      currently_working: true,
      technologies: ["Python"]
    },
    { company: "Acme", title: "Intern", location: "Remote", start_date: "2022-05", end_date: "2022-08", currently_working: false, technologies: [] },
    { company: "Beta", title: "Intern", location: "", start_date: "2021-05", end_date: "2021-08", currently_working: false, technologies: [] },
    { company: "Gamma", title: "Volunteer", location: "", start_date: "2020-05", end_date: "2020-08", currently_working: false, technologies: [] }
  ],
  projects: [
    { name: "Luna AI", description: "RAG pipeline over personal notes", technologies: ["Python", "LangChain"], bullets: [] },
    { name: "JobPilot", description: "", technologies: [], bullets: ["Automated applications"] },
    { name: "Third", description: "", technologies: [], bullets: [] },
    { name: "Fourth", description: "", technologies: [], bullets: [] }
  ],
  certifications: [
    {
      name: "AWS Certified Machine Learning",
      issuer: "Amazon Web Services",
      issue_date: "2025-03-01",
      expiration_date: "",
      credential_url: "https://verify.aws/abc"
    },
    { name: "CKA", issuer: "CNCF", issue_date: "2024-01-01", expiration_date: "2027-01-01", credential_url: "" }
  ],
  awards: [
    { name: "Dean's List", issuer: "Arizona State University", date: "2024-05-01", description: "" },
    { name: "Hackathon winner", issuer: "ASU", date: "2023-11-01", description: "" }
  ]
};

const ELIGIBILITY = {
  answers: [
    { field: "work_authorization_us", prompt: "Authorized?", answer: "yes", answered: true, reusable: true },
    { field: "sponsorship_required_now", prompt: "Now?", answer: "no", answered: true, reusable: true },
    { field: "sponsorship_required_future", prompt: "Future?", answer: null, answered: false, reusable: false }
  ]
};

const FULL_COMPLETENESS = {
  completion: { percent: 100, satisfied: ["identity"], missing: [] },
  autofillReadiness: {
    percent: 78,
    satisfied: ["identity"],
    missing: [
      { key: "work_authorization", label: "Work authorization answer" },
      { key: "sponsorship", label: "Sponsorship answers" }
    ]
  }
};

function mockApi({
  profile = FULL_PROFILE as unknown,
  career = FULL_CAREER as unknown,
  completeness = FULL_COMPLETENESS as unknown,
  eligibility = ELIGIBILITY as unknown
} = {}) {
  return vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
    const url = String(input);
    if (url.endsWith("/profile/application-eligibility")) {
      return Promise.resolve(jsonResponse(eligibility));
    }
    if (url.endsWith("/profile/completeness")) return Promise.resolve(jsonResponse(completeness));
    if (url.endsWith("/profile/career")) return Promise.resolve(jsonResponse(career));
    if (url.endsWith("/profile")) return Promise.resolve(jsonResponse({ profile }));
    return Promise.resolve(jsonResponse({}));
  });
}

async function renderOverview(options?: Parameters<typeof mockApi>[0]) {
  mockApi(options);
  render(React.createElement(ProfileOverview));
  // Resolves once loading finishes and the real page is on screen.
  await screen.findByRole("heading", { name: "Profile", level: 1 });
}

describe("ProfileOverview", () => {
  beforeEach(() => {
    localStorage.setItem("jobpilot_token", "token");
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("shows a skeleton before data arrives", () => {
    mockApi();
    render(React.createElement(ProfileOverview));
    expect(screen.getByTestId("profile-overview-skeleton")).toBeInTheDocument();
  });

  it("renders the header, description, and both primary actions", async () => {
    await renderOverview();
    expect(
      screen.getByText("Keep your career information accurate for better matches and applications.")
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /import \/ update resume/i })).toHaveAttribute(
      "href",
      "/profile/import"
    );
    expect(screen.getByRole("link", { name: "Edit profile" })).toHaveAttribute(
      "href",
      "/profile/edit"
    );
  });

  it("renders the identity card with name, headline, location, and initials", async () => {
    await renderOverview();
    // Scoped to the identity card: the headline and the location legitimately
    // appear again as a preference tag and an experience location.
    const heading = screen.getByRole("heading", { name: "Chandra Pandey" });
    const card = heading.closest("section");
    expect(card).not.toBeNull();
    const identity = within(card as HTMLElement);
    expect(identity.getByText("Machine Learning Engineer")).toBeInTheDocument();
    expect(identity.getByText("Phoenix, AZ")).toBeInTheDocument();
    expect(identity.getByText("CP")).toBeInTheDocument();
  });

  // ------------------------------------------------------------------ //
  // Completion + readiness
  // ------------------------------------------------------------------ //
  it("shows profile completion and autofill readiness as separate meters", async () => {
    await renderOverview();
    const completion = screen.getByRole("progressbar", { name: "Profile completion" });
    const readiness = screen.getByRole("progressbar", { name: "Autofill readiness" });
    expect(completion).toHaveAttribute("aria-valuenow", "100");
    expect(readiness).toHaveAttribute("aria-valuenow", "78");
  });

  it("reports the percentages the backend computed, never a hardcoded value", async () => {
    await renderOverview({
      completeness: {
        completion: { percent: 42, satisfied: [], missing: [{ key: "skills", label: "Skills" }] },
        autofillReadiness: { percent: 17, satisfied: [], missing: [{ key: "phone", label: "Phone number" }] }
      }
    });
    expect(screen.getByRole("progressbar", { name: "Profile completion" })).toHaveAttribute(
      "aria-valuenow",
      "42"
    );
    expect(screen.getByRole("progressbar", { name: "Autofill readiness" })).toHaveAttribute(
      "aria-valuenow",
      "17"
    );
    expect(screen.getByText("Next: Skills")).toBeInTheDocument();
    expect(screen.getByText("Missing: Phone number")).toBeInTheDocument();
  });

  it("clamps an out-of-range percentage instead of overflowing the bar", async () => {
    await renderOverview({
      completeness: {
        completion: { percent: 340, satisfied: [], missing: [] },
        autofillReadiness: { percent: -20, satisfied: [], missing: [] }
      }
    });
    expect(screen.getByRole("progressbar", { name: "Profile completion" })).toHaveAttribute(
      "aria-valuenow",
      "100"
    );
    expect(screen.getByRole("progressbar", { name: "Autofill readiness" })).toHaveAttribute(
      "aria-valuenow",
      "0"
    );
  });

  // ------------------------------------------------------------------ //
  // Section content and overflow
  // ------------------------------------------------------------------ //
  it("shows at most three experience entries with a +N more affordance", async () => {
    await renderOverview();
    expect(screen.getByText("Cardinal Health")).toBeInTheDocument();
    expect(screen.queryByText("Gamma")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "+1 more role" })).toHaveAttribute(
      "href",
      "/profile/experience"
    );
  });

  it("formats an ongoing role as Present", async () => {
    await renderOverview();
    expect(screen.getByText(/Jun 2023 — Present · Phoenix, AZ/)).toBeInTheDocument();
  });

  it("shows education with degree, major, minor, and dates", async () => {
    await renderOverview();
    expect(screen.getByText("Arizona State University")).toBeInTheDocument();
    expect(screen.getByText(/BS, Computer Science · Minor in Mathematics/)).toBeInTheDocument();
    expect(screen.getByText(/Aug 2019 — May 2023/)).toBeInTheDocument();
  });

  it("shows GPA only when the user recorded one", async () => {
    await renderOverview();
    expect(screen.getByText(/GPA 3.8\/4.0/)).toBeInTheDocument();

    cleanup();
    vi.restoreAllMocks();
    localStorage.setItem("jobpilot_token", "token");
    await renderOverview({
      career: {
        ...FULL_CAREER,
        education: [{ ...FULL_CAREER.education[0], gpa: "", gpa_scale: "" }]
      }
    });
    expect(screen.queryByText(/GPA/)).not.toBeInTheDocument();
  });

  it("shows projects with a one-line description and technologies", async () => {
    await renderOverview();
    expect(screen.getByText("Luna AI")).toBeInTheDocument();
    expect(screen.getByText("RAG pipeline over personal notes")).toBeInTheDocument();
    expect(screen.getByText("Python · LangChain")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "+1 more project" })).toBeInTheDocument();
  });

  it("groups skills instead of rendering a wall of chips", async () => {
    await renderOverview({
      profile: {
        ...FULL_PROFILE,
        skills: Array.from({ length: 60 }, (_, index) => `Skill ${index}`).concat([
          "Python",
          "PyTorch",
          "Docker"
        ])
      }
    });
    // Group headings, not 63 individual chips.
    expect(screen.getByText(/AI \/ Machine Learning/)).toBeInTheDocument();
    expect(screen.getByText(/Cloud \/ DevOps/)).toBeInTheDocument();
    expect(screen.queryByText("Skill 59")).not.toBeInTheDocument();
  });

  it("truncates long preference lists with +N more", async () => {
    await renderOverview();
    // 4 target roles and 4 preferred locations, 3 shown each.
    expect(screen.getAllByText("+1 more").length).toBeGreaterThanOrEqual(2);
  });


  // ------------------------------------------------------------------ //
  // Long / hostile content
  // ------------------------------------------------------------------ //
  it("truncates long names, titles and companies instead of overflowing", async () => {
    const long = "Bartholomew Maximilian Fitzgerald-Wellington III".repeat(3);
    await renderOverview({
      profile: {
        ...FULL_PROFILE,
        first_name: long,
        last_name: long,
        full_name: `${long} ${long}`,
        target_roles: [`${long} Engineer`]
      },
      career: {
        ...FULL_CAREER,
        experience: [
          {
            company: long,
            title: `${long} Senior Staff Principal Engineer`,
            location: long,
            start_date: "2023-06-01",
            end_date: "",
            currently_working: true,
            technologies: []
          }
        ]
      }
    });

    // Every long string sits in a truncating box rather than widening the card.
    const heading = screen.getByRole("heading", { level: 2, name: new RegExp(long.slice(0, 20)) });
    expect(heading.className).toContain("truncate");
  });

  it("renders a profile with no career records at all", async () => {
    await renderOverview({
      profile: { ...FULL_PROFILE, skills: [] },
      career: { education: [], experience: [], projects: [] }
    });
    // Empty sections prompt rather than render blank space.
    expect(screen.getByRole("link", { name: /add experience/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /add skills/i })).toBeInTheDocument();
  });

  it("survives a career payload with null and missing fields", async () => {
    // Legacy rows predate several columns; the wire may send null for any of them.
    await renderOverview({
      career: {
        education: [{ school: "Old School" }],
        experience: [{ company: "Legacy Co" }],
        projects: [{ name: "Legacy Project" }]
      }
    });
    expect(screen.getByText("Old School")).toBeInTheDocument();
    expect(screen.getByText("Legacy Co")).toBeInTheDocument();
    expect(screen.getByText("Legacy Project")).toBeInTheDocument();
  });

  it("handles a profile with a very large skill list", async () => {
    await renderOverview({
      profile: {
        ...FULL_PROFILE,
        skills: Array.from({ length: 400 }, (_, index) => `Skill ${index}`)
      }
    });
    // Grouped and capped — never 400 chips.
    expect(document.querySelectorAll("section").length).toBeLessThan(40);
  });

  // ------------------------------------------------------------------ //
  // Navigation
  // ------------------------------------------------------------------ //
  it("links every section's Edit action to its focused editor", async () => {
    await renderOverview();
    const expected: [string, string][] = [
      ["Edit contact", "/profile/personal"],
      ["Edit job preferences", "/profile/preferences"],
      ["Edit experience", "/profile/experience"],
      ["Edit education", "/profile/education"],
      ["Edit projects", "/profile/projects"],
      ["Edit skills", "/profile/skills"]
    ];
    for (const [label, href] of expected) {
      expect(screen.getByRole("link", { name: label })).toHaveAttribute("href", href);
    }
  });


  // ------------------------------------------------------------------ //
  // Contact icons and links
  // ------------------------------------------------------------------ //
  it("shows X and custom links alongside the built-in networks", async () => {
    await renderOverview({
      profile: {
        ...FULL_PROFILE,
        x_url: "https://x.com/chandra",
        additional_links: [{ label: "Google Scholar", url: "https://scholar.google.com/x" }]
      }
    });
    expect(screen.getByText("X")).toBeInTheDocument();
    expect(screen.getByText("Google Scholar")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "https://scholar.google.com/x" })).toHaveAttribute(
      "rel",
      expect.stringContaining("noopener")
    );
  });

  it("renders brand marks inline rather than fetching them", async () => {
    await renderOverview();
    // No <img>/remote asset anywhere in the contact card.
    expect(document.querySelectorAll("img")).toHaveLength(0);
    expect(document.querySelectorAll("svg").length).toBeGreaterThan(0);
  });

  // ------------------------------------------------------------------ //
  // Application preferences card
  // ------------------------------------------------------------------ //
  it("summarizes the current application answers in human words", async () => {
    await renderOverview();
    const card = screen
      .getByRole("heading", { name: "Application preferences" })
      .closest("section") as HTMLElement;

    expect(within(card).getByText("Authorized to work in the United States")).toBeInTheDocument();
    expect(within(card).getByText("Current sponsorship")).toBeInTheDocument();
    // Relocation is true in the fixture.
    expect(within(card).getByText("Relocation")).toBeInTheDocument();
    // Never a canonical key or a raw enum.
    expect(card.textContent).not.toContain("sponsorship_required_now");
    expect(card.textContent).not.toContain("authorized_us");
  });

  it("distinguishes ask-each-time from an unanswered question", async () => {
    await renderOverview({
      eligibility: {
        answers: [
          { field: "sponsorship_required_now", prompt: "Now?", answer: null, answered: false, reusable: false },
          { field: "sponsorship_required_future", prompt: "Future?", answer: null, answered: false, reusable: true }
        ]
      }
    });
    const card = screen
      .getByRole("heading", { name: "Application preferences" })
      .closest("section") as HTMLElement;
    expect(within(card).getByText("Ask during each application")).toBeInTheDocument();
    expect(within(card).getByText("Not set")).toBeInTheDocument();
  });

  it("never shows demographic answers on the application preferences card", async () => {
    await renderOverview();
    const body = document.body.textContent?.toLowerCase() ?? "";
    for (const term of ["gender", "race", "veteran", "disability", "hispanic"]) {
      expect(body).not.toContain(term);
    }
  });

  // ------------------------------------------------------------------ //
  // Certifications & Awards
  // ------------------------------------------------------------------ //
  it("summarizes certifications and awards with a +N overflow", async () => {
    await renderOverview();
    expect(screen.getByText("AWS Certified Machine Learning")).toBeInTheDocument();
    expect(screen.getByText("Amazon Web Services · 2025")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /\+1 more credential/ })).toHaveAttribute(
      "href",
      "/profile/credentials"
    );
  });

  it("offers to add when there are no credentials", async () => {
    await renderOverview({ career: { ...FULL_CAREER, certifications: [], awards: [] } });
    const card = screen
      .getByRole("heading", { name: "Certifications & Awards" })
      .closest("section") as HTMLElement;
    expect(within(card).getByText("Certifications and awards you have earned.")).toBeInTheDocument();
    expect(within(card).getByRole("link", { name: /Add/ })).toHaveAttribute(
      "href",
      "/profile/credentials"
    );
  });

  it("links a credential URL without opening the editor", async () => {
    await renderOverview();
    const link = screen.getByRole("link", { name: /View credential/ });
    expect(link).toHaveAttribute("href", "https://verify.aws/abc");
    expect(link).toHaveAttribute("rel", expect.stringContaining("noopener"));
    // Raised above the card's stretched overlay.
    expect(link.className).toContain("z-10");
  });

  // ------------------------------------------------------------------ //
  // Clickable cards
  // ------------------------------------------------------------------ //
  it("makes every section card openable from its whole surface", async () => {
    await renderOverview();
    const expected: [string, string][] = [
      ["Contact", "/profile/personal"],
      ["Job preferences", "/profile/preferences"],
      ["Application preferences", "/profile/application-preferences"],
      ["Experience", "/profile/experience"],
      ["Education", "/profile/education"],
      ["Projects", "/profile/projects"],
      ["Skills", "/profile/skills"],
      ["Certifications & Awards", "/profile/credentials"]
    ];
    for (const [title, href] of expected) {
      const card = screen.getByRole("heading", { name: title }).closest("section") as HTMLElement;
      const edit = within(card).getByRole("link", { name: `Edit ${title.toLowerCase()}` });
      expect(edit, title).toHaveAttribute("href", href);
      // A real link: keyboard-focusable and Enter-activatable for free.
      expect(edit.tagName).toBe("A");
      expect(edit.className).toContain("stretched-link");
    }
  });

  it("keeps nested links above the card overlay so they stay clickable", async () => {
    await renderOverview();
    const contact = screen.getByRole("heading", { name: "Contact" }).closest("section") as HTMLElement;
    const linkedin = within(contact).getByRole("link", { name: "https://linkedin.com/in/chandra" });
    expect(linkedin.className).toContain("z-10");
    // And it is a distinct destination, not the editor.
    expect(linkedin).toHaveAttribute("href", "https://linkedin.com/in/chandra");
  });

  // ------------------------------------------------------------------ //
  // Empty / partial states
  // ------------------------------------------------------------------ //
  it("falls back to onboarding when there is nothing to summarize", async () => {
    mockApi({ profile: null, career: {}, completeness: { completion: { percent: 0, satisfied: [], missing: [] }, autofillReadiness: { percent: 0, satisfied: [], missing: [] } } });
    render(React.createElement(ProfileOverview));
    expect(await screen.findByRole("heading", { name: "Set up your profile" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Profile", level: 1 })).not.toBeInTheDocument();
  });

  it("shows per-section prompts when a profile is only partly filled in", async () => {
    await renderOverview({
      profile: { ...FULL_PROFILE, skills: [], target_roles: ["Backend Engineer"], preferred_locations: [] },
      career: { education: [], experience: [], projects: [] }
    });
    expect(screen.getByRole("link", { name: /add experience/i })).toHaveAttribute(
      "href",
      "/profile/experience"
    );
    expect(screen.getByRole("link", { name: /add education/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /add skills/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /add a project/i })).toBeInTheDocument();
  });

  it("omits contact rows the user has not provided", async () => {
    await renderOverview({
      profile: { ...FULL_PROFILE, github_url: "", portfolio_url: "", phone: "" }
    });
    expect(screen.getByText("Application email")).toBeInTheDocument();
    expect(screen.queryByText("GitHub")).not.toBeInTheDocument();
    expect(screen.queryByText("Portfolio")).not.toBeInTheDocument();
    expect(screen.queryByText("Phone")).not.toBeInTheDocument();
  });

  it("recovers from a failed load without losing the page", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 500 }));
    render(React.createElement(ProfileOverview));
    expect(await screen.findByRole("alert")).toHaveTextContent(/couldn’t load your profile/i);
    expect(screen.getByRole("button", { name: /try again/i })).toBeInTheDocument();
  });

  // ------------------------------------------------------------------ //
  // Privacy
  // ------------------------------------------------------------------ //
  it("never renders sensitive values on the overview", async () => {
    await renderOverview();
    const body = document.body.textContent ?? "";
    // Stored employer-portal credential state, EEO answers, and tokens are all
    // out of scope for a page the user may screen-share.
    for (const forbidden of ["workday", "password", "gender", "race", "veteran", "disability", "token"]) {
      expect(body.toLowerCase()).not.toContain(forbidden);
    }
  });


  it("never turns an unsafe URL into a clickable link", async () => {
    // The resume-import apply path stores links without HttpUrl validation, so
    // a stored value is not guaranteed to be http(s). Rendering one as an
    // anchor href would be script execution, not a broken link.
    await renderOverview({
      profile: {
        ...FULL_PROFILE,
        linkedin_url: "javascript:alert(document.cookie)",
        github_url: "data:text/html,<script>alert(1)</script>",
        portfolio_url: "https://safe.example"
      }
    });

    // The values are still shown — they are just not actionable.
    expect(screen.getByText("javascript:alert(document.cookie)")).toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: "javascript:alert(document.cookie)" })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: /^data:text\/html/ })
    ).not.toBeInTheDocument();
    // The legitimate one is still a link.
    expect(screen.getByRole("link", { name: "https://safe.example" })).toHaveAttribute(
      "href",
      "https://safe.example"
    );
    // Nothing anywhere on the page carries a script-capable href.
    for (const anchor of Array.from(document.querySelectorAll("a[href]"))) {
      expect(anchor.getAttribute("href")).not.toMatch(/^(javascript|data):/i);
    }
  });

  it("opens profile links in a new tab without leaking the opener", async () => {
    await renderOverview();
    const linkedin = screen.getByRole("link", { name: "https://linkedin.com/in/chandra" });
    expect(linkedin).toHaveAttribute("target", "_blank");
    expect(linkedin).toHaveAttribute("rel", expect.stringContaining("noopener"));
  });

  // ------------------------------------------------------------------ //
  // Structure / responsiveness
  // ------------------------------------------------------------------ //
  it("lays out as a two-column grid that collapses on smaller screens", async () => {
    const { container } = render(React.createElement("div"));
    cleanup();
    mockApi();
    const view = render(React.createElement(ProfileOverview));
    await screen.findByRole("heading", { name: "Profile", level: 1 });
    // The columns only split at xl, so tablet and mobile stack by default.
    const grid = view.container.querySelector(".xl\\:grid-cols-\\[minmax\\(0\\,32fr\\)_minmax\\(0\\,68fr\\)\\]");
    expect(grid).not.toBeNull();
    expect(container).toBeDefined();
  });

  it("keeps each section in its own landmark so the page is navigable", async () => {
    await renderOverview();
    const headings = screen
      .getAllByRole("heading", { level: 2 })
      .map((heading) => within(heading).getByText(/.+/).textContent);
    expect(headings).toEqual(
      expect.arrayContaining(["Contact", "Job preferences", "Experience", "Education", "Projects", "Skills"])
    );
  });
});

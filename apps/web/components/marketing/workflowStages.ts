/**
 * The six workflow stages, as data.
 *
 * This file is the single source of truth for the "XpertApply in Action"
 * section. The narrative column, the sticky product demonstration, the progress
 * rail and the bottom workflow controller all read from this one array, so a
 * stage cannot drift out of sync between them and there is exactly one place to
 * edit a headline, a benefit, or a row of demo content.
 *
 * Everything in `demo` is ILLUSTRATIVE product content, deliberately modelled on
 * screens that exist in the authenticated app (discovery, fit analysis, document
 * preparation, people, the assisted application, the tracker). No number here is
 * a claim about outcomes — they are example values inside an example workspace,
 * and the section labels them as such.
 */

/** One line inside the demo workspace list. */
export type DemoRow = {
  title: string;
  meta: string;
  /**
   * Row emphasis. `active` is the row the workspace is focused on, `done` is
   * complete/confirmed, `pending` still needs the user. Drives colour only;
   * every row also states its status in `meta` so nothing depends on hue alone.
   */
  state?: "active" | "done" | "pending";
};

export type WorkflowStage = {
  /** Stable id — used for the anchor, the observer map and React keys. */
  id: string;
  /** Two-digit ordinal shown in the narrative. */
  number: string;
  /** Narrative label, upper-case in the design ("CONNECT"). */
  label: string;
  /** Bottom controller label, sentence case ("Connect"). */
  controllerLabel: string;
  headline: string;
  body: string;
  benefits: string[];
  demo: {
    /**
     * Which product sidebar item is current. Uses the app's own vocabulary,
     * which is why stage 04 is told as "Connect" but lights up "People".
     */
    sidebarLabel: (typeof PRODUCT_SIDEBAR)[number];
    workspaceTitle: string;
    workspaceMeta: string;
    rows: DemoRow[];
    panel: {
      title: string;
      points: string[];
      /** [primary, secondary] — presentational, they are not links. */
      actions: [string, string];
    };
  };
};

/** The mini sidebar inside the product mock, in product order. */
export const PRODUCT_SIDEBAR = [
  "Discover",
  "Understand",
  "Prepare",
  "People",
  "Apply",
  "Tracker"
] as const;

export const WORKFLOW_STAGES: WorkflowStage[] = [
  {
    id: "discover",
    number: "01",
    label: "Discover",
    controllerLabel: "Discover",
    headline: "Find roles worth your time.",
    body: "Surface opportunities that align with your experience, preferences, and goals so you can focus on the jobs that actually matter.",
    benefits: [
      "Better-fit opportunities first",
      "Clear prioritization before applying",
      "Less noise, more signal"
    ],
    demo: {
      sidebarLabel: "Discover",
      workspaceTitle: "Jobs worth your time",
      workspaceMeta: "Recommended for you",
      rows: [
        { title: "Example role 1", meta: "Location and work type", state: "active" },
        { title: "Example role 2", meta: "Location and work type" },
        { title: "Example role 3", meta: "Location and work type" },
        { title: "Example role 4", meta: "Location and work type" }
      ],
      panel: {
        title: "Best-fit opportunities",
        points: [
          "Strong match based on your experience",
          "Roles are prioritized by relevance",
          "Focus effort where you have the best shot"
        ],
        actions: ["View analysis", "Prepare application"]
      }
    }
  },
  {
    id: "understand",
    number: "02",
    label: "Understand",
    controllerLabel: "Understand",
    headline: "Know exactly why you're a fit.",
    body: "Go beyond a score. Understand the strengths, gaps, and requirements that matter most for the role before you invest your time.",
    benefits: [
      "Readable fit analysis",
      "Skills and experience alignment",
      "Actionable insight before applying"
    ],
    demo: {
      sidebarLabel: "Understand",
      workspaceTitle: "Understand the opportunity",
      workspaceMeta: "Fit analysis",
      rows: [
        { title: "Example requirement 1", meta: "Matched to your profile", state: "done" },
        { title: "Example requirement 2", meta: "Matched to your profile", state: "done" },
        { title: "Example requirement 3", meta: "Partial match", state: "pending" },
        { title: "Example requirement 4", meta: "Gap to consider", state: "pending" }
      ],
      panel: {
        title: "Why this role fits",
        points: [
          "Core requirements are clearly surfaced",
          "Potential gaps are visible before applying",
          "You know what to emphasize next"
        ],
        actions: ["See details", "Improve fit"]
      }
    }
  },
  {
    id: "prepare",
    number: "03",
    label: "Prepare",
    controllerLabel: "Prepare",
    headline: "Tailor every application without starting over.",
    body: "Prepare role-specific resumes and cover letters while keeping your real experience as the source of truth.",
    benefits: [
      "Resume emphasis matched to the role",
      "Cover letters grounded in your background",
      "Less rewriting, stronger applications"
    ],
    demo: {
      sidebarLabel: "Prepare",
      workspaceTitle: "Tailor your application",
      workspaceMeta: "Application prep",
      rows: [
        { title: "Tailored resume", meta: "Ready to review", state: "done" },
        { title: "Cover letter", meta: "Drafted from your experience", state: "done" },
        { title: "Highlighted achievements", meta: "Brought forward for this role", state: "active" },
        { title: "Keyword alignment", meta: "Checked against the posting", state: "done" }
      ],
      panel: {
        title: "Preparation readiness",
        points: [
          "Resume aligned to the role",
          "Cover letter grounded in your experience",
          "Key achievements are brought forward"
        ],
        actions: ["Preview resume", "Open workspace"]
      }
    }
  },
  {
    id: "connect",
    number: "04",
    label: "Connect",
    controllerLabel: "Connect",
    headline: "Find the people who can help.",
    body: "Identify relevant recruiters, employees, and potential referrers connected to the company and opportunity.",
    benefits: [
      "People search connected to the role",
      "Recruiter and employee visibility",
      "More intentional outreach"
    ],
    demo: {
      sidebarLabel: "People",
      workspaceTitle: "Find the right people",
      workspaceMeta: "Relevant people",
      rows: [
        { title: "Technical Recruiter", meta: "Hiring for this team", state: "active" },
        { title: "Engineering Manager", meta: "Likely hiring manager" },
        { title: "Senior Engineer", meta: "Related team" },
        { title: "Staff Engineer", meta: "Adjacent team" }
      ],
      panel: {
        title: "People inside the company",
        points: [
          "Recruiters and employees are surfaced",
          "Networking stays tied to the opportunity",
          "Outreach becomes more intentional"
        ],
        actions: ["View people", "Open outreach"]
      }
    }
  },
  {
    id: "apply",
    number: "05",
    label: "Apply",
    controllerLabel: "Apply",
    headline: "Move through applications faster.",
    body: "Bring reusable profile data and answers into the application flow while keeping you in control of the important decisions.",
    benefits: [
      "Reusable profile and answers",
      "Smarter application field handling",
      "Review before submission"
    ],
    demo: {
      sidebarLabel: "Apply",
      workspaceTitle: "Move through forms faster",
      workspaceMeta: "Application flow",
      rows: [
        { title: "Personal information", meta: "Filled from your profile", state: "done" },
        { title: "Work authorization", meta: "Filled from your answers", state: "done" },
        { title: "Education & experience", meta: "Filled from your profile", state: "done" },
        { title: "Why this company?", meta: "Needs your review", state: "pending" }
      ],
      panel: {
        title: "Application progress",
        points: [
          "Profile fields are detected",
          "Reusable answers are prepared",
          "You review before submission"
        ],
        actions: ["View fields", "Review application"]
      }
    }
  },
  {
    id: "track",
    number: "06",
    label: "Track",
    controllerLabel: "Track",
    headline: "Keep the whole search organized.",
    body: "See what you've discovered, prepared, applied to, and followed up on — without turning your job search into spreadsheet management.",
    benefits: [
      "Applications and outreach together",
      "Status and next steps stay visible",
      "One system from discovery to follow-up"
    ],
    demo: {
      sidebarLabel: "Tracker",
      workspaceTitle: "Track everything in one place",
      workspaceMeta: "Search organization",
      rows: [
        { title: "Example role 1", meta: "Interviewing", state: "active" },
        { title: "Example role 2", meta: "Applied", state: "done" },
        { title: "Example role 3", meta: "Follow-up due", state: "pending" },
        { title: "Example role 4", meta: "Saved · Not applied" }
      ],
      panel: {
        title: "Application tracker",
        points: [
          "Status changes stay visible",
          "Follow-ups remain organized",
          "The whole search lives in one system"
        ],
        actions: ["Open tracker", "Review pipeline"]
      }
    }
  }
];

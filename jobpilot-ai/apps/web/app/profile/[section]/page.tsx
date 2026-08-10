import { notFound } from "next/navigation";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { AppShell } from "@/components/AppShell";
import { ProfileWizard } from "@/components/ProfileWizard";
import { SectionEditor } from "@/components/profile/editors/SectionEditor";
import {
  WIZARD_STEPS,
  isFocusedSection,
  isWizardSection,
  type FocusedSection,
  type WizardSection
} from "@/lib/profileSections";

/**
 * Focused profile editors.
 *
 * Each Edit action on the overview lands here. One dynamic route rather than
 * nine near-identical files, and each section opens the existing wizard at the
 * matching step — the editors themselves are untouched, so there is exactly one
 * implementation of every profile form and one profile model behind them.
 */

/**
 * Sections this dynamic route serves.
 *
 * `application-preferences` is excluded: it has its own static segment, which
 * Next resolves first, so listing it here would create a second unreachable
 * definition of the same page.
 */
type Section =
  | Exclude<WizardSection | FocusedSection, "application-preferences">
  | "edit";

const SECTION_META: Record<Section, { title: string; description: string }> = {
  edit: {
    title: "Edit profile",
    description: "Every section of your profile, in one place."
  },
  import: {
    title: "Import / Update resume",
    description: "Upload or paste a resume and review what JobPilot extracted before saving."
  },
  personal: {
    title: "Personal details",
    description: "Your name, contact details, and the links you share with employers."
  },
  preferences: {
    title: "Job preferences",
    description: "The roles, levels, and locations JobPilot should match you against."
  },
  education: { title: "Education", description: "Schools, degrees, and dates." },
  experience: { title: "Experience", description: "The roles you want employers to see." },
  projects: { title: "Projects", description: "Work that shows what you can build." },
  skills: { title: "Skills", description: "Skills used for matching and resume tailoring." },
  links: {
    title: "Links",
    description: "LinkedIn, GitHub, X, your portfolio, and anything else worth sharing."
  },
  review: { title: "Review", description: "Check everything before you save." },
  credentials: {
    title: "Certifications & Awards",
    description: "Credentials you have earned and recognition you have received."
  },
  publications: {
    title: "Publications",
    description: "Papers, articles, and other published work."
  }
};

/** Pre-render the known sections; anything else 404s rather than rendering. */
export function generateStaticParams() {
  return Object.keys(SECTION_META).map((section) => ({ section }));
}

function isSection(value: string): value is Section {
  return value in SECTION_META;
}

export default async function ProfileSectionPage({
  params
}: {
  params: Promise<{ section: string }>;
}) {
  const { section } = await params;
  if (!isSection(section)) {
    notFound();
  }

  const meta = SECTION_META[section];
  // Sections with a focused editor get it. Import, the full wizard, the
  // voluntary EEO questions and Review still run the wizard — it remains the
  // onboarding and import experience, and there is still only one set of forms
  // behind both paths.
  const focused = section !== "edit" && isFocusedSection(section);
  // Sections without a wizard step (Certifications & Awards) never fall back to
  // the wizard, so there is no step for them to open on.
  const initialStep =
    section !== "edit" && isWizardSection(section) ? WIZARD_STEPS[section] : WIZARD_STEPS.import;

  return (
    <AppShell>
      <header className="mb-6">
        <Link
          href="/profile"
          className="focus-ring inline-flex items-center gap-1.5 text-sm font-medium text-[var(--text-muted)] transition hover:text-pine"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden /> Back to profile
        </Link>
        <h1 className="mt-3 text-3xl font-semibold tracking-[-0.03em]">{meta.title}</h1>
        <p className="mt-2 max-w-2xl text-[var(--text-muted)]">{meta.description}</p>
      </header>

      {focused ? (
        <SectionEditor section={section} />
      ) : (
        <ProfileWizard initialStep={initialStep} />
      )}

      {/* The reusable legal answers are deliberately NOT rendered here. They
        * used to appear beneath whichever career section you happened to be
        * on, which meant several copies of the same three questions and no
        * obvious authoritative one. They now live only at
        * /profile/application-preferences. */}
    </AppShell>
  );
}

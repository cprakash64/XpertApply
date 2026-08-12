import type { Metadata } from "next";
import Link from "next/link";
import {
  ArrowRight,
  Award,
  BriefcaseBusiness,
  ChevronRight,
  ClipboardList,
  FileCheck2,
  FileText,
  Gauge,
  Globe,
  GraduationCap,
  KeyRound,
  Link2,
  ListChecks,
  Lock,
  MapPin,
  PenLine,
  Puzzle,
  Search,
  ShieldCheck,
  Sparkles,
  Target,
  UserRound,
  Users
} from "lucide-react";
import { LandingNav } from "@/components/landing/LandingNav";
import { HeroPreview } from "@/components/landing/HeroPreview";
import { ExtensionCta } from "@/components/landing/ExtensionCta";
import { PRODUCT_NAME, siteUrl } from "@/lib/siteConfig";

/**
 * Public landing page.
 *
 * A server component with exactly one client island (the nav's mobile menu).
 * Nothing here fetches: the page must render for a signed-out visitor with no
 * API call at all, which is both a privacy property and the reason it stays
 * cheap to serve.
 *
 * Everything below is styled from the same semantic tokens as the authenticated
 * app, so the marketing surface and the product are one visual system rather
 * than two — near-black canvas, charcoal surfaces, one restrained green accent,
 * and no gradient, stock imagery, or invented social proof anywhere.
 */
export const metadata: Metadata = {
  // `absolute` because the root layout applies a "%s · XpertApply" template, and
  // the landing page's title already ends in the product name.
  title: { absolute: `${PRODUCT_NAME} | AI Job Application Copilot` },
  alternates: { canonical: siteUrl() }
};

/**
 * Product capabilities. Every entry maps onto functionality that exists in this
 * repository today — there is no aspirational item in this list.
 */
const CAPABILITIES = [
  {
    icon: Search,
    title: "Job discovery",
    body: "Fresh openings from public employer boards, filtered by the roles, levels, and locations you actually want."
  },
  {
    icon: Target,
    title: "Fit intelligence",
    body: "A fit score with the reasoning behind it, so you can see how a role lines up with your profile before you spend an evening on it."
  },
  {
    icon: FileText,
    title: "Tailored resumes",
    body: "Job-specific resumes built only from the career facts you have entered. Nothing is invented to fill a gap."
  },
  {
    icon: PenLine,
    title: "Cover letters",
    body: "Role-specific cover letters drafted from the same truthful profile, ready for you to edit."
  },
  {
    icon: Puzzle,
    title: "Application autofill",
    body: "The Chrome extension assists with repetitive fields on supported application pages, then hands the form back to you."
  },
  {
    icon: ClipboardList,
    title: "Application tracking",
    body: "Saved, applied, interview, offer. One place that shows where every application actually stands."
  },
  {
    icon: Users,
    title: "People who can help",
    body: "Surface recruiters and professionals connected to a role, with an editable outreach draft you send yourself."
  },
  {
    icon: UserRound,
    title: "Reusable career profile",
    body: "Experience, education, projects, skills, certifications, awards, publications, links, and preferences — entered once."
  }
];

/** The workflow, in the order a real search runs. */
const WORKFLOW = [
  { number: "01", title: "Build your profile once", body: "Your experience, education, skills, links, and preferences in one source of record." },
  { number: "02", title: "Discover high-fit roles", body: "See openings scored against that profile, with the gaps called out." },
  { number: "03", title: "Prepare tailored materials", body: "Generate a resume and cover letter for the specific role, then edit them." },
  { number: "04", title: "Open the application", body: "Go straight to the employer's own application page from the job." },
  { number: "05", title: `${PRODUCT_NAME} assists with the fields`, body: "The extension fills the repetitive answers you have already given." },
  { number: "06", title: "Review and submit", body: "You check every field and press submit yourself, on the employer's site." },
  { number: "07", title: "Track your progress", body: "Mark it applied and follow it through interview and offer." },
  { number: "08", title: "Connect with people", body: "Find someone at the company who could help, and reach out in your own words." }
];

/**
 * Built as a string rather than inline JSX on purpose.
 *
 * JSX collapses the whitespace around an expression when the surrounding text
 * wraps onto further lines, which silently rendered "The XpertApplyChrome
 * extension". Any sentence that interpolates the product name mid-paragraph is
 * therefore assembled here, where the spacing is explicit and cannot be eaten by
 * the compiler.
 */
const EXTENSION_INTRO =
  `The ${PRODUCT_NAME} Chrome extension uses the information you have explicitly provided to ` +
  "assist with repetitive fields on supported application pages. It works with common applicant " +
  "tracking systems and falls back to a generic mode elsewhere — coverage varies by site, and it " +
  "will tell you when a page is one it cannot handle.";

/** Extension hand-off, as a flow the reader can follow left to right. */
const EXTENSION_FLOW = ["Profile", "Application", `${PRODUCT_NAME} autofill`, "Review", "Submit"];

const EXTENSION_POINTS = [
  {
    icon: ListChecks,
    title: "Only what you have told it",
    body: "The extension fills from the answers in your profile. It does not invent a value to get past a required field."
  },
  {
    icon: ShieldCheck,
    title: "You stay in control",
    body: "Nothing is submitted for you. The extension stops at the employer's submit step and hands the form back."
  },
  {
    icon: Sparkles,
    title: "Unresolved questions are shown",
    body: "Anything it could not answer confidently is listed for review instead of being guessed at."
  },
  {
    icon: FileCheck2,
    title: "Answers you choose to reuse",
    body: "When a question is worth reusing, it asks first — and the saved answers stay editable in your profile."
  }
];

/** Profile sections that exist in the product today. */
const PROFILE_SECTIONS = [
  { icon: UserRound, label: "Personal details" },
  { icon: BriefcaseBusiness, label: "Experience" },
  { icon: GraduationCap, label: "Education" },
  { icon: Sparkles, label: "Projects" },
  { icon: Gauge, label: "Skills" },
  { icon: Award, label: "Certifications & Awards" },
  { icon: FileText, label: "Publications" },
  { icon: Link2, label: "Links" },
  { icon: MapPin, label: "Job Preferences" },
  { icon: ListChecks, label: "Application Preferences" }
];

const SECURITY_POINTS = [
  {
    icon: ShieldCheck,
    title: "You submit every application",
    body: `${PRODUCT_NAME} prepares and fills. The submit button on the employer's site is always yours to press.`
  },
  {
    icon: ListChecks,
    title: "Job-specific answers stay job-specific",
    body: "An answer you give for one application is not silently promoted into a reusable one."
  },
  {
    icon: PenLine,
    title: "Reusable answers stay editable",
    body: "Every answer the extension can reuse is listed in your Application Preferences, where you can change or remove it."
  },
  {
    icon: Lock,
    title: "Optional demographics are kept apart",
    body: "Voluntary demographic questions are stored separately and are not used for fit scoring, ranking, or document generation."
  },
  {
    icon: KeyRound,
    title: "Employer passwords are not shown back",
    body: "An employer account password you save is stored encrypted and is never displayed again."
  },
  {
    icon: Globe,
    title: "Your profile, exportable and deletable",
    body: "The data behind all of this is yours: review it, export it, or delete it from Settings."
  }
];

export default function HomePage() {
  return (
    <div className="landing-page min-h-screen bg-[var(--background)]">
      <LandingNav />

      <main>
        {/* ------------------------------------------------------------ Hero */}
        <section className="border-b border-line">
          <div className="mx-auto grid max-w-7xl gap-12 px-4 py-16 sm:px-6 lg:grid-cols-[1.05fr_.95fr] lg:items-center lg:py-24">
            <div>
              <p className="mb-5 inline-flex items-center gap-2 rounded-full border border-line bg-panel px-3 py-1.5 text-xs font-semibold uppercase tracking-[0.1em] text-[var(--text-secondary)]">
                <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-pine" />
                Your job search, organized
              </p>
              <h1 className="max-w-3xl text-4xl font-semibold leading-[1.06] tracking-[-0.04em] text-ink sm:text-5xl lg:text-6xl">
                Your job search, from discovery to application.
              </h1>
              <p className="mt-6 max-w-xl text-lg leading-8 text-[var(--text-muted)]">
                {PRODUCT_NAME} helps you find roles worth your time, understand how well you fit,
                prepare tailored resumes and cover letters, get through repetitive application
                fields, track everything you have sent, and find the people who can help.
              </p>
              <div className="mt-8 flex flex-wrap items-start gap-3">
                <Link
                  href="/signup"
                  className="focus-ring inline-flex h-12 shrink-0 items-center gap-2 rounded-xl bg-pine px-5 text-sm font-semibold text-[var(--accent-foreground)] transition hover:bg-[var(--accent-hover)]"
                >
                  Get started free <ArrowRight className="h-4 w-4" aria-hidden />
                </Link>
                <ExtensionCta id="hero-extension" />
                <a
                  className="focus-ring inline-flex h-12 shrink-0 items-center gap-2 rounded-xl px-4 text-sm font-semibold text-[var(--text-secondary)] transition hover:bg-panel hover:text-ink"
                  href="#how-it-works"
                >
                  See how it works <ChevronRight className="h-4 w-4" aria-hidden />
                </a>
              </div>
              <p className="mt-6 flex items-center gap-2 text-sm text-[var(--text-muted)]">
                <ShieldCheck className="h-4 w-4 shrink-0 text-pine" aria-hidden />
                You review every application before submission.
              </p>
            </div>

            <HeroPreview />
          </div>
        </section>

        {/* -------------------------------------------------------- Features */}
        <section id="features" className="scroll-mt-20 border-b border-line bg-[var(--surface-muted)]">
          <div className="mx-auto max-w-7xl px-4 py-16 sm:px-6 lg:py-20">
            <div className="max-w-2xl">
              <p className="text-sm font-semibold text-pine">Capabilities</p>
              <h2 className="mt-2 text-3xl font-semibold tracking-[-0.035em] text-ink sm:text-4xl">
                Everything you need for the job search
              </h2>
              <p className="mt-3 text-[var(--text-muted)]">
                One profile behind every step, so the same facts drive matching, your documents, and
                the answers on an employer&rsquo;s form.
              </p>
            </div>

            <ul className="mt-10 grid list-none gap-4 p-0 sm:grid-cols-2 lg:grid-cols-4">
              {CAPABILITIES.map((item) => (
                <li
                  key={item.title}
                  className="landing-card rounded-2xl border border-line bg-[var(--surface)] p-6"
                >
                  <span
                    aria-hidden
                    className="grid h-10 w-10 place-items-center rounded-xl bg-[var(--success-surface)] text-pine"
                  >
                    <item.icon className="h-5 w-5" />
                  </span>
                  <h3 className="mt-5 text-base font-semibold tracking-[-0.02em] text-ink">
                    {item.title}
                  </h3>
                  <p className="mt-2 text-sm leading-6 text-[var(--text-muted)]">{item.body}</p>
                </li>
              ))}
            </ul>
          </div>
        </section>

        {/* ----------------------------------------------------- How it works */}
        <section id="how-it-works" className="scroll-mt-20 border-b border-line">
          <div className="mx-auto max-w-7xl px-4 py-16 sm:px-6 lg:py-20">
            <div className="max-w-2xl">
              <p className="text-sm font-semibold text-pine">How it works</p>
              <h2 className="mt-2 text-3xl font-semibold tracking-[-0.035em] text-ink sm:text-4xl">
                From first search to final follow-up
              </h2>
              <p className="mt-3 text-[var(--text-muted)]">
                Each step builds on the last, so you spend less time re-typing information and more
                time deciding where to apply.
              </p>
            </div>

            <ol className="mt-10 grid list-none gap-4 p-0 sm:grid-cols-2 lg:grid-cols-4">
              {WORKFLOW.map((step, index) => (
                <li
                  key={step.number}
                  className="landing-card relative rounded-2xl border border-line bg-[var(--surface)] p-6"
                >
                  {/* Connector: decorative only, and only where a card actually
                    * has a neighbour to its right. */}
                  {index % 4 !== 3 && (
                    <span
                      aria-hidden
                      className="absolute left-full top-[2.35rem] hidden h-px w-4 bg-[var(--border)] lg:block"
                    />
                  )}
                  <span className="grid h-8 w-8 place-items-center rounded-lg border border-[var(--success-border)] bg-[var(--success-surface)] text-xs font-semibold tracking-[0.06em] text-pine">
                    {step.number}
                  </span>
                  <h3 className="mt-5 text-base font-semibold tracking-[-0.02em] text-ink">
                    {step.title}
                  </h3>
                  <p className="mt-2 text-sm leading-6 text-[var(--text-muted)]">{step.body}</p>
                </li>
              ))}
            </ol>
          </div>
        </section>

        {/* ------------------------------------------------------- Extension */}
        <section id="extension" className="scroll-mt-20 border-b border-line bg-[var(--surface-muted)]">
          <div className="mx-auto max-w-7xl px-4 py-16 sm:px-6 lg:py-20">
            <div className="grid gap-12 lg:grid-cols-[1fr_1fr] lg:items-start">
              <div>
                <p className="inline-flex items-center gap-2 text-sm font-semibold text-pine">
                  <Puzzle className="h-4 w-4" aria-hidden /> Chrome extension
                </p>
                <h2 className="mt-3 text-3xl font-semibold leading-tight tracking-[-0.035em] text-ink sm:text-4xl">
                  Application forms shouldn&rsquo;t mean typing the same information again.
                </h2>
                <p className="mt-4 text-[var(--text-muted)]">{EXTENSION_INTRO}</p>

                <div className="mt-7">
                  <ExtensionCta
                    id="extension-section-cta"
                    variant="primary"
                    label={`Install ${PRODUCT_NAME} for Chrome`}
                  />
                </div>

                <ul className="mt-8 grid list-none gap-4 p-0 sm:grid-cols-2">
                  {EXTENSION_POINTS.map((point) => (
                    <li key={point.title}>
                      <p className="flex items-center gap-2 text-sm font-semibold text-ink">
                        <point.icon className="h-4 w-4 shrink-0 text-pine" aria-hidden />
                        {point.title}
                      </p>
                      <p className="mt-1.5 text-sm leading-6 text-[var(--text-muted)]">
                        {point.body}
                      </p>
                    </li>
                  ))}
                </ul>
              </div>

              <div className="rounded-2xl border border-line bg-[var(--surface)] p-6 sm:p-8">
                <p className="text-xs font-semibold uppercase tracking-[0.12em] text-[var(--text-muted)]">
                  How the hand-off works
                </p>
                <ol className="mt-5 grid list-none gap-3 p-0">
                  {EXTENSION_FLOW.map((stage, index) => (
                    <li key={stage} className="grid gap-3">
                      <div className="flex items-center gap-3 rounded-xl border border-line bg-panel px-4 py-3">
                        <span
                          aria-hidden
                          className="grid h-7 w-7 shrink-0 place-items-center rounded-full border border-[var(--success-border)] bg-[var(--success-surface)] text-xs font-semibold text-pine"
                        >
                          {index + 1}
                        </span>
                        <span className="text-sm font-medium text-ink">{stage}</span>
                      </div>
                      {index < EXTENSION_FLOW.length - 1 && (
                        <span aria-hidden className="ml-[1.85rem] block h-3 w-px bg-[var(--border)]" />
                      )}
                    </li>
                  ))}
                </ol>
                <p className="mt-6 border-t border-line pt-5 text-sm leading-6 text-[var(--text-muted)]">
                  The extension never presses submit. It stops at the employer&rsquo;s final step
                  and leaves the decision, and the form, with you.
                </p>
              </div>
            </div>
          </div>
        </section>

        {/* ----------------------------------------------------------- Global */}
        <section id="global" className="scroll-mt-20 border-b border-line">
          <div className="mx-auto max-w-7xl px-4 py-16 sm:px-6 lg:py-20">
            <div className="grid gap-10 lg:grid-cols-[1fr_1.1fr] lg:items-center">
              <div>
                <p className="inline-flex items-center gap-2 text-sm font-semibold text-pine">
                  <Globe className="h-4 w-4" aria-hidden /> Worldwide
                </p>
                <h2 className="mt-3 text-3xl font-semibold tracking-[-0.035em] text-ink sm:text-4xl">
                  Built for a global job search
                </h2>
                <p className="mt-4 text-[var(--text-muted)]">
                  Location preferences cover countries and territories worldwide and major hiring
                  markets on every inhabited continent &mdash; and anything you type is accepted, so
                  no city is missing because a list forgot it. {PRODUCT_NAME} does not give
                  immigration or legal advice; work-authorization questions are answered from what
                  you tell it, in your own words.
                </p>
              </div>
              <ul className="grid list-none gap-4 p-0 sm:grid-cols-2">
                {[
                  { icon: Globe, title: "Country and region preferences", body: "Choose the countries, regions, and cities you would actually move to or work from." },
                  { icon: MapPin, title: "Remote, hybrid, or on-site", body: "Where is separate from how, so a remote search is not tied to one city." },
                  { icon: UserRound, title: "International career profiles", body: "Degrees, employers, and credentials from anywhere, kept exactly as you entered them." },
                  { icon: ListChecks, title: "Reusable application answers", body: "The answers employers ask for repeatedly, stored once and reused with your approval." }
                ].map((item) => (
                  <li
                    key={item.title}
                    className="landing-card rounded-2xl border border-line bg-[var(--surface)] p-5"
                  >
                    <span aria-hidden className="text-pine">
                      <item.icon className="h-5 w-5" />
                    </span>
                    <h3 className="mt-4 text-sm font-semibold text-ink">{item.title}</h3>
                    <p className="mt-1.5 text-sm leading-6 text-[var(--text-muted)]">{item.body}</p>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </section>

        {/* ---------------------------------------------------------- Profile */}
        <section id="profile" className="scroll-mt-20 border-b border-line bg-[var(--surface-muted)]">
          <div className="mx-auto max-w-7xl px-4 py-16 sm:px-6 lg:py-20">
            <div className="max-w-2xl">
              <p className="text-sm font-semibold text-pine">Career profile</p>
              <h2 className="mt-2 text-3xl font-semibold tracking-[-0.035em] text-ink sm:text-4xl">
                Maintain your career information once
              </h2>
              <p className="mt-3 text-[var(--text-muted)]">
                These are the truthful facts behind everything else: what you are matched against,
                what your tailored resume and cover letter are built from, and what the extension
                has to work with on an application form.
              </p>
            </div>
            <ul className="mt-10 grid list-none gap-3 p-0 sm:grid-cols-2 lg:grid-cols-5">
              {PROFILE_SECTIONS.map((section) => (
                <li
                  key={section.label}
                  className="landing-card flex items-center gap-3 rounded-xl border border-line bg-[var(--surface)] px-4 py-3.5"
                >
                  <section.icon className="h-4 w-4 shrink-0 text-pine" aria-hidden />
                  <span className="text-sm font-medium text-ink">{section.label}</span>
                </li>
              ))}
            </ul>
          </div>
        </section>

        {/* --------------------------------------------------------- Security */}
        <section id="security" className="scroll-mt-20 border-b border-line">
          <div className="mx-auto max-w-7xl px-4 py-16 sm:px-6 lg:py-20">
            <div className="max-w-2xl">
              <p className="inline-flex items-center gap-2 text-sm font-semibold text-pine">
                <ShieldCheck className="h-4 w-4" aria-hidden /> Control
              </p>
              <h2 className="mt-3 text-3xl font-semibold tracking-[-0.035em] text-ink sm:text-4xl">
                Assisted, never automated behind your back
              </h2>
              <p className="mt-3 text-[var(--text-muted)]">
                {PRODUCT_NAME} is human-in-the-loop by design. These are product behaviours, not
                marketing claims.
              </p>
            </div>
            <ul className="mt-10 grid list-none gap-4 p-0 sm:grid-cols-2 lg:grid-cols-3">
              {SECURITY_POINTS.map((point) => (
                <li
                  key={point.title}
                  className="landing-card rounded-2xl border border-line bg-[var(--surface)] p-6"
                >
                  <span
                    aria-hidden
                    className="grid h-10 w-10 place-items-center rounded-xl bg-panel text-pine"
                  >
                    <point.icon className="h-5 w-5" />
                  </span>
                  <h3 className="mt-5 text-base font-semibold tracking-[-0.02em] text-ink">
                    {point.title}
                  </h3>
                  <p className="mt-2 text-sm leading-6 text-[var(--text-muted)]">{point.body}</p>
                </li>
              ))}
            </ul>
          </div>
        </section>

        {/* -------------------------------------------------------- Final CTA */}
        <section className="border-b border-line bg-[var(--surface-muted)]">
          <div className="mx-auto max-w-4xl px-4 py-20 text-center sm:px-6">
            <h2 className="text-3xl font-semibold leading-tight tracking-[-0.035em] text-ink sm:text-4xl">
              <span className="block">Spend less time managing applications.</span>
              <span className="block">Spend more time finding the right opportunity.</span>
            </h2>
            <div className="mt-9 flex flex-wrap items-start justify-center gap-3">
              <Link
                href="/signup"
                className="focus-ring inline-flex h-12 shrink-0 items-center gap-2 rounded-xl bg-pine px-6 text-sm font-semibold text-[var(--accent-foreground)] transition hover:bg-[var(--accent-hover)]"
              >
                Create your profile <ArrowRight className="h-4 w-4" aria-hidden />
              </Link>
              <ExtensionCta id="final-extension" label="Install extension" />
            </div>
            <p className="mt-8 text-sm text-[var(--text-muted)]">
              Already have an account?{" "}
              <Link href="/login" className="focus-ring rounded font-semibold text-pine underline-offset-4 hover:underline">
                Sign in
              </Link>
            </p>
          </div>
        </section>
      </main>

      <LandingFooter />
    </div>
  );
}

/**
 * Footer.
 *
 * Only routes that exist are linked. There is no Terms page in this repository
 * yet, so there is no Terms link — a 404 in the footer is worse than an absent
 * one, and the gap is tracked as a pre-launch item rather than papered over.
 */
function LandingFooter() {
  const year = new Date().getFullYear();
  return (
    <footer className="bg-[var(--background)]">
      <div className="mx-auto max-w-7xl px-4 py-12 sm:px-6">
        <div className="flex flex-col gap-8 sm:flex-row sm:items-start sm:justify-between">
          <div className="max-w-xs">
            <p className="flex items-center gap-2.5 font-semibold tracking-[-0.02em] text-ink">
              <span
                aria-hidden
                className="grid h-8 w-8 place-items-center rounded-lg bg-pine text-[var(--accent-foreground)]"
              >
                <BriefcaseBusiness className="h-4 w-4" />
              </span>
              {PRODUCT_NAME}
            </p>
            <p className="mt-3 text-sm leading-6 text-[var(--text-muted)]">
              Find, prepare, and apply &mdash; with you reviewing every application before it is
              submitted.
            </p>
          </div>

          <nav aria-label="Footer" className="grid gap-8 sm:grid-cols-2">
            <div>
              <h2 className="text-xs font-semibold uppercase tracking-[0.12em] text-[var(--text-muted)]">
                Product
              </h2>
              <ul className="mt-3 grid list-none gap-2 p-0 text-sm">
                {[
                  { href: "#features", label: "Features" },
                  { href: "#how-it-works", label: "How it works" },
                  { href: "#extension", label: "Extension" },
                  { href: "#security", label: "Security" }
                ].map((link) => (
                  <li key={link.href}>
                    <a
                      href={link.href}
                      className="focus-ring rounded text-[var(--text-secondary)] hover:text-ink"
                    >
                      {link.label}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <h2 className="text-xs font-semibold uppercase tracking-[0.12em] text-[var(--text-muted)]">
                Account
              </h2>
              <ul className="mt-3 grid list-none gap-2 p-0 text-sm">
                <li>
                  <Link href="/signup" className="focus-ring rounded text-[var(--text-secondary)] hover:text-ink">
                    Get started
                  </Link>
                </li>
                <li>
                  <Link href="/login" className="focus-ring rounded text-[var(--text-secondary)] hover:text-ink">
                    Sign in
                  </Link>
                </li>
                <li>
                  <Link href="/privacy" className="focus-ring rounded text-[var(--text-secondary)] hover:text-ink">
                    Privacy
                  </Link>
                </li>
              </ul>
            </div>
          </nav>
        </div>

        <p className="mt-10 border-t border-line pt-6 text-xs text-[var(--text-muted)]">
          &copy; {year} {PRODUCT_NAME}
        </p>
      </div>
    </footer>
  );
}

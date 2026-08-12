"use client";

import Link from "next/link";
import {
  ArrowRight,
  Briefcase,
  Building2,
  FolderGit2,
  GraduationCap,
  Globe,
  Link as LinkIcon,
  Mail,
  MapPin,
  BookText,
  Medal,
  Phone,
  Sparkles,
  Target,
  Upload,
  Wrench
} from "lucide-react";
import { ProfileWizard } from "@/components/ProfileWizard";
import { GitHubIcon, LinkedInIcon, XIcon } from "./BrandIcons";
import {
  displayName,
  formatDateRange,
  locationLabel,
  needsOnboarding,
  profileInitials,
  useProfileOverview,
  type EligibilityAnswer,
  type ProfileOverviewData,
  type ScoreBreakdown
} from "@/lib/profileOverview";
import { groupSkills } from "@/lib/skillGroups";
import {
  Card,
  ClickableCard,
  EditLink,
  MetaRow,
  MoreCount,
  ProgressMeter,
  SectionHeading,
  type MetaRowIcon,
  type MetaRowTone
} from "./primitives";

/**
 * The Profile overview — a compact, skim-friendly summary of the user's career
 * information, and the default profile-management screen.
 *
 * It replaces the 10-step wizard as the landing experience. The wizard is still
 * the right tool for first-time onboarding (there is nothing to summarize on an
 * empty profile) and is still what every Edit action opens, focused on one
 * section. There is exactly one set of profile editors and one profile model.
 *
 * Nothing sensitive appears here: no stored employer-portal password, no EEO or
 * demographic answers, no tokens. Those live behind their own dedicated screens.
 */
export function ProfileOverview() {
  const { data, loading, error, reload } = useProfileOverview();

  if (loading) {
    return <OverviewSkeleton />;
  }

  if (error && !data) {
    return (
      <div
        role="alert"
        /* The profile page's error surface has always carried this id — the
           dark-mode contrast e2e check targets it. The overview replaced the
           wizard at /profile, so it inherits the identifier too. */
        data-testid="section-error"
        className="rounded-2xl border border-[var(--danger-border)] bg-[var(--danger-surface)] px-5 py-4 text-sm text-[var(--danger)]"
      >
        <p>We couldn’t load your profile.</p>
        <button
          type="button"
          onClick={reload}
          className="focus-ring mt-3 rounded-lg border border-[var(--danger-border)] px-3 py-1.5 font-semibold"
        >
          Try again
        </button>
      </div>
    );
  }

  if (!data) return null;

  // A brand-new account has nothing to summarize, so onboarding still owns the
  // first run. Once any real information exists, the overview takes over.
  if (needsOnboarding(data)) {
    return <OnboardingHandoff />;
  }

  return <Overview data={data} />;
}

function OnboardingHandoff() {
  return (
    <div>
      <header className="mb-6">
        <h1 className="text-3xl font-semibold tracking-[-0.03em]">Set up your profile</h1>
        <p className="mt-2 max-w-2xl text-[var(--text-muted)]">
          Import a resume or fill in the sections below. Once you have the basics saved, this
          page becomes your profile overview.
        </p>
      </header>
      <ProfileWizard />
    </div>
  );
}

function Overview({ data }: { data: ProfileOverviewData }) {
  const { profile, completeness } = data;
  const name = displayName(profile);
  const location = locationLabel(profile);
  const headline = profile.target_roles[0] || "";

  return (
    <div className="pb-10">
      <header className="flex flex-col gap-4 border-b border-line pb-6 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-3xl font-semibold tracking-[-0.03em]">Profile</h1>
          <p className="mt-2 max-w-xl text-sm text-[var(--text-muted)]">
            Keep your career information accurate for better matches and applications.
          </p>
        </div>
        {/* Import is an action here, not a permanent tab: updating a resume is
            something you do occasionally, not a section of your profile. */}
        <div className="flex shrink-0 flex-wrap gap-2">
          <Link
            href="/profile/import"
            className="focus-ring inline-flex h-10 items-center justify-center gap-2 rounded-xl border border-line bg-white px-4 text-sm font-medium text-ink transition hover:border-[var(--border-strong)] hover:bg-panel"
          >
            <Upload className="h-4 w-4" aria-hidden /> Import / Update resume
          </Link>
          <Link
            href="/profile/edit"
            className="focus-ring inline-flex h-10 items-center justify-center gap-2 rounded-xl bg-pine px-4 text-sm font-semibold text-white transition hover:bg-[var(--accent-hover)]"
          >
            Edit profile
          </Link>
        </div>
      </header>

      {/* 32/68 on desktop, stacked below xl so the cards keep comfortable
          measure on tablets rather than being squeezed into two narrow rails. */}
      <div className="mt-6 grid items-start gap-5 xl:grid-cols-[minmax(0,32fr)_minmax(0,68fr)]">
        <div className="grid gap-5">
          <IdentityCard
            name={name}
            initials={profileInitials(profile)}
            headline={headline}
            location={location}
            completion={completeness.completion}
            readiness={completeness.autofillReadiness}
          />
          <ContactCard data={data} />
          <PreferencesCard data={data} />
          <ApplicationPreferencesCard data={data} />
        </div>

        <div className="grid gap-5">
          <ExperienceCard data={data} />
          <EducationCard data={data} />
          <ProjectsCard data={data} />
          <SkillsCard data={data} />
          <CredentialsCard data={data} />
          <PublicationsCard data={data} />
        </div>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------------- */
/* Left column                                                            */
/* ---------------------------------------------------------------------- */

function IdentityCard({
  name,
  initials,
  headline,
  location,
  completion,
  readiness
}: {
  name: string;
  initials: string;
  headline: string;
  location: string;
  completion: ScoreBreakdown;
  readiness: ScoreBreakdown;
}) {
  return (
    <Card>
      <div className="flex min-w-0 items-center gap-4">
        <span
          aria-hidden
          className="grid h-14 w-14 shrink-0 place-items-center rounded-2xl bg-[var(--success-surface)] text-lg font-semibold text-pine"
        >
          {initials}
        </span>
        <div className="min-w-0">
          <h2 className="truncate text-lg font-semibold tracking-[-0.02em]">
            {name || "Add your name"}
          </h2>
          {headline && (
            <p className="mt-0.5 truncate text-sm text-[var(--text-secondary)]">{headline}</p>
          )}
          {location && (
            <p className="mt-1 flex items-center gap-1.5 truncate text-xs text-[var(--text-muted)]">
              <MapPin className="h-3.5 w-3.5 shrink-0" aria-hidden />
              {location}
            </p>
          )}
        </div>
      </div>

      <div className="mt-6 grid min-w-0 gap-4">
        <ProgressMeter
          label="Profile completion"
          percent={completion.percent}
          hint={
            completion.missing.length > 0
              ? `Next: ${completion.missing[0].label}`
              : "Everything filled in"
          }
        />
        {/* A separate signal on purpose: a complete-looking profile can still be
            missing the canonical facts an application form needs. */}
        <ProgressMeter
          label="Autofill readiness"
          percent={readiness.percent}
          hint={
            readiness.missing.length > 0
              ? `Missing: ${readiness.missing
                  .slice(0, 2)
                  .map((item) => item.label)
                  .join(", ")}${readiness.missing.length > 2 ? `, +${readiness.missing.length - 2}` : ""}`
              : "Ready to autofill applications"
          }
        />
      </div>
    </Card>
  );
}

/**
 * Contact and professional links.
 *
 * Each row carries a distinct icon and a restrained tint so the card can be
 * scanned by shape and hue rather than read line by line — but the tints stay
 * muted and every row is still labelled in text, so nothing depends on colour
 * and the card does not become a row of saturated logos.
 */
function ContactCard({ data }: { data: ProfileOverviewData }) {
  const { profile } = data;
  const location = locationLabel(profile);

  const rows: {
    icon: MetaRowIcon;
    label: string;
    value: string;
    href?: string;
    tone?: MetaRowTone;
  }[] = [
    { icon: Mail, label: "Application email", value: profile.application_email, tone: "email" as const },
    { icon: Phone, label: "Phone", value: profile.phone, tone: "phone" as const },
    { icon: MapPin, label: "Location", value: location, tone: "location" as const },
    {
      icon: LinkedInIcon,
      label: "LinkedIn",
      value: profile.linkedin_url,
      href: profile.linkedin_url,
      tone: "linkedin" as const
    },
    {
      icon: GitHubIcon,
      label: "GitHub",
      value: profile.github_url,
      href: profile.github_url,
      tone: "github" as const
    },
    { icon: XIcon, label: "X", value: profile.x_url, href: profile.x_url, tone: "x" as const },
    {
      icon: Globe,
      label: "Portfolio",
      value: profile.portfolio_url,
      href: profile.portfolio_url,
      tone: "website" as const
    },
    // Everything the user added themselves, labelled with their own words.
    ...profile.additional_links.map((link) => ({
      icon: LinkIcon,
      label: link.label,
      value: link.url,
      href: link.url,
      tone: "website" as const
    }))
  ].filter((row) => row.value.trim() !== "");

  return (
    <ClickableCard href="/profile/personal" title="Contact">
      {rows.length > 0 ? (
        <ul className="mt-4 grid min-w-0 gap-3">
          {rows.map((row) => (
            <MetaRow
              key={`${row.label}-${row.value}`}
              icon={row.icon}
              label={row.label}
              value={row.value}
              href={row.href}
              tone={row.tone}
            />
          ))}
        </ul>
      ) : (
        <EmptyHint text="Add an email, phone, and location so applications can be filled in." href="/profile/personal" label="Add contact details" />
      )}
    </ClickableCard>
  );
}

const WORKPLACE_LABEL: Record<string, string> = {
  everything: "Open to any workplace",
  remote: "Remote",
  hybrid: "Hybrid",
  onsite: "Onsite"
};

/** Human wording for the stored work-authorization status. */
const WORK_AUTHORIZATION_LABEL: Record<string, string> = {
  authorized_us: "Authorized to work in the United States",
  authorized_other_country: "Authorized to work in another country",
  need_sponsorship_now: "Needs sponsorship now",
  need_sponsorship_future: "Needs sponsorship in the future",
  student_visa: "On a student visa",
  prefer_not_to_say: "Prefer not to say"
};

/** The two sponsorship questions, in the order the editor asks them. */
const SPONSORSHIP_ROWS: { field: string; label: string }[] = [
  { field: "sponsorship_required_now", label: "Current sponsorship" },
  { field: "sponsorship_required_future", label: "Future sponsorship" }
];

/**
 * A summary of the answers XpertApply reuses on applications.
 *
 * Shows only what the user actually chose, in their words rather than ours:
 * never a canonical key, never a raw enum, and never an EEO answer — those live
 * behind their own screen and are not summarized anywhere on this page.
 */
function ApplicationPreferencesCard({ data }: { data: ProfileOverviewData }) {
  const { profile, eligibility } = data;
  const byField = new Map(eligibility.map((answer) => [answer.field, answer]));

  const rows: { label: string; value: string }[] = [
    {
      label: "Work authorization",
      value: WORK_AUTHORIZATION_LABEL[profile.work_authorization] ?? "Not set"
    },
    ...SPONSORSHIP_ROWS.map(({ field, label }) => ({
      label,
      value: eligibilityLabel(byField.get(field))
    })),
    { label: "Relocation", value: profile.open_to_relocation ? "Yes" : "No" }
  ];

  // Answers that are stored and reusable — the ones autofill can actually use.
  const reusable = eligibility.filter((answer) => answer.reusable).length;

  return (
    <ClickableCard href="/profile/application-preferences" title="Application preferences">
      <dl className="mt-4 grid gap-3">
        {rows.map((row) => (
          <div key={row.label} className="min-w-0">
            <dt className="text-xs font-medium uppercase tracking-[0.08em] text-[var(--text-muted)]">
              {row.label}
            </dt>
            <dd className="mt-0.5 truncate text-sm text-[var(--text-secondary)]">{row.value}</dd>
          </div>
        ))}
      </dl>
      {reusable > 0 && (
        <p className="mt-3 border-t border-line pt-3 text-xs text-[var(--text-muted)]">
          +{reusable} reusable answer{reusable === 1 ? "" : "s"} configured
        </p>
      )}
    </ClickableCard>
  );
}

/**
 * Turn one stored answer into words.
 *
 * The three states are genuinely different and are kept that way: answered
 * Yes/No, "ask me each time" (a deliberate choice), and never answered.
 */
function eligibilityLabel(answer?: EligibilityAnswer): string {
  if (!answer) return "Not set";
  if (answer.answered && answer.answer) return answer.answer === "yes" ? "Yes" : "No";
  return answer.reusable ? "Not set" : "Ask during each application";
}

function PreferencesCard({ data }: { data: ProfileOverviewData }) {
  const { profile } = data;
  const hasAny =
    profile.target_roles.length > 0 ||
    profile.target_levels.length > 0 ||
    profile.preferred_locations.length > 0;

  return (
    <ClickableCard href="/profile/preferences" title="Job preferences">
      {hasAny ? (
        <div className="mt-4 grid min-w-0 gap-4">
          <TagRow label="Target roles" values={profile.target_roles} />
          <TagRow label="Level" values={profile.target_levels} />
          <TagRow label="Locations" values={profile.preferred_locations} />
          <div>
            <p className="text-xs font-medium uppercase tracking-[0.08em] text-[var(--text-muted)]">
              Workplace
            </p>
            <p className="mt-1.5 text-sm text-[var(--text-secondary)]">
              {WORKPLACE_LABEL[profile.remote_preference] ?? WORKPLACE_LABEL.everything}
            </p>
          </div>
        </div>
      ) : (
        <EmptyHint text="Tell XpertApply what roles and locations you want." href="/profile/preferences" label="Set job preferences" />
      )}
    </ClickableCard>
  );
}

/** Up to three values, then "+N more" — never a wall of chips. */
function TagRow({ label, values, max = 3 }: { label: string; values: string[]; max?: number }) {
  if (values.length === 0) return null;
  const shown = values.slice(0, max);
  const remaining = values.length - shown.length;
  return (
    <div>
      <p className="text-xs font-medium uppercase tracking-[0.08em] text-[var(--text-muted)]">
        {label}
      </p>
      <div className="mt-1.5 flex flex-wrap gap-1.5">
        {shown.map((value) => (
          <span
            key={value}
            className="rounded-lg border border-line bg-panel px-2 py-1 text-xs text-[var(--text-secondary)]"
          >
            {value}
          </span>
        ))}
        {remaining > 0 && <MoreCount count={remaining} />}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------------- */
/* Right column                                                           */
/* ---------------------------------------------------------------------- */

const PREVIEW_LIMIT = 3;

function ExperienceCard({ data }: { data: ProfileOverviewData }) {
  const shown = data.experience.slice(0, PREVIEW_LIMIT);
  const remaining = data.experience.length - shown.length;

  return (
    <ClickableCard href="/profile/experience" title="Experience" icon={Briefcase}>
      {shown.length > 0 ? (
        <ul className="mt-4 min-w-0 divide-y divide-line">
          {shown.map((entry, index) => (
            <li key={`${entry.company}-${index}`} className="flex min-w-0 gap-3 py-3 first:pt-0 last:pb-0">
              <span
                aria-hidden
                className="mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-panel text-[var(--text-muted)]"
              >
                <Building2 className="h-4 w-4" />
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold">{entry.title || entry.company}</p>
                <p className="mt-0.5 truncate text-sm text-[var(--text-secondary)]">
                  {entry.title ? entry.company : ""}
                </p>
                <p className="mt-1 truncate text-xs text-[var(--text-muted)]">
                  {[
                    formatDateRange(entry.start_date, entry.end_date, entry.currently_working),
                    entry.location
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </p>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <EmptyHint text="Add the roles you want employers to see." href="/profile/experience" label="Add experience" />
      )}
      {remaining > 0 && <FooterMore count={remaining} noun="role" href="/profile/experience" />}
    </ClickableCard>
  );
}

function EducationCard({ data }: { data: ProfileOverviewData }) {
  const shown = data.education.slice(0, PREVIEW_LIMIT);
  const remaining = data.education.length - shown.length;

  return (
    <ClickableCard href="/profile/education" title="Education" icon={GraduationCap}>
      {shown.length > 0 ? (
        <ul className="mt-4 min-w-0 divide-y divide-line">
          {shown.map((entry, index) => (
            <li key={`${entry.school}-${index}`} className="py-3 first:pt-0 last:pb-0">
              <p className="truncate text-sm font-semibold">{entry.school}</p>
              <p className="mt-0.5 truncate text-sm text-[var(--text-secondary)]">
                {[entry.degree, entry.major].filter(Boolean).join(", ")}
                {entry.minor ? ` · Minor in ${entry.minor}` : ""}
              </p>
              <p className="mt-1 truncate text-xs text-[var(--text-muted)]">
                {[
                  formatDateRange(entry.start_date, entry.end_date),
                  // GPA is shown only when the user chose to record one.
                  entry.gpa.trim()
                    ? `GPA ${entry.gpa}${entry.gpa_scale.trim() ? `/${entry.gpa_scale}` : ""}`
                    : ""
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </p>
            </li>
          ))}
        </ul>
      ) : (
        <EmptyHint text="Add your schools and degrees." href="/profile/education" label="Add education" />
      )}
      {remaining > 0 && <FooterMore count={remaining} noun="school" href="/profile/education" />}
    </ClickableCard>
  );
}

function ProjectsCard({ data }: { data: ProfileOverviewData }) {
  const shown = data.projects.slice(0, PREVIEW_LIMIT);
  const remaining = data.projects.length - shown.length;

  return (
    <ClickableCard href="/profile/projects" title="Projects" icon={FolderGit2}>
      {shown.length > 0 ? (
        <ul className="mt-4 min-w-0 divide-y divide-line">
          {shown.map((entry, index) => (
            <li key={`${entry.name}-${index}`} className="py-3 first:pt-0 last:pb-0">
              <p className="truncate text-sm font-semibold">{entry.name}</p>
              {(entry.description || entry.bullets[0]) && (
                <p className="mt-0.5 line-clamp-1 text-sm text-[var(--text-secondary)]">
                  {entry.description || entry.bullets[0]}
                </p>
              )}
              {entry.technologies.length > 0 && (
                <p className="mt-1 truncate text-xs text-[var(--text-muted)]">
                  {entry.technologies.slice(0, 4).join(" · ")}
                  {entry.technologies.length > 4 ? ` +${entry.technologies.length - 4}` : ""}
                </p>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <EmptyHint text="Projects are strong evidence when your experience is short." href="/profile/projects" label="Add a project" />
      )}
      {remaining > 0 && <FooterMore count={remaining} noun="project" href="/profile/projects" />}
    </ClickableCard>
  );
}

/** Groups shown before the rest collapse into "+N more". */
const SKILL_GROUP_LIMIT = 4;
/** Skills listed inside one group. */
const SKILLS_PER_GROUP = 6;

function SkillsCard({ data }: { data: ProfileOverviewData }) {
  const groups = groupSkills(data.profile.skills);
  const shown = groups.slice(0, SKILL_GROUP_LIMIT);
  const hiddenSkillCount = groups
    .slice(SKILL_GROUP_LIMIT)
    .reduce((total, group) => total + group.skills.length, 0);

  return (
    <ClickableCard href="/profile/skills" title="Skills" icon={Wrench}>
      {shown.length > 0 ? (
        <div className="mt-4 grid min-w-0 gap-4">
          {shown.map((group) => {
            const visible = group.skills.slice(0, SKILLS_PER_GROUP);
            const remaining = group.skills.length - visible.length;
            return (
              <div key={group.name}>
                <p className="text-xs font-medium uppercase tracking-[0.08em] text-[var(--text-muted)]">
                  {group.name}
                  <span className="ml-1.5 font-normal normal-case tracking-normal">
                    ({group.skills.length})
                  </span>
                </p>
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {visible.map((skill) => (
                    <span
                      key={skill}
                      className="rounded-lg border border-line bg-panel px-2 py-1 text-xs text-[var(--text-secondary)]"
                    >
                      {skill}
                    </span>
                  ))}
                  {remaining > 0 && <MoreCount count={remaining} />}
                </div>
              </div>
            );
          })}
          {hiddenSkillCount > 0 && (
            <FooterMore count={hiddenSkillCount} noun="skill" href="/profile/skills" />
          )}
        </div>
      ) : (
        <EmptyHint text="Skills drive job matching and resume tailoring." href="/profile/skills" label="Add skills" />
      )}
    </ClickableCard>
  );
}

/* ---------------------------------------------------------------------- */
/* Shared bits                                                            */
/* ---------------------------------------------------------------------- */


/**
 * Publications.
 *
 * Genuinely optional: the empty state invites rather than nags, and nothing
 * here feeds profile completion or autofill readiness. A candidate with no
 * papers is not an incomplete candidate.
 */
function PublicationsCard({ data }: { data: ProfileOverviewData }) {
  const shown = data.publications.slice(0, PREVIEW_LIMIT);
  const remaining = data.publications.length - shown.length;

  return (
    <ClickableCard href="/profile/publications" title="Publications" icon={BookText}>
      {shown.length > 0 ? (
        <ul className="mt-4 divide-y divide-line">
          {shown.map((entry, index) => (
            <li key={`${entry.title}-${index}`} className="py-3 first:pt-0 last:pb-0">
              <p className="truncate text-sm font-semibold">{entry.title}</p>
              <p className="mt-0.5 truncate text-xs text-[var(--text-muted)]">
                {[entry.venue, yearOf(entry.publication_date)].filter(Boolean).join(" · ")}
              </p>
              {entry.authors.length > 0 && (
                <p className="mt-0.5 truncate text-xs text-[var(--text-muted)]">
                  {entry.authors.slice(0, 3).join(", ")}
                  {entry.authors.length > 3 ? ` +${entry.authors.length - 3}` : ""}
                </p>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <EmptyHint
          text="Share research, articles, or papers when relevant."
          href="/profile/publications"
          label="Add publication"
        />
      )}
      {remaining > 0 && (
        <FooterMore count={remaining} noun="publication" href="/profile/publications" />
      )}
    </ClickableCard>
  );
}


function CredentialsCard({ data }: { data: ProfileOverviewData }) {
  // One list for the card: certifications first, then awards, each keeping the
  // detail line that identifies it. They stay separate records underneath.
  const entries = [
    ...data.certifications.map((item) => ({
      key: `cert-${item.name}`,
      name: item.name,
      detail: [item.issuer, yearOf(item.issue_date)].filter(Boolean).join(" · "),
      href: item.credential_url
    })),
    ...data.awards.map((item) => ({
      key: `award-${item.name}`,
      name: item.name,
      detail: [item.issuer, yearOf(item.date)].filter(Boolean).join(" · "),
      href: ""
    }))
  ];
  const shown = entries.slice(0, PREVIEW_LIMIT);
  const remaining = entries.length - shown.length;

  return (
    <ClickableCard href="/profile/credentials" title="Certifications & Awards" icon={Medal}>
      {shown.length > 0 ? (
        <ul className="mt-4 divide-y divide-line">
          {shown.map((entry) => (
            <li key={entry.key} className="py-3 first:pt-0 last:pb-0">
              <p className="truncate text-sm font-semibold">{entry.name}</p>
              {entry.detail && (
                <p className="mt-0.5 truncate text-xs text-[var(--text-muted)]">{entry.detail}</p>
              )}
              {entry.href && (
                <a
                  href={entry.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  /* Above the card overlay: opens the credential, not the editor. */
                  className="focus-ring relative z-10 mt-1 inline-flex items-center gap-1 text-xs font-medium text-pine hover:underline"
                >
                  View credential <ArrowRight className="h-3 w-3" aria-hidden />
                </a>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <EmptyHint
          text="Certifications and awards you have earned."
          href="/profile/credentials"
          label="Add"
        />
      )}
      {remaining > 0 && (
        <FooterMore count={remaining} noun="credential" href="/profile/credentials" />
      )}
    </ClickableCard>
  );
}

/** Just the year from a stored date, for a dense summary line. */
function yearOf(value: string): string {
  const match = /^(\d{4})/.exec(value.trim());
  return match ? match[1] : "";
}

function FooterMore({ count, noun, href }: { count: number; noun: string; href: string }) {
  return (
    <div className="mt-3 border-t border-line pt-3">
      <Link
        href={href}
        className="focus-ring relative z-10 text-sm font-medium text-[var(--text-muted)] transition hover:text-pine"
      >
        +{count} more {noun}
        {count === 1 ? "" : "s"}
      </Link>
    </div>
  );
}

function EmptyHint({ text, href, label }: { text: string; href: string; label: string }) {
  return (
    <div className="mt-4 rounded-xl border border-dashed border-line bg-panel px-4 py-4">
      <p className="text-sm text-[var(--text-muted)]">{text}</p>
      <Link
        href={href}
        className="focus-ring relative z-10 mt-2 inline-flex items-center gap-1 text-sm font-semibold text-pine"
      >
        {label} <ArrowRight className="h-3.5 w-3.5" aria-hidden />
      </Link>
    </div>
  );
}

function OverviewSkeleton() {
  return (
    <div className="pb-10" data-testid="profile-overview-skeleton">
      <div className="flex flex-col gap-4 border-b border-line pb-6 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <Block className="h-9 w-40" />
          <Block className="mt-3 h-4 w-80 max-w-full" />
        </div>
        <div className="flex gap-2">
          <Block className="h-10 w-48 rounded-xl" />
          <Block className="h-10 w-28 rounded-xl" />
        </div>
      </div>
      <div className="mt-6 grid items-start gap-5 xl:grid-cols-[minmax(0,32fr)_minmax(0,68fr)]">
        <div className="grid gap-5">
          <CardSkeleton lines={4} />
          <CardSkeleton lines={5} />
        </div>
        <div className="grid gap-5">
          <CardSkeleton lines={5} />
          <CardSkeleton lines={4} />
          <CardSkeleton lines={4} />
        </div>
      </div>
      <span className="sr-only">Loading your profile</span>
    </div>
  );
}

function CardSkeleton({ lines }: { lines: number }) {
  return (
    <div className="rounded-2xl border border-line bg-white p-5">
      <Block className="h-5 w-32" />
      <div className="mt-4 grid gap-3">
        {Array.from({ length: lines }).map((_, index) => (
          <Block key={index} className="h-4 w-full" />
        ))}
      </div>
    </div>
  );
}

function Block({ className = "" }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={`block animate-pulse rounded bg-[var(--skeleton)] ${className}`}
    />
  );
}

export { EditLink };

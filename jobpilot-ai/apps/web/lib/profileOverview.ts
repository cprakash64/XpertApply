"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { normalizeProfile, type ProfileForm, type ProfileWire } from "@/lib/profileForm";

/**
 * Data for the Profile overview.
 *
 * Four reads, issued in parallel: the profile record, the career records, the
 * completion/readiness scores, and the reusable application answers. The scores
 * come from the backend so the Profile page and the Dashboard quote the same
 * number for the same profile; the answers back the application-preferences
 * card, which shows what the user actually chose rather than a placeholder.
 *
 * `normalizeProfile` is reused rather than reimplemented — it is the single
 * boundary between the profile wire format and the app, and duplicating it here
 * is exactly the drift it was written to prevent.
 */

export type EducationEntry = {
  school: string;
  degree: string;
  major: string;
  minor: string;
  start_date: string;
  end_date: string;
  gpa: string;
  gpa_scale: string;
};

export type ExperienceEntry = {
  company: string;
  title: string;
  location: string;
  start_date: string;
  end_date: string;
  currently_working: boolean;
  technologies: string[];
};

export type CertificationEntry = {
  name: string;
  issuer: string;
  issue_date: string;
  expiration_date: string;
  credential_url: string;
};

export type AwardEntry = {
  name: string;
  issuer: string;
  date: string;
  description: string;
};

export type PublicationEntry = {
  title: string;
  venue: string;
  authors: string[];
  publication_date: string;
  url: string;
  doi: string;
  description: string;
};

export type ProjectEntry = {
  name: string;
  description: string;
  technologies: string[];
  bullets: string[];
};

export type ScoreBreakdown = {
  percent: number;
  satisfied: string[];
  missing: { key: string; label: string }[];
};

export type ProfileCompleteness = {
  completion: ScoreBreakdown;
  autofillReadiness: ScoreBreakdown;
};

export type ProfileOverviewData = {
  profile: ProfileForm;
  /** True when no profile record exists yet — a brand-new account. */
  isNewProfile: boolean;
  education: EducationEntry[];
  experience: ExperienceEntry[];
  projects: ProjectEntry[];
  certifications: CertificationEntry[];
  awards: AwardEntry[];
  publications: PublicationEntry[];
  /** The three reusable legal answers, for the application-preferences card. */
  eligibility: EligibilityAnswer[];
  completeness: ProfileCompleteness;
};

const EMPTY_SCORE: ScoreBreakdown = { percent: 0, satisfied: [], missing: [] };

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function list(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim() !== "")
    : [];
}

function toEducation(raw: unknown): EducationEntry[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((row) => {
    const record = (row ?? {}) as Record<string, unknown>;
    return {
      school: text(record.school),
      degree: text(record.degree),
      major: text(record.major),
      minor: text(record.minor),
      start_date: text(record.start_date),
      end_date: text(record.end_date),
      gpa: text(record.gpa),
      gpa_scale: text(record.gpa_scale)
    };
  });
}

function toExperience(raw: unknown): ExperienceEntry[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((row) => {
    const record = (row ?? {}) as Record<string, unknown>;
    return {
      company: text(record.company),
      title: text(record.title),
      location: text(record.location),
      start_date: text(record.start_date),
      end_date: text(record.end_date),
      currently_working: Boolean(record.currently_working),
      technologies: list(record.technologies)
    };
  });
}

function toProjects(raw: unknown): ProjectEntry[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((row) => {
    const record = (row ?? {}) as Record<string, unknown>;
    return {
      name: text(record.name),
      description: text(record.description),
      technologies: list(record.technologies),
      bullets: list(record.bullets)
    };
  });
}

/**
 * One reusable application answer, as the eligibility endpoint reports it.
 *
 * `answer` is null when the question is unanswered OR when the user chose to
 * answer it per application — `answered` is what distinguishes those, and the
 * two must never be collapsed.
 */
export type EligibilityAnswer = {
  field: string;
  prompt: string;
  answer: "yes" | "no" | null;
  answered: boolean;
  reusable: boolean;
};

function toCertifications(raw: unknown): CertificationEntry[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((row) => {
    const record = (row ?? {}) as Record<string, unknown>;
    return {
      name: text(record.name),
      issuer: text(record.issuer),
      issue_date: text(record.issue_date),
      expiration_date: text(record.expiration_date),
      credential_url: text(record.credential_url)
    };
  });
}

function toAwards(raw: unknown): AwardEntry[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((row) => {
    const record = (row ?? {}) as Record<string, unknown>;
    return {
      name: text(record.name),
      issuer: text(record.issuer),
      date: text(record.date),
      description: text(record.description)
    };
  });
}

function toPublications(raw: unknown): PublicationEntry[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((row) => {
    const record = (row ?? {}) as Record<string, unknown>;
    return {
      title: text(record.title),
      venue: text(record.venue),
      authors: list(record.authors),
      publication_date: text(record.publication_date),
      url: text(record.url),
      doi: text(record.doi),
      description: text(record.description)
    };
  });
}

function toEligibility(raw: unknown): EligibilityAnswer[] {
  const answers = (raw as { answers?: unknown })?.answers;
  if (!Array.isArray(answers)) return [];
  return answers.flatMap((row) => {
    const record = (row ?? {}) as Record<string, unknown>;
    const field = text(record.field);
    if (!field) return [];
    const answer = text(record.answer);
    return [
      {
        field,
        prompt: text(record.prompt),
        answer: answer === "yes" || answer === "no" ? answer : null,
        answered: Boolean(record.answered),
        reusable: Boolean(record.reusable)
      }
    ];
  });
}

function toScore(raw: unknown): ScoreBreakdown {
  const record = (raw ?? {}) as Record<string, unknown>;
  const percent = typeof record.percent === "number" ? record.percent : 0;
  const missing = Array.isArray(record.missing)
    ? record.missing.flatMap((item) => {
        const entry = (item ?? {}) as Record<string, unknown>;
        const key = text(entry.key);
        const label = text(entry.label);
        return key ? [{ key, label: label || key }] : [];
      })
    : [];
  return {
    // Clamped so a malformed response can never render a 340%-wide bar.
    percent: Math.max(0, Math.min(100, Math.round(percent))),
    satisfied: list(record.satisfied),
    missing
  };
}

export async function fetchProfileOverview(): Promise<ProfileOverviewData> {
  const [profileResult, careerResult, completenessResult, eligibilityResult] = await Promise.all([
    api<{ profile: ProfileWire | null }>("/profile"),
    api<Record<string, unknown>>("/profile/career"),
    api<Record<string, unknown>>("/profile/completeness"),
    // The application-preferences card shows the user's *current* answers, so
    // it needs them. Parallel with the rest, so it costs no extra round trip.
    api<Record<string, unknown>>("/profile/application-eligibility").catch(() => ({}))
  ]);

  return {
    profile: normalizeProfile(profileResult.profile),
    isNewProfile: profileResult.profile === null,
    education: toEducation(careerResult.education),
    experience: toExperience(careerResult.experience),
    projects: toProjects(careerResult.projects),
    certifications: toCertifications(careerResult.certifications),
    awards: toAwards(careerResult.awards),
    publications: toPublications(careerResult.publications),
    eligibility: toEligibility(eligibilityResult),
    completeness: {
      completion: toScore(completenessResult.completion ?? EMPTY_SCORE),
      autofillReadiness: toScore(completenessResult.autofillReadiness ?? EMPTY_SCORE)
    }
  };
}

export type ProfileOverviewState = {
  data: ProfileOverviewData | null;
  loading: boolean;
  error: string;
  reload: () => void;
};

export function useProfileOverview(): ProfileOverviewState {
  const [data, setData] = useState<ProfileOverviewData | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const mounted = useRef(true);

  // Every state write here is asynchronous, so the effect below never triggers
  // a cascading render.
  const refresh = useCallback(() => {
    fetchProfileOverview()
      .then((overview) => {
        if (!mounted.current) return;
        setData(overview);
        setError("");
      })
      .catch((cause: unknown) => {
        if (!mounted.current) return;
        setError(cause instanceof Error ? cause.message : "Could not load your profile.");
      })
      .finally(() => {
        if (mounted.current) setLoading(false);
      });
  }, []);

  useEffect(() => {
    mounted.current = true;
    refresh();
    return () => {
      mounted.current = false;
    };
  }, [refresh]);

  return { data, loading, error, reload: refresh };
}

/**
 * Whether this profile still needs first-time onboarding.
 *
 * The 10-step wizard remains the right experience when there is genuinely
 * nothing to summarize; once the user has any real career information, the
 * overview takes over as the management UI.
 */
export function needsOnboarding(data: ProfileOverviewData): boolean {
  if (data.isNewProfile) return true;
  const { profile } = data;
  const hasIdentity = Boolean(profile.full_name.trim() || profile.first_name.trim());
  const hasCareer =
    data.experience.length > 0 || data.education.length > 0 || data.projects.length > 0;
  const hasTargets = profile.target_roles.length > 0 || profile.skills.length > 0;
  return !hasIdentity && !hasCareer && !hasTargets;
}

/** "Jan 2023 — Present" style range, tolerant of partial or missing dates. */
export function formatDateRange(start: string, end: string, current = false): string {
  const from = formatMonth(start);
  const to = current ? "Present" : formatMonth(end);
  if (!from && !to) return "";
  if (!from) return to;
  if (!to) return from;
  return `${from} — ${to}`;
}

function formatMonth(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  // Stored dates are ISO-ish ("2023-01", "2023-01-15"). Anything else is shown
  // as the user typed it rather than being guessed at.
  const match = /^(\d{4})-(\d{2})/.exec(trimmed);
  if (!match) return trimmed;
  const monthIndex = Number(match[2]) - 1;
  const months = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"
  ];
  return months[monthIndex] ? `${months[monthIndex]} ${match[1]}` : match[1];
}

/** Initials for the identity avatar, from the best name the profile has. */
export function profileInitials(profile: ProfileForm): string {
  // The given name is chosen first, then the family name, so a profile with a
  // last name but no preferred first name still yields two initials rather than
  // falling through to the surname alone.
  const given = profile.preferred_first_name.trim() || profile.first_name.trim();
  const family = profile.preferred_last_name.trim() || profile.last_name.trim();
  const source = [given, family].filter(Boolean).join(" ") || profile.full_name.trim();

  const words = source.split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return `${words[0][0]}${words[words.length - 1][0]}`.toUpperCase();
}

/**
 * The name to show, preferring what the user asked to be called.
 *
 * Each part falls back independently, so a profile that sets only a preferred
 * FIRST name still renders the legal surname beside it instead of dropping it —
 * and one that sets only a preferred last name does not lose the given name.
 */
export function displayName(profile: ProfileForm): string {
  const given = profile.preferred_first_name.trim() || profile.first_name.trim();
  const family = profile.preferred_last_name.trim() || profile.last_name.trim();
  return [given, family].filter(Boolean).join(" ") || profile.full_name.trim();
}

/** "Phoenix, AZ" / "Phoenix, United States" — whichever parts exist. */
export function locationLabel(profile: ProfileForm): string {
  return [profile.location_city, profile.location_state || profile.location_country]
    .map((part) => part.trim())
    .filter(Boolean)
    .join(", ");
}

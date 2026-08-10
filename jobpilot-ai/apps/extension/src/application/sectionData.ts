/**
 * Choosing WHAT goes into a dynamic application section.
 *
 * Deliberately separate from any DOM work: which internship, project, award or
 * link belongs on this application is a data decision, and keeping it here
 * makes it testable without a browser and reusable across employers.
 *
 * The governing rule throughout: nothing is invented. Every value returned here
 * came from a stored, verified record. A record missing a field the destination
 * requires is skipped for review rather than completed with a plausible guess.
 */

export type SectionEnum =
  | "work_experience"
  | "education"
  | "internship_experience"
  | "project_experience"
  | "work_samples"
  | "honors_awards"
  | "language_skills"
  | "self_introduction"
  | "sns";

export interface SourcedRecord {
  id: string;
  /** Where the record came from; unverified records are never auto-filled. */
  source: string;
  verified: boolean;
  confidence: number;
}

export interface ExperienceRecord extends SourcedRecord {
  organization?: string;
  title?: string;
  location?: string;
  startDate?: string;
  endDate?: string;
  currentlyWorking?: boolean;
  description?: string;
  /** Explicit classification. NEVER derived from the title text. */
  employmentType?: "internship" | "co_op" | "research" | "full_time" | "part_time" | "contract";
  skills?: string[];
}

export interface ProjectRecord extends SourcedRecord {
  name?: string;
  role?: string;
  startDate?: string;
  endDate?: string;
  description?: string;
  technologies?: string[];
  url?: string;
}

export interface AwardRecord extends SourcedRecord {
  name?: string;
  issuer?: string;
  date?: string;
  description?: string;
}

export interface LanguageRecord extends SourcedRecord {
  language?: string;
  /** Canonical proficiency. Never inferred from nationality or location. */
  proficiency?: "native" | "professional" | "working" | "elementary";
}

export interface LinkRecord extends SourcedRecord {
  url?: string;
  platform?: string;
  /** A private repo/link is only usable when the user marked it shareable. */
  shareable?: boolean;
}

export interface JobContext {
  title?: string;
  company?: string;
  requiredSkills?: string[];
}

/** Why a record was not used — surfaced in the ledger, never as free text. */
export type SkipReason =
  | "unverified"
  | "missing_required_field"
  | "not_an_internship"
  | "unsafe_url"
  | "not_shareable"
  | "duplicate"
  | "unknown_proficiency"
  | "low_relevance";

export type Selection<T> = {
  selected: T[];
  skipped: { id: string; reason: SkipReason }[];
};

// --------------------------------------------------------------------------- //
// Relevance
// --------------------------------------------------------------------------- //
function normalizeToken(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9+#.]+/g, " ").trim();
}

function tokens(value: string | undefined): Set<string> {
  if (!value) return new Set();
  return new Set(normalizeToken(value).split(/\s+/).filter((token) => token.length > 2));
}

/** Overlap of skills plus title similarity, in [0, 1]. Deterministic. */
export function relevanceScore(
  candidate: { title?: string; skills?: string[]; description?: string; endDate?: string },
  job: JobContext
): number {
  const jobSkills = new Set((job.requiredSkills ?? []).map(normalizeToken).filter(Boolean));
  const candidateSkills = new Set((candidate.skills ?? []).map(normalizeToken).filter(Boolean));
  let skillOverlap = 0;
  if (jobSkills.size > 0) {
    let hits = 0;
    for (const skill of jobSkills) {
      if (candidateSkills.has(skill)) hits += 1;
      else if (candidate.description && normalizeToken(candidate.description).includes(skill)) hits += 1;
    }
    skillOverlap = hits / jobSkills.size;
  }

  const jobTitleTokens = tokens(job.title);
  const candidateTitleTokens = tokens(candidate.title);
  let titleSimilarity = 0;
  if (jobTitleTokens.size > 0 && candidateTitleTokens.size > 0) {
    let hits = 0;
    for (const token of jobTitleTokens) if (candidateTitleTokens.has(token)) hits += 1;
    titleSimilarity = hits / jobTitleTokens.size;
  }

  // Recency: full credit within 2 years, decaying to 0 at 8.
  let recency = 0.5;
  const year = Number((candidate.endDate ?? "").slice(0, 4));
  if (Number.isFinite(year) && year > 1970) {
    const age = new Date().getUTCFullYear() - year;
    recency = age <= 2 ? 1 : age >= 8 ? 0 : 1 - (age - 2) / 6;
  }

  return 0.5 * skillOverlap + 0.3 * titleSimilarity + 0.2 * recency;
}

// --------------------------------------------------------------------------- //
// Internship experience
// --------------------------------------------------------------------------- //
/**
 * Only records the user EXPLICITLY classified as internship/co-op/research.
 *
 * Title text is not evidence: "Software Engineer" at a summer employer may or
 * may not have been an internship, and guessing misrepresents the candidate's
 * history in the employer's own structured data.
 */
export function selectInternships(
  records: ExperienceRecord[],
  job: JobContext,
  limit = 3
): Selection<ExperienceRecord> {
  const skipped: { id: string; reason: SkipReason }[] = [];
  const eligible: ExperienceRecord[] = [];

  for (const record of records) {
    if (!record.verified) {
      skipped.push({ id: record.id, reason: "unverified" });
      continue;
    }
    if (!["internship", "co_op", "research"].includes(record.employmentType ?? "")) {
      skipped.push({ id: record.id, reason: "not_an_internship" });
      continue;
    }
    // The destination needs an employer and a start date to store the entry at
    // all; a record without them would create a half-empty row.
    if (!record.organization || !record.title || !record.startDate) {
      skipped.push({ id: record.id, reason: "missing_required_field" });
      continue;
    }
    eligible.push(record);
  }

  eligible.sort((a, b) => relevanceScore(b, job) - relevanceScore(a, job));
  return { selected: eligible.slice(0, limit), skipped };
}

// --------------------------------------------------------------------------- //
// Projects
// --------------------------------------------------------------------------- //
export function selectProjects(
  records: ProjectRecord[],
  job: JobContext,
  limit = 3
): Selection<ProjectRecord> {
  const skipped: { id: string; reason: SkipReason }[] = [];
  const eligible: ProjectRecord[] = [];

  for (const record of records) {
    if (!record.verified) {
      skipped.push({ id: record.id, reason: "unverified" });
      continue;
    }
    if (!record.name) {
      skipped.push({ id: record.id, reason: "missing_required_field" });
      continue;
    }
    eligible.push(record);
  }

  eligible.sort(
    (a, b) =>
      relevanceScore({ title: b.name, skills: b.technologies, description: b.description, endDate: b.endDate }, job) -
      relevanceScore({ title: a.name, skills: a.technologies, description: a.description, endDate: a.endDate }, job)
  );
  return { selected: eligible.slice(0, limit), skipped };
}

// --------------------------------------------------------------------------- //
// Work samples / links
// --------------------------------------------------------------------------- //
/**
 * Is this link safe to publish on an employer's application?
 *
 * Rejects anything that could leak a credential or expose something private:
 * non-HTTPS, embedded userinfo, localhost/private hosts, and URLs carrying
 * what look like signed/expiring tokens.
 */
export function isPublishableUrl(raw: string | undefined): boolean {
  if (!raw) return false;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  if (url.username || url.password) return false;

  const host = url.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost")) return false;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return false;
  if (/^(10\.|192\.168\.|127\.)/.test(host)) return false;
  if (host.endsWith(".local") || host.endsWith(".internal")) return false;

  // Signed / expiring URLs are private by construction.
  const TOKEN_PARAMS = ["token", "signature", "sig", "x-amz-signature", "expires", "access_token", "key"];
  for (const [name] of url.searchParams) {
    if (TOKEN_PARAMS.includes(name.toLowerCase())) return false;
  }
  return true;
}

const PLATFORM_PATTERNS: { platform: string; pattern: RegExp }[] = [
  { platform: "linkedin", pattern: /(^|\.)linkedin\.com$/i },
  { platform: "github", pattern: /(^|\.)github\.(com|io)$/i },
  { platform: "gitlab", pattern: /(^|\.)gitlab\.com$/i },
  { platform: "google_scholar", pattern: /(^|\.)scholar\.google\.[a-z.]+$/i },
  { platform: "x", pattern: /(^|\.)(twitter|x)\.com$/i },
  { platform: "medium", pattern: /(^|\.)medium\.com$/i },
  { platform: "stackoverflow", pattern: /(^|\.)stackoverflow\.com$/i },
  { platform: "youtube", pattern: /(^|\.)(youtube\.com|youtu\.be)$/i },
  { platform: "behance", pattern: /(^|\.)behance\.net$/i },
  { platform: "dribbble", pattern: /(^|\.)dribbble\.com$/i }
];

/** Classify a stored link. Unknown hosts are "personal_website", never guessed
 * into a named platform. */
export function classifyPlatform(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  const match = PLATFORM_PATTERNS.find((entry) => entry.pattern.test(host));
  return match ? match.platform : "personal_website";
}

export function selectLinks(records: LinkRecord[], limit = 5): Selection<LinkRecord> {
  const skipped: { id: string; reason: SkipReason }[] = [];
  const selected: LinkRecord[] = [];
  const seen = new Set<string>();

  for (const record of records) {
    if (!record.verified) {
      skipped.push({ id: record.id, reason: "unverified" });
      continue;
    }
    if (!isPublishableUrl(record.url)) {
      skipped.push({ id: record.id, reason: "unsafe_url" });
      continue;
    }
    // A private artefact is only shareable when the user said so.
    if (record.shareable === false) {
      skipped.push({ id: record.id, reason: "not_shareable" });
      continue;
    }
    const key = canonicalUrlKey(record.url!);
    if (seen.has(key)) {
      skipped.push({ id: record.id, reason: "duplicate" });
      continue;
    }
    seen.add(key);
    selected.push({ ...record, platform: record.platform ?? classifyPlatform(record.url!) ?? undefined });
    if (selected.length >= limit) break;
  }
  return { selected, skipped };
}

/** Trailing-slash and case-insensitive host, so the same link twice is one. */
export function canonicalUrlKey(raw: string): string {
  try {
    const url = new URL(raw);
    const path = url.pathname.replace(/\/+$/, "");
    return `${url.hostname.toLowerCase().replace(/^www\./, "")}${path.toLowerCase()}`;
  } catch {
    return raw.trim().toLowerCase();
  }
}

// --------------------------------------------------------------------------- //
// Awards
// --------------------------------------------------------------------------- //
export function selectAwards(records: AwardRecord[], job: JobContext, limit = 3): Selection<AwardRecord> {
  const skipped: { id: string; reason: SkipReason }[] = [];
  const eligible: AwardRecord[] = [];
  for (const record of records) {
    if (!record.verified) {
      skipped.push({ id: record.id, reason: "unverified" });
      continue;
    }
    // An award with no name is unusable; an issuer or date we do not have is
    // left blank rather than inferred from the award's name.
    if (!record.name) {
      skipped.push({ id: record.id, reason: "missing_required_field" });
      continue;
    }
    eligible.push(record);
  }
  eligible.sort(
    (a, b) =>
      relevanceScore({ title: b.name, description: b.description, endDate: b.date }, job) -
      relevanceScore({ title: a.name, description: a.description, endDate: a.date }, job)
  );
  return { selected: eligible.slice(0, limit), skipped };
}

// --------------------------------------------------------------------------- //
// Languages
// --------------------------------------------------------------------------- //
const PROFICIENCY_SYNONYMS: Record<string, RegExp[]> = {
  native: [/native/i, /bilingual/i, /mother ?tongue/i, /^c2$/i],
  professional: [/full professional/i, /^professional/i, /fluent/i, /advanced/i, /^c1$/i],
  working: [/working proficiency/i, /limited working/i, /intermediate/i, /conversational/i, /^b[12]$/i],
  elementary: [/elementary/i, /basic/i, /beginner/i, /^a[12]$/i]
};

/**
 * Map a canonical proficiency onto the destination's own options.
 *
 * Returns null when no option clearly corresponds — the level then goes to
 * review. Overstating proficiency on an application is a misrepresentation, so
 * an approximate match is not good enough.
 */
export function mapProficiency(
  canonical: LanguageRecord["proficiency"],
  options: string[]
): string | null {
  if (!canonical) return null;
  const patterns = PROFICIENCY_SYNONYMS[canonical];
  if (!patterns) return null;
  const match = options.find((option) => patterns.some((pattern) => pattern.test(option.trim())));
  return match ?? null;
}

export function selectLanguages(records: LanguageRecord[]): Selection<LanguageRecord> {
  const skipped: { id: string; reason: SkipReason }[] = [];
  const selected: LanguageRecord[] = [];
  for (const record of records) {
    if (!record.verified) {
      skipped.push({ id: record.id, reason: "unverified" });
      continue;
    }
    if (!record.language) {
      skipped.push({ id: record.id, reason: "missing_required_field" });
      continue;
    }
    // No proficiency stored means the user never told us. Nationality, name and
    // country of study are not evidence of language ability.
    if (!record.proficiency) {
      skipped.push({ id: record.id, reason: "unknown_proficiency" });
      continue;
    }
    selected.push(record);
  }
  return { selected, skipped };
}

// --------------------------------------------------------------------------- //
// Self-introduction
// --------------------------------------------------------------------------- //
export interface SelfIntroductionInput {
  jobTitle?: string;
  company?: string;
  /** At most two, already verified. */
  qualifications: string[];
  highlight?: { title?: string; description?: string };
  careerFocus?: string;
}

/**
 * A grounded, deterministic self-introduction.
 *
 * Every clause is assembled from supplied verified facts. There are no
 * superlatives, no enthusiasm claims, and no invented metrics — if a fact was
 * not provided, the corresponding clause is simply absent. This is the default
 * path; an optional AI rewrite may improve the prose but must fall back here.
 */
export function buildSelfIntroduction(input: SelfIntroductionInput, maxChars = 900): string {
  const parts: string[] = [];

  const focus = input.careerFocus?.trim();
  if (focus) parts.push(`I'm a ${focus}.`);

  const qualifications = input.qualifications.map((item) => item.trim()).filter(Boolean).slice(0, 2);
  if (qualifications.length === 1) {
    parts.push(`My background includes ${qualifications[0]}.`);
  } else if (qualifications.length === 2) {
    parts.push(`My background includes ${qualifications[0]} and ${qualifications[1]}.`);
  }

  if (input.highlight?.title) {
    const detail = input.highlight.description?.trim();
    parts.push(
      detail ? `Most recently I worked on ${input.highlight.title}: ${detail}` : `Most recently I worked on ${input.highlight.title}.`
    );
  }

  if (input.jobTitle && input.company) {
    parts.push(`I'm applying for the ${input.jobTitle} role at ${input.company} because it builds directly on that work.`);
  } else if (input.jobTitle) {
    parts.push(`I'm applying for the ${input.jobTitle} role because it builds directly on that work.`);
  }

  return truncateOnBoundary(parts.join(" ").replace(/\s+/g, " ").trim(), maxChars);
}

/** Trim to a sentence boundary where possible, so the field never ends mid-word. */
export function truncateOnBoundary(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const clipped = text.slice(0, maxChars);
  // A cut that lands exactly on a sentence end is already clean.
  if (/[.!?]$/.test(clipped)) return clipped;
  const lastStop = Math.max(clipped.lastIndexOf(". "), clipped.lastIndexOf("! "), clipped.lastIndexOf("? "));
  if (lastStop > maxChars * 0.5) return clipped.slice(0, lastStop + 1);
  const lastSpace = clipped.lastIndexOf(" ");
  return (lastSpace > 0 ? clipped.slice(0, lastSpace) : clipped).trim();
}

/** Language an AI-written intro must never contain. */
const BANNED_INTRO_PATTERNS = [
  /perfect (candidate|fit)/i,
  /i am extremely (excited|passionate)/i,
  /\bpassionate about\b/i,
  /as an ai\b/i,
  /leverage my synerg/i,
  /\bworld[- ]class\b/i,
  // Any percentage claim: an AI rewrite has no source for a number the
  // deterministic draft did not contain.
  /\b\d+(\.\d+)?%/,
  /\b(single|hand)-?handedly\b/i,
  /\b\d+x (faster|better|more)\b/i
];

/** Reject an AI rewrite that overclaims or invents metrics; caller falls back
 * to the deterministic draft. */
export function isAcceptableIntroduction(text: string, maxChars: number): boolean {
  const trimmed = (text || "").trim();
  if (!trimmed || trimmed.length > maxChars) return false;
  return !BANNED_INTRO_PATTERNS.some((pattern) => pattern.test(trimmed));
}

// --------------------------------------------------------------------------- //
// Idempotency
// --------------------------------------------------------------------------- //
/**
 * Stable identity for "this record in this section".
 *
 * Used to detect an entry the form already holds, so Retry autofill and a
 * section remount cannot add the same internship or link twice. Contains no
 * free-text description, so a reworded bullet does not read as a new entry.
 */
export function entryFingerprint(
  section: SectionEnum,
  item: { organization?: string; name?: string; title?: string; startDate?: string; url?: string; language?: string }
): string {
  const norm = (value: string | undefined) => normalizeToken(value ?? "").replace(/\s+/g, " ").trim();
  const organization = norm(item.organization);
  const title = norm(item.title ?? item.name ?? item.language);
  const start = (item.startDate ?? "").slice(0, 7);
  const url = item.url ? canonicalUrlKey(item.url) : "";
  return [section, title, organization, start, url].join("|");
}

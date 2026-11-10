const ATS_FAMILIES = ["greenhouse.io", "lever.co", "ashbyhq.com", "myworkdayjobs.com", "workday.com", "smartrecruiters.com", "rippling.com", "bamboohr.com", "applytojob.com", "jazz.co", "teamtailor.com"];

export function normalizeApplicationUrl(raw: string): URL | null {
  try {
    const url = new URL(raw);
    if (!["http:", "https:"].includes(url.protocol)) return null;
    url.hash = "";
    url.pathname = url.pathname.replace(/\/+$/, "") || "/";
    return url;
  } catch { return null; }
}

const IGNORED_PATH_TOKENS = new Set(["jobs", "job", "careers", "career", "apply", "application", "positions", "position"]);

/** Job-title words that appear in countless unrelated postings. Sharing one is not evidence of the same job. */
const GENERIC_TITLE_TOKENS = new Set([
  "engineer", "engineers", "engineering", "software", "senior", "junior", "staff", "principal", "manager", "management", "developer",
  "analyst", "associate", "lead", "director", "intern", "internship", "scientist", "specialist", "coordinator", "consultant", "designer",
  "architect", "technician", "operations", "remote", "hybrid", "full", "time", "part", "team", "global", "united", "states", "america"
]);

/** Query parameters that name ONE posting. */
const JOB_ID_PARAMS = ["gh_jid", "jid", "job_id", "jobid", "jobId", "requisition", "reqid", "token", "lever-source"];

function pathTokens(path: string): string[] {
  return path.toLowerCase().split(/[^a-z0-9]+/).filter((x) => x.length >= 4 && !IGNORED_PATH_TOKENS.has(x));
}

function jobIdOf(url: URL): string | null {
  for (const name of JOB_ID_PARAMS) {
    const value = url.searchParams.get(name);
    if (value && /^[A-Za-z0-9_-]{3,64}$/.test(value) && name !== "lever-source") return `${name.toLowerCase()}:${value.toLowerCase()}`;
  }
  return null;
}

const stripApplySuffix = (path: string): string => path.replace(/\/(apply|application)$/i, "") || "/";

/** Same job-posting path: equal, the same path plus the expected `/apply` or `/application` continuation, or a shared, SPECIFIC token.
 * "Specific" excludes generic title words (engineer, senior, software…): two different roles at one employer both say "engineer", and
 * a stale handoff for one must never be treated as a match for the other. This is what stops a handoff for one job from attaching to a
 * different job, including two postings under the same ATS family or on the same careers site. */
function pathsCorrespond(pathA: string, pathB: string): boolean {
  if (pathA === pathB) return true;
  if (stripApplySuffix(pathA) === stripApplySuffix(pathB)) return true;
  const tokensA = new Set(pathTokens(pathA).filter((token) => !GENERIC_TITLE_TOKENS.has(token)));
  const tokensB = pathTokens(pathB).filter((token) => !GENERIC_TITLE_TOKENS.has(token));
  if (tokensA.size === 0 || tokensB.length === 0) return false;
  return tokensB.some((token) => tokensA.has(token));
}

const UUIDISH = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;

/**
 * The identity of ONE job posting on a hosted ATS, or null when this URL names no particular posting (a board index, a listing, an
 * unknown host). Two URLs on the same ATS host are the same application only when these are equal: the company slug that every
 * posting of an employer shares is NOT identity. Hostname equality never is.
 */
export function atsJobIdentity(raw: string): string | null {
  const url = normalizeApplicationUrl(raw);
  if (!url) return null;
  const host = url.hostname.toLowerCase();
  const seg = url.pathname.split("/").filter(Boolean).map((x) => decodeURIComponent(x).toLowerCase());
  if (host === "lever.co" || host.endsWith(".lever.co")) {
    const i = seg.findIndex((x) => UUIDISH.test(x));
    return i >= 1 ? `lever:${seg[i - 1]}/${seg[i]!.replace(/-/g, "")}` : null;
  }
  if (host === "ashbyhq.com" || host.endsWith(".ashbyhq.com")) {
    const i = seg.findIndex((x) => UUIDISH.test(x));
    return i >= 1 ? `ashby:${seg[i - 1]}/${seg[i]!.replace(/-/g, "")}` : null;
  }
  if (host === "greenhouse.io" || host.endsWith(".greenhouse.io")) {
    const q = url.searchParams.get("gh_jid") ?? url.searchParams.get("token") ?? url.searchParams.get("jid");
    const j = seg.indexOf("jobs");
    const fromPath = j >= 0 && /^\d{3,}$/.test(seg[j + 1] ?? "") ? seg[j + 1]! : null;
    const id = fromPath ?? q;
    return id ? `greenhouse:${id}` : null;
  }
  if (host === "myworkdayjobs.com" || host.endsWith(".myworkdayjobs.com") || host === "myworkdaysite.com" || host.endsWith(".myworkdaysite.com")) {
    const j = seg.indexOf("job");
    if (j < 0) return null;
    const rest: string[] = [];
    for (const part of seg.slice(j + 1)) { if (part === "apply" || part === "applymanually" || part === "autofillwithresume" || part === "usemylastapplication") break; rest.push(part); }
    return rest.length ? `workday:${host}/${rest.join("/")}` : null;
  }
  return null;
}

export function urlsMatchForHandoff(expected: string, actual: string): boolean {
  const a = normalizeApplicationUrl(expected); const b = normalizeApplicationUrl(actual);
  if (!a || !b) return false;
  // Hosted ATS postings: identity or nothing. Sharing a hostname, an employer slug or a title word does not make two tabs one application.
  const ia = atsJobIdentity(expected), ib = atsJobIdentity(actual);
  const familyOf = (h: string) => ATS_FAMILIES.find((f) => h === f || h.endsWith(`.${f}`)) ?? null;
  const fa = familyOf(a.hostname), fb = familyOf(b.hostname);
  // Two pages of the SAME hosted ATS family with an identity-bearing URL are compared by identity only. A cross-host pair (an employer's
  // own page embedding gh_jid, say) still goes through the explicit-id rules below.
  if (fa !== null && fa === fb && (ia !== null || ib !== null)) return ia !== null && ia === ib;
  // An explicit posting id outranks path heuristics: two different ids are two different jobs, and the same id on the same host (or
  // ATS family) is the same job wherever its path points.
  const idA = jobIdOf(a), idB = jobIdOf(b);
  if (idA && idB && idA !== idB) return false;
  const sameSite = a.hostname === b.hostname || ATS_FAMILIES.some((f) => (a.hostname === f || a.hostname.endsWith(`.${f}`)) && (b.hostname === f || b.hostname.endsWith(`.${f}`)));
  if (idA && idB && idA === idB && sameSite) return true;
  const family = ATS_FAMILIES.find((f) => a.hostname === f || a.hostname.endsWith(`.${f}`));
  if (family) {
    // Same ATS family is necessary but never sufficient on its own — every
    // employer using that ATS shares the hostname, so the job-identifying
    // path must also correspond. Without this, a stale handoff for Temporal
    // could attach to an unrelated Ashby job just because both are hosted on
    // jobs.ashbyhq.com.
    if (!(b.hostname === family || b.hostname.endsWith(`.${family}`))) return false;
    return pathsCorrespond(a.pathname, b.pathname);
  }
  if (a.hostname !== b.hostname) return false;
  return pathsCorrespond(a.pathname, b.pathname);
}

export function isKnownAtsHost(raw: string): boolean {
  const url = normalizeApplicationUrl(raw);
  return Boolean(url && ATS_FAMILIES.some((f) => url.hostname === f || url.hostname.endsWith(`.${f}`)));
}

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

export function urlsMatchForHandoff(expected: string, actual: string): boolean {
  const a = normalizeApplicationUrl(expected); const b = normalizeApplicationUrl(actual);
  if (!a || !b) return false;
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

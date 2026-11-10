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

/**
 * Query parameters that name ONE posting, compared by their spelling-insensitive form (case, `-` and `_` ignored): `jobId`,
 * `JobID` and `job_id` are one key. Tracking parameters (utm_*, ref, source, lever-source) are deliberately absent.
 */
const JOB_ID_KEYS = [
  "ghjid", "jid", "jobid", "job", "jobnumber", "jobno", "jobcode", "requisition", "requisitionid", "reqid", "req",
  "postingid", "posting", "positionid", "position", "openingid", "opening", "vacancyid", "id", "token"
];

function jobIdOf(url: URL): string | null {
  const found = new Map<string, string>();
  for (const [name, value] of url.searchParams) {
    const key = name.toLowerCase().replace(/[-_]/g, "");
    if (JOB_ID_KEYS.includes(key) && !found.has(key) && /^[A-Za-z0-9_-]{1,64}$/.test(value)) found.set(key, value.toLowerCase());
  }
  for (const key of JOB_ID_KEYS) {
    const value = found.get(key);
    if (value !== undefined) return `${key}:${value}`;
  }
  return null;
}

const stripApplySuffix = (path: string): string => path.replace(/\/(apply|application)$/i, "") || "/";

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
  // An explicit posting id (query parameter) outranks everything else: two different ids are two different jobs, and the same id on the
  // same site is the same job wherever its path points.
  const idA = jobIdOf(a), idB = jobIdOf(b);
  if (idA && idB && idA !== idB) return false;
  const sameSite = a.hostname === b.hostname || (fa !== null && fa === fb);
  if (!sameSite) return false;
  if (idA && idB && idA === idB) return true;
  return postingsRelated(a, b);
}

/** Path segments that are an application's own continuation (form, step, review...), never a different posting. */
const CONTINUATION_SEGMENT = /^(apply|application|applications|form|step-?\d*|\d{1,2}|questions|review|details|resume|start|continue|thanks)$/;

/**
 * Tokens that NAME one posting: long numeric ids, UUIDs, long hex ids, requisition codes (R-1234, JR1234). A slug, a title word or an
 * employer segment is not here: those are shared by many postings.
 */
export function postingIdTokens(url: URL): Set<string> {
  const out = new Set<string>();
  for (const part of url.pathname.split(/[^A-Za-z0-9-]+/).filter(Boolean)) {
    if (UUIDISH.test(part)) { out.add(part.toLowerCase().replace(/-/g, "")); continue; }
    for (const token of part.split("-")) {
      const t = token.toLowerCase();
      if (/^\d{5,}$/.test(t)) out.add(t);
      else if (/^[0-9a-f]{12,}$/.test(t) && /\d/.test(t)) out.add(t);
      else if (/^(jr|r|req|reqid)\d{3,}$/.test(t)) out.add(t);
    }
  }
  return out;
}

/**
 * Two pages on one site are the same posting only on positive evidence, never on shared words:
 *   1. identical canonical path (an `/apply` or `/application` suffix aside);
 *   2. both name posting ids and share one;
 *   3. neither names an id, and one path is the other plus ONLY application-continuation segments (apply, step-2, review...).
 * Everything else is "not the same", so an unknown career site never inherits another job's workflow.
 */
function postingsRelated(a: URL, b: URL): boolean {
  const pa = stripApplySuffix(a.pathname), pb = stripApplySuffix(b.pathname);
  if (pa === pb) return true;
  const ia = postingIdTokens(a), ib = postingIdTokens(b);
  if (ia.size > 0 && ib.size > 0) return [...ia].some((x) => ib.has(x));
  if (ia.size > 0 || ib.size > 0) return false;
  const sa = a.pathname.split("/").filter(Boolean).map((x) => x.toLowerCase());
  const sb = b.pathname.split("/").filter(Boolean).map((x) => x.toLowerCase());
  const [short, long] = sa.length <= sb.length ? [sa, sb] : [sb, sa];
  const base = short.filter((x, i) => !(i >= short.length - 1 && CONTINUATION_SEGMENT.test(x)) || i < short.length - 1);
  const stem = base.length === short.length ? short : short.slice(0, -1);
  if (stem.length < 2 || stem.length > long.length) return false;
  if (!stem.every((x, i) => long[i] === x)) return false;
  return long.slice(stem.length).every((x) => CONTINUATION_SEGMENT.test(x));
}

export function isKnownAtsHost(raw: string): boolean {
  const url = normalizeApplicationUrl(raw);
  return Boolean(url && ATS_FAMILIES.some((f) => url.hostname === f || url.hostname.endsWith(`.${f}`)));
}

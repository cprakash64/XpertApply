/**
 * Which Chrome host grants XpertApply asks for on supported job-application sites, and how a granted
 * pattern is matched back to the page it was needed for.
 *
 * Why this exists (EXT-LIVE-01). Until 0.3.0 every ATS host was requested one exact hostname at a time:
 * job-boards.greenhouse.io, boards.greenhouse.io, jobs.lever.co, jobs.ashbyhq.com, each Workday tenant...
 * A person applying to five companies on three ATSs met Chrome's permission dialog (or its "wants access"
 * request) over and over. A supported ATS is now granted once, for its own registrable domain and its
 * subdomains, and only for the four ATSs the fill engine actually supports. Custom employer domains are
 * never widened: they stay exact-host, asked for only when the person starts there.
 *
 * Nothing here requests anything. It is pure so it can be unit tested; callers hold the user gesture.
 */
export interface SiteGroup {
  id: "greenhouse" | "lever" | "ashby" | "workday";
  label: string;
  /** Plain-language support level, shown next to the toggle. */
  support: "full" | "limited";
  /** Registrable domain suffix. */
  suffix: string;
  /** The single Chrome match pattern that is requested and registered for the group. */
  pattern: string;
}

export const SITE_GROUPS: readonly SiteGroup[] = [
  { id: "greenhouse", label: "Greenhouse", support: "full", suffix: "greenhouse.io", pattern: "https://*.greenhouse.io/*" },
  { id: "lever", label: "Lever", support: "full", suffix: "lever.co", pattern: "https://*.lever.co/*" },
  { id: "ashby", label: "Ashby", support: "full", suffix: "ashbyhq.com", pattern: "https://*.ashbyhq.com/*" },
  { id: "workday", label: "Workday", support: "limited", suffix: "myworkdayjobs.com", pattern: "https://*.myworkdayjobs.com/*" }
  // myworkdaysite.com is deliberately NOT a group: see docs/plans/ext-live-06-workday-fidelity.md (permission assessment).
];

/** Every pattern the first-run onboarding requests, in one dialog. */
export const ONBOARDING_PATTERNS: readonly string[] = SITE_GROUPS.map((group) => group.pattern);

const WILDCARD_ALLOWLIST = new Set(ONBOARDING_PATTERNS);

/** A wildcard host pattern XpertApply itself requests. Any other wildcard is never registered or trusted. */
export function isSupportedAtsWildcard(pattern: string): boolean {
  return WILDCARD_ALLOWLIST.has(pattern);
}

function hostOfPattern(pattern: string): string | null {
  const match = /^https:\/\/([a-z0-9*][a-z0-9.*-]*)\/\*$/.exec(pattern);
  return match ? match[1]! : null;
}

function hostIn(host: string, suffix: string): boolean {
  return host === suffix || host.endsWith(`.${suffix}`);
}

/** The supported-ATS group an exact-host pattern or URL host belongs to, if any. */
export function siteGroupForHost(host: string): SiteGroup | null {
  const lower = host.toLowerCase();
  return SITE_GROUPS.find((group) => hostIn(lower, group.suffix)) ?? null;
}

/**
 * The pattern to REQUEST for a needed exact-host pattern: the supported ATS's group pattern when the host
 * belongs to one, otherwise the exact pattern unchanged. A request for the group also satisfies the exact
 * host, so permissions.contains for the page keeps working unchanged.
 */
export function grantPatternFor(neededPattern: string): string {
  const host = hostOfPattern(neededPattern);
  if (!host || host.includes("*")) return neededPattern;
  return siteGroupForHost(host)?.pattern ?? neededPattern;
}

/** Does a granted (or removed) pattern cover the exact pattern a page needed? */
export function grantCovers(granted: string, needed: string): boolean {
  if (granted === needed) return true;
  const grantedHost = hostOfPattern(granted);
  const neededHost = hostOfPattern(needed);
  if (!grantedHost || !neededHost || !grantedHost.startsWith("*.")) return false;
  if (neededHost.startsWith("*.")) return neededHost === grantedHost;
  const suffix = grantedHost.slice(2);
  return neededHost === suffix || neededHost.endsWith(`.${suffix}`);
}

export function anyGrantCovers(granted: readonly string[], needed: string): boolean {
  return granted.some((pattern) => grantCovers(pattern, needed));
}

/** What the person sees for one group: granted by Chrome, or not. Revoked/declined are tracked separately. */
export type GroupAccess = "granted" | "not_granted";

export function groupAccess(granted: readonly string[], group: SiteGroup): GroupAccess {
  return granted.includes(group.pattern) ? "granted" : "not_granted";
}

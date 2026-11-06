/**
 * Persistent content-script registration for origins Chrome has actually granted.
 *
 * Why this exists. The employer content script is deliberately not declarative (installing grants
 * nothing about employer sites). Until now it reached a page only through the worker's
 * tabs.onUpdated handler for a tab already bound to a handoff, or a toolbar click. A page the
 * user opens directly therefore had no XpertApply script at all, and only the toolbar (activeTab)
 * could start one.
 *
 * Now the script is registered, with chrome.scripting.registerContentScripts, for each exact origin
 * the user granted, and for nothing else. Registration is derived from chrome.permissions, never
 * from our own records: a grant adds a script, a revocation removes it, and a restart or an
 * extension update reconciles it again. The script itself reads nothing: it announces itself and
 * the worker decides whether this tab has a workflow.
 */
import { isSupportedAtsWildcard, anyGrantCovers } from "./siteGrants";

export const SITE_SCRIPT_PREFIX = "xa-site-";

export interface SiteScript {
  id: string;
  matches: string[];
  js: string[];
  runAt: "document_idle";
  allFrames: false;
  persistAcrossSessions: true;
}

export interface RegistrationPlan {
  register: SiteScript[];
  unregister: string[];
}

export interface PlanOptions {
  /** Origins XpertApply's own website bridge already covers declaratively. */
  excluded: readonly string[];
  /** Plain-http loopback patterns, honoured only in non-production builds. */
  allowLoopback: boolean;
  /** Replace scripts that are already registered (an extension update may have changed content.js). */
  refresh: boolean;
}

const HTTPS_EXACT = /^https:\/\/([a-z0-9][a-z0-9.-]*)\/\*$/;
const LOOPBACK_EXACT = /^http:\/\/(localhost|127\.0\.0\.1)\/\*$/;

/**
 * A granted pattern that names exactly one host, or one of the four supported-ATS group wildcards that
 * XpertApply itself requests (see siteGrants.ts). Any other wildcard host and every non-web scheme is
 * never registered, whatever Chrome reports as granted.
 */
export function registrablePattern(pattern: string, allowLoopback: boolean): boolean {
  if (isSupportedAtsWildcard(pattern)) return true;
  if (HTTPS_EXACT.test(pattern)) return true;
  return allowLoopback && LOOPBACK_EXACT.test(pattern);
}

export function scriptIdFor(pattern: string): string {
  const host = pattern.replace(/^https?:\/\//, "").replace(/\/\*$/, "").replace(/^\*\./, "ats-");
  return `${SITE_SCRIPT_PREFIX}${host.replace(/[^a-z0-9.-]/g, "-")}`;
}

/** What to register and unregister so the registered scripts equal the granted, registrable origins. */
export function planRegistration(
  grantedOrigins: readonly string[],
  registeredIds: readonly string[],
  options: PlanOptions
): RegistrationPlan {
  const wanted = new Map<string, SiteScript>();
  for (const pattern of grantedOrigins) {
    if (options.excluded.includes(pattern)) continue;
    if (!registrablePattern(pattern, options.allowLoopback)) continue;
    // An exact host already covered by a granted group wildcard is served by the wildcard's script: two
    // scripts on one page would only race to claim the document.
    if (!isSupportedAtsWildcard(pattern) && anyGrantCovers(grantedOrigins.filter(isSupportedAtsWildcard), pattern)) continue;
    wanted.set(scriptIdFor(pattern), {
      id: scriptIdFor(pattern), matches: [pattern], js: ["content.js"],
      runAt: "document_idle", allFrames: false, persistAcrossSessions: true
    });
  }
  const ours = registeredIds.filter((id) => id.startsWith(SITE_SCRIPT_PREFIX));
  const unregister = ours.filter((id) => !wanted.has(id) || options.refresh);
  const register = [...wanted.values()].filter((script) => options.refresh || !ours.includes(script.id));
  return { register, unregister };
}

export interface RegistrarDeps {
  grantedOrigins(): Promise<string[]>;
  registeredIds(): Promise<string[]>;
  register(scripts: SiteScript[]): Promise<void>;
  unregister(ids: string[]): Promise<void>;
  options(): Promise<Omit<PlanOptions, "refresh">>;
}

/** Serialised, idempotent reconcile: concurrent triggers (startup, onAdded, onRemoved) queue instead of racing. */
export function createSiteRegistrar(deps: RegistrarDeps) {
  let chain: Promise<unknown> = Promise.resolve();
  return function reconcile(refresh = false): Promise<RegistrationPlan> {
    const run = chain.then(async () => {
      const plan = planRegistration(await deps.grantedOrigins(), await deps.registeredIds(), { ...(await deps.options()), refresh });
      if (plan.unregister.length) await deps.unregister(plan.unregister);
      if (plan.register.length) await deps.register(plan.register);
      return plan;
    });
    chain = run.catch(() => undefined);
    return run;
  };
}

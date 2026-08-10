/**
 * URL-first application navigation.
 *
 * A JavaScript-dispatched click carries `isTrusted: false`. Many production
 * sites gate navigation on a trusted event, so a synthetic pointer sequence can
 * be delivered perfectly and still do nothing — with no exception thrown. An
 * extension cannot manufacture trusted input (and faking it via chrome.debugger
 * is not acceptable for this flow), so synthetic activation can never be the
 * primary strategy.
 *
 * What IS reliable is the destination itself. When the CTA is an anchor, sits
 * inside one, carries a URL in a conventional data attribute, or submits a safe
 * GET form, we can read that URL and navigate through the service worker. No
 * trusted gesture required.
 *
 * Only when no destination can be safely extracted do we fall back to asking
 * the user for one real click.
 *
 * Everything here is validation-first: a destination is returned only if it
 * survives every rule in `validateDestination`.
 */

/** Where a destination came from. Reported for auditability. */
export type DestinationSource =
  | "anchor_href"
  | "ancestor_anchor"
  | "data_attribute"
  | "form_action";

export interface ApplyDestination {
  /** Absolute, validated https URL. */
  url: string;
  source: DestinationSource;
  /** The markup explicitly asks for a new tab (target="_blank"). */
  opensNewTab: boolean;
}

export type DestinationRejection =
  | "NO_URL"
  | "UNRESOLVABLE"
  | "UNSAFE_SCHEME"
  | "CREDENTIALS_IN_URL"
  | "HOST_NOT_ALLOWED"
  | "FORM_HAS_SENSITIVE_FIELDS"
  | "FORM_NOT_GET";

/**
 * ATS hosts an employer legitimately hands the application off to.
 *
 * Matched as a domain suffix, so `boards.greenhouse.io` and
 * `job-boards.greenhouse.io` both qualify while `greenhouse.io.evil.test` does
 * not (see `hostMatches`).
 */
const ALLOWED_ATS_HOSTS = [
  "greenhouse.io",
  "lever.co",
  "ashbyhq.com",
  "myworkdayjobs.com",
  "workday.com",
  "smartrecruiters.com",
  "icims.com",
  "jobvite.com",
  "taleo.net",
  "successfactors.com",
  "successfactors.eu",
  "avature.net",
  "eightfold.ai",
  "phenompeople.com",
  "oraclecloud.com",
  "workable.com",
  "breezy.hr",
  "recruitee.com",
  "teamtailor.com",
  "bamboohr.com",
  "paylocity.com",
  "dayforcehcm.com"
];

/** Conventional attributes that carry a navigation target in the public DOM. */
const URL_ATTRIBUTES = ["data-url", "data-href", "data-link", "data-target-url", "data-apply-url"];

/**
 * Field names that must never be replayed into a URL just to open a form.
 * A GET form carrying any of these is not a navigation aid, it is a submission.
 */
const SENSITIVE_FIELD_PATTERN =
  /pass|token|csrf|auth|session|secret|ssn|social|dob|birth|gender|race|ethnic|veteran|disab|salary|resume|cover|email|phone|name|address/i;

/** True when `host` is exactly `suffix` or a subdomain of it. */
function hostMatches(host: string, suffix: string): boolean {
  const h = host.toLowerCase();
  const s = suffix.toLowerCase();
  return h === s || h.endsWith(`.${s}`);
}

/**
 * Approximate registrable domain (eTLD+1).
 *
 * Deliberately simple: it exists to answer "is this the same employer?", and a
 * wrong answer only ever costs us the URL-first path and falls back to asking
 * the user — it can never authorise a navigation the allow-list would reject.
 */
function registrableDomain(host: string): string {
  const parts = host.toLowerCase().split(".").filter(Boolean);
  if (parts.length <= 2) return parts.join(".");
  // Handle the common two-part public suffixes (co.uk, com.au, co.jp …).
  const twoPartTlds = new Set(["co", "com", "net", "org", "gov", "edu", "ac"]);
  const last = parts[parts.length - 1];
  const secondLast = parts[parts.length - 2];
  if (last.length === 2 && twoPartTlds.has(secondLast)) {
    return parts.slice(-3).join(".");
  }
  return parts.slice(-2).join(".");
}

/**
 * Validate a candidate destination.
 *
 * Returns the absolute URL, or a machine-readable rejection reason. Nothing
 * here logs or returns the raw URL on failure — the caller reports the reason
 * code only.
 */
export function validateDestination(
  raw: string,
  pageUrl: string
): { ok: true; url: string } | { ok: false; reason: DestinationRejection } {
  const trimmed = (raw || "").trim();
  if (!trimmed || trimmed === "#") return { ok: false, reason: "NO_URL" };

  // A scheme check BEFORE resolution: `new URL("javascript:…", base)` keeps the
  // dangerous scheme, but rejecting up front makes the intent explicit.
  if (/^\s*(javascript|data|blob|file|about|chrome|chrome-extension):/i.test(trimmed)) {
    return { ok: false, reason: "UNSAFE_SCHEME" };
  }

  let resolved: URL;
  try {
    resolved = new URL(trimmed, pageUrl);
  } catch {
    return { ok: false, reason: "UNRESOLVABLE" };
  }

  const isLocalhost = ["localhost", "127.0.0.1"].includes(resolved.hostname);
  if (resolved.protocol !== "https:" && !(resolved.protocol === "http:" && isLocalhost)) {
    return { ok: false, reason: "UNSAFE_SCHEME" };
  }

  // Credentials in a URL are never something we navigate on the user's behalf.
  if (resolved.username || resolved.password) {
    return { ok: false, reason: "CREDENTIALS_IN_URL" };
  }

  let page: URL;
  try {
    page = new URL(pageUrl);
  } catch {
    return { ok: false, reason: "UNRESOLVABLE" };
  }

  const sameEmployer = registrableDomain(resolved.hostname) === registrableDomain(page.hostname);
  const knownAts = ALLOWED_ATS_HOSTS.some((suffix) => hostMatches(resolved.hostname, suffix));
  if (!sameEmployer && !knownAts && !isLocalhost) {
    return { ok: false, reason: "HOST_NOT_ALLOWED" };
  }

  return { ok: true, url: resolved.toString() };
}

/** The anchor that would actually navigate when this control is activated. */
function anchorFor(element: HTMLElement): HTMLAnchorElement | null {
  if (element instanceof HTMLAnchorElement && element.hasAttribute("href")) return element;
  const ancestor = element.closest("a[href]");
  return ancestor instanceof HTMLAnchorElement ? ancestor : null;
}

/**
 * A GET form whose fields are all inert (no credentials, no profile data) can
 * be represented as a URL. Anything else is a submission, not navigation.
 */
function destinationFromForm(
  element: HTMLElement,
  pageUrl: string
): { raw: string } | { reason: DestinationRejection } | null {
  const form = element.closest("form");
  if (!form) return null;
  const method = (form.getAttribute("method") || "get").toLowerCase();
  if (method !== "get") return { reason: "FORM_NOT_GET" };

  const params = new URLSearchParams();
  for (const field of Array.from(form.elements)) {
    const control = field as HTMLInputElement;
    const name = control.name;
    if (!name) continue;
    if (SENSITIVE_FIELD_PATTERN.test(name)) return { reason: "FORM_HAS_SENSITIVE_FIELDS" };
    const type = (control.type || "").toLowerCase();
    if (type === "password" || type === "file") return { reason: "FORM_HAS_SENSITIVE_FIELDS" };
    // Only replay values the page itself already put there.
    if (type === "checkbox" || type === "radio") {
      if (control.checked) params.set(name, control.value ?? "on");
      continue;
    }
    if (control.value) params.set(name, control.value);
  }

  const action = form.getAttribute("action") || pageUrl;
  const query = params.toString();
  return { raw: query ? `${action}${action.includes("?") ? "&" : "?"}${query}` : action };
}

/**
 * Resolve a safe, navigable destination for an already-validated Apply control.
 *
 * The control must ALREADY have passed `applicationSurface` selection — this
 * function never decides whether something is an apply CTA, only where it goes.
 */
export function resolveApplyDestination(
  element: HTMLElement,
  pageUrl: string
): { ok: true; destination: ApplyDestination } | { ok: false; reason: DestinationRejection } {
  const attempts: { raw: string; source: DestinationSource; opensNewTab: boolean }[] = [];

  const anchor = anchorFor(element);
  if (anchor) {
    attempts.push({
      raw: anchor.getAttribute("href") ?? "",
      source: anchor === element ? "anchor_href" : "ancestor_anchor",
      opensNewTab: (anchor.getAttribute("target") || "").toLowerCase() === "_blank"
    });
  }

  for (const attribute of URL_ATTRIBUTES) {
    const value = element.getAttribute(attribute);
    if (value) {
      attempts.push({
        raw: value,
        source: "data_attribute",
        opensNewTab: (element.getAttribute("target") || "").toLowerCase() === "_blank"
      });
    }
  }

  let formRejection: DestinationRejection | null = null;
  const formResult = destinationFromForm(element, pageUrl);
  if (formResult && "reason" in formResult) {
    formRejection = formResult.reason;
  } else if (formResult) {
    attempts.push({ raw: formResult.raw, source: "form_action", opensNewTab: false });
  }

  if (attempts.length === 0) {
    return { ok: false, reason: formRejection ?? "NO_URL" };
  }

  let lastReason: DestinationRejection = "NO_URL";
  for (const attempt of attempts) {
    const validated = validateDestination(attempt.raw, pageUrl);
    if (validated.ok) {
      return {
        ok: true,
        destination: { url: validated.url, source: attempt.source, opensNewTab: attempt.opensNewTab }
      };
    }
    lastReason = validated.reason;
  }
  return { ok: false, reason: lastReason };
}

/**
 * The ATS providers XpertApply knows about, and how much of each it can actually do.
 *
 * This is a maintained list, not a generic "looks like a form" guess: an activation or an
 * overlay is only ever offered for a host named here. `support` says what is really behind it:
 *
 *   adapter      a dedicated adapter exists (Greenhouse, Lever, Ashby)
 *   limited      detected and filled through the generic form engine only; multi-step or
 *                dynamic flows (Workday) and unreviewed layouts may need manual entry
 *   unsupported  recognised so we can say so honestly; there is no fill engine for it
 *
 * Detection from the URL needs no page access, so it is safe to use before Chrome has granted
 * the origin. `applicationPath` keeps marketing and listing pages from opening an assistant.
 */
export type ProviderSupport = "adapter" | "limited" | "unsupported";

export interface AtsProvider {
  id: string;
  displayName: string;
  /** Domain suffixes: "greenhouse.io" matches boards.greenhouse.io, never greenhouse.io.evil.test. */
  hosts: readonly string[];
  support: ProviderSupport;
  /** The application form is rendered inside an iframe of the employer's own page. */
  mayEmbed: boolean;
  /** Path (plus query) that identifies an APPLICATION page, as opposed to a listing or marketing page. */
  applicationPath: RegExp;
  /** The application is a multi-step single-page app: routes change without a document load. */
  singlePage: boolean;
}

export const PROVIDERS: readonly AtsProvider[] = [
  { id: "greenhouse", displayName: "Greenhouse", hosts: ["greenhouse.io"], support: "adapter", mayEmbed: true,
    applicationPath: /\/jobs\/\d+|[?&]gh_jid=\d+/i, singlePage: false },
  { id: "lever", displayName: "Lever", hosts: ["lever.co"], support: "adapter", mayEmbed: false,
    applicationPath: /\/apply\/?(?:[?#]|$)/i, singlePage: false },
  { id: "ashby", displayName: "Ashby", hosts: ["ashbyhq.com"], support: "adapter", mayEmbed: true,
    applicationPath: /\/application\/?(?:[?#]|$)|[?&]ashby_jid=/i, singlePage: true },
  { id: "workday", displayName: "Workday", hosts: ["myworkdayjobs.com", "workday.com"], support: "limited", mayEmbed: false,
    applicationPath: /\/(?:apply|applyManually|autofillWithResume)\b|\/job\/.+\/apply/i, singlePage: true },
  { id: "smartrecruiters", displayName: "SmartRecruiters", hosts: ["smartrecruiters.com"], support: "limited", mayEmbed: false,
    applicationPath: /\/(?:apply|oneclick-ui)\b/i, singlePage: true },
  { id: "rippling", displayName: "Rippling", hosts: ["rippling.com"], support: "limited", mayEmbed: false,
    applicationPath: /\/apply\b|\/jobs\/[0-9a-f-]{8,}/i, singlePage: true },
  { id: "bamboohr", displayName: "BambooHR", hosts: ["bamboohr.com"], support: "limited", mayEmbed: false,
    applicationPath: /\/careers\/\d+/i, singlePage: true },
  { id: "jazzhr", displayName: "JazzHR", hosts: ["applytojob.com", "jazz.co"], support: "limited", mayEmbed: false,
    applicationPath: /\/apply\b/i, singlePage: false },
  { id: "teamtailor", displayName: "Teamtailor", hosts: ["teamtailor.com"], support: "limited", mayEmbed: false,
    applicationPath: /\/jobs\/\d+/i, singlePage: false },
  // Recognised only to be honest about it: there is no Indeed fill engine.
  { id: "indeed", displayName: "Indeed", hosts: ["indeed.com"], support: "unsupported", mayEmbed: false,
    applicationPath: /./, singlePage: true }
];

function parse(url: string | null | undefined): URL | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" ? parsed : null;
  } catch {
    return null;
  }
}

function hostIn(hostname: string, suffix: string): boolean {
  return hostname === suffix || hostname.endsWith(`.${suffix}`);
}

/** The provider an https URL belongs to, from its hostname alone. */
export function providerForUrl(url: string | null | undefined): AtsProvider | null {
  const parsed = parse(url);
  if (!parsed) return null;
  const host = parsed.hostname.toLowerCase();
  return PROVIDERS.find((provider) => provider.hosts.some((suffix) => hostIn(host, suffix))) ?? null;
}

/**
 * A supported provider's APPLICATION page. A listing, a company home page or a marketing page on
 * the same ATS host returns null, so nothing is opened over it.
 */
export function applicationProviderForUrl(url: string | null | undefined): AtsProvider | null {
  const provider = providerForUrl(url);
  const parsed = parse(url);
  if (!provider || !parsed || provider.support === "unsupported") return null;
  return provider.applicationPath.test(`${parsed.pathname}${parsed.search}`) ? provider : null;
}

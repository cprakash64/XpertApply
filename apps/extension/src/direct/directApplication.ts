/**
 * Independent (direct) applications.
 *
 * An application the user opens straight on an employer site has no website
 * launch behind it. These rules decide, without any page-supplied identity,
 * whether such a page may get its own XpertApply draft and how long that draft
 * stays attached to the tab.
 *
 * Nothing here trusts the page: the URL and frame come from Chrome's sender, the
 * evidence is a count/label probe taken after the user's own grant, and the
 * resulting binding is tab-bound and owner-bound.
 */

import type { PendingLaunch } from "../messages";
import { urlsMatchForHandoff } from "../url";

/** The sanitized evidence one frame reports about itself (see frames/probe.ts). */
export interface ApplicationProbeEvidence {
  rootConfident: boolean;
  applicationLabelsFound: readonly string[];
}

export type EligibilityVerdict = { eligible: true } | { eligible: false; reason: string };

const IDENTITY_LABELS = ["first_name", "last_name", "email", "phone"] as const;
const APPLICATION_ONLY_LABELS = ["resume", "cover_letter", "submit_application", "work_authorization", "sponsorship", "linkedin"] as const;

/**
 * Is this a real job application form, as opposed to a newsletter signup, login,
 * search box, account-settings page or a job description?
 *
 * A confident application root is necessary, because a description page can
 * mention "resume" and "email" in prose without owning a form. On top of that the
 * form must ask who the applicant is (at least two identity fields) AND carry
 * something only an application asks for (a résumé or cover letter, work
 * authorization, sponsorship, a LinkedIn profile or a submit-application control).
 * A newsletter has an e-mail and nothing else; a login has an e-mail and a
 * password; neither can pass.
 */
export function judgeApplicationEvidence(evidence: ApplicationProbeEvidence | null | undefined): EligibilityVerdict {
  if (!evidence) return { eligible: false, reason: "NO_EVIDENCE" };
  if (!evidence.rootConfident) return { eligible: false, reason: "NO_APPLICATION_ROOT" };
  const labels = new Set(evidence.applicationLabelsFound);
  const identity = IDENTITY_LABELS.filter((label) => labels.has(label)).length;
  if (identity < 2) return { eligible: false, reason: "TOO_FEW_IDENTITY_FIELDS" };
  if (!APPLICATION_ONLY_LABELS.some((label) => labels.has(label))) {
    return { eligible: false, reason: "NO_APPLICATION_ONLY_FIELDS" };
  }
  return { eligible: true };
}

/** Origin + path only: a query string can carry a tracking id, a token or an e-mail. */
export function canonicalDirectUrl(url: URL): string {
  const path = url.pathname.replace(/\/+$/, "") || "/";
  return `${url.origin}${path}`;
}

/**
 * Does the top frame's current URL still belong to this direct draft?
 *
 * Same origin is required, and the path must still be the same posting (or its
 * `/apply` continuation), by the same rule website launches use. A different job
 * on the same employer does NOT match: it gets its own draft rather than silently
 * inheriting this one. Query and fragment changes — SPA steps, tracking
 * parameters, redirects that only decorate the URL — never matter.
 */
export function directDraftStillMatches(pending: PendingLaunch, url: URL): boolean {
  if (pending.source !== "direct") return false;
  if (url.origin !== pending.expectedOrigin) return false;
  return urlsMatchForHandoff(pending.applicationUrl, url.href);
}

export function buildDirectPending(input: {
  tabId: number;
  sessionId: number;
  userId: number;
  url: URL;
  atsType: string | null;
  now: number;
  ttlMs: number;
  requestId: string;
  protocolVersion: number;
}): PendingLaunch {
  const canonical = canonicalDirectUrl(input.url);
  return {
    version: 1,
    applicationId: `direct-${input.sessionId}`,
    jobId: `direct-${input.sessionId}`,
    applicationUrl: canonical,
    officialUrl: canonical,
    expectedOrigin: input.url.origin,
    status: "detecting",
    handoffToken: "",
    requestId: input.requestId,
    sessionId: input.sessionId,
    launchToken: "",
    createdAt: input.now,
    expiresAt: input.now + input.ttlMs,
    targetTabId: input.tabId,
    state: "detecting_ats",
    protocolVersion: input.protocolVersion,
    atsType: input.atsType,
    // The user opted in by connecting and enabling automatic fill; the same
    // in-page assistant a website launch opens may therefore open here.
    userStarted: true,
    source: "direct",
    directUserId: input.userId
  };
}

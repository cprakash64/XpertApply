/**
 * The trust boundary between the service worker and everything that can send it
 * a message.
 *
 * The live failure this exists to fix
 * ----------------------------------
 * Binding is per TAB. Once any frame in a tab matched an active handoff, the
 * worker treated the whole tab as trusted and handed the FULL session package —
 * the user's verified profile answers, and by extension the tailored résumé the
 * frame then fetches — to any frame in it that asked. A third-party iframe on an
 * employer page (an ad slot, an analytics or chat vendor, a CDN-hosted widget)
 * therefore received the candidate's name, e-mail, phone, links and résumé file
 * with no user interaction and no visible indication: the review widget renders
 * only in the top frame and reports only its own counts.
 *
 * Two separate defects produced that:
 *
 *   1. `validateLaunch` applied its URL check only when the caller said it was
 *      the top frame, so every sub-frame skipped validation entirely.
 *   2. Both the URL and the "am I the top frame?" claim were read out of the
 *      MESSAGE BODY. A message field is data, not identity — it can only ever
 *      describe what the sender says about itself.
 *
 * What this module guarantees
 * ---------------------------
 * Authorization is derived exclusively from `chrome.runtime.MessageSender`,
 * which Chrome populates and neither page script nor content script can forge.
 * Every decision is deny-by-default and returns a named reason, so a refusal is
 * diagnosable instead of appearing as a silent no-op.
 *
 * Tab binding and frame authorization are deliberately SEPARATE questions:
 *
 *   • Binding a tab asks "does this tab hold the application we launched?" and
 *     may legitimately be answered by the tab's own URL, so a nested frame that
 *     reports in first can still bind the tab it lives in.
 *   • Authorizing a frame asks "may THIS document receive the user's data?" and
 *     is answered only by that frame's own origin.
 *
 * Conflating the two is what let a bound tab vouch for frames inside it.
 */

import { urlsMatchForHandoff } from "../url";
import type { PendingLaunch } from "../messages";

/**
 * ATS hosts an employer's application may legitimately be embedded from.
 *
 * Matching is on the registrable domain or a DOT-ANCHORED suffix, never a
 * substring: `greenhouse.io.evil.test` and `notgreenhouse.io` both fail.
 */
const ATS_HOSTS = [
  "greenhouse.io", "lever.co", "ashbyhq.com", "myworkdayjobs.com", "workday.com",
  "smartrecruiters.com", "icims.com", "jobvite.com", "taleo.net", "successfactors.com",
  "avature.net", "eightfold.ai", "phenompeople.com", "oraclecloud.com", "workable.com"
] as const;

/** Public-suffix second labels that make the registrable domain three parts. */
const TWO_PART_SUFFIXES = new Set(["co", "com", "net", "org", "gov", "edu", "ac"]);

/** Approximate registrable domain. Deliberately conservative: when in doubt it
 * returns a LONGER (narrower) name, which can only ever deny, never widen. */
export function registrableDomain(host: string): string {
  const parts = host.toLowerCase().split(".").filter(Boolean);
  if (parts.length <= 2) return parts.join(".");
  const last = parts[parts.length - 1];
  if (last.length === 2 && TWO_PART_SUFFIXES.has(parts[parts.length - 2])) {
    return parts.slice(-3).join(".");
  }
  return parts.slice(-2).join(".");
}

/**
 * May a document on `candidate` take part in the workflow that started at
 * `workflowUrl`?
 *
 * Same registrable domain (careers → login on the same employer), or an
 * allow-listed ATS host. Nothing else. Previously private to background.ts;
 * exported here so the frame gate, the reconnect gate and the host-permission
 * gate all decide with ONE predicate rather than three similar ones.
 */
export function originJoinsWorkflow(workflowUrl: string, candidate: URL): boolean {
  let workflow: URL;
  try {
    workflow = new URL(workflowUrl);
  } catch {
    return false;
  }
  if (registrableDomain(workflow.hostname) === registrableDomain(candidate.hostname)) return true;
  const host = candidate.hostname.toLowerCase();
  return ATS_HOSTS.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

// --------------------------------------------------------------------------- //
// Sender description — browser-supplied facts only
// --------------------------------------------------------------------------- //

/**
 * What Chrome — not the message — says about who sent this.
 *
 * Every field here comes from `MessageSender`. Nothing in it can be set by the
 * sending script, which is the entire point: this is the only input the
 * authorization rules below are allowed to read.
 */
export interface SenderContext {
  tabId: number;
  /** 0 is always the tab's top-level document; Chrome assigns the rest. */
  frameId: number;
  isTopFrame: boolean;
  /** The sending document's own URL, when it has a usable http(s) one. */
  frameUrl: URL | null;
  /** The sending document's origin. Survives `about:srcdoc`/`about:blank`
   * frames, which inherit their initiator's origin, where `frameUrl` does not. */
  frameOrigin: URL | null;
  /** The URL of the TAB (its top-level document), as Chrome reports it. */
  tabUrl: string | null;
}

function parseHttpUrl(value: string | undefined | null): URL | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url : null;
  } catch {
    return null;
  }
}

/**
 * Extract the browser-supplied identity of a message sender.
 *
 * Returns null when the message did not come from a tab — an extension page
 * (side panel, options) has no `sender.tab`. Those callers are a different
 * trust class and are handled by their own code paths, not by this gate.
 */
export function describeSender(sender: chrome.runtime.MessageSender): SenderContext | null {
  const tabId = sender.tab?.id;
  if (typeof tabId !== "number") return null;
  // `frameId` is documented as present for content-script senders. Treat a
  // missing one as "not the top frame": the stricter of the two readings, so a
  // browser that omits it cannot be used to claim top-frame authority.
  const frameId = typeof sender.frameId === "number" ? sender.frameId : -1;
  const frameUrl = parseHttpUrl(sender.url);
  return {
    tabId,
    frameId,
    isTopFrame: frameId === 0,
    frameUrl,
    frameOrigin: frameUrl ?? parseHttpUrl(sender.origin),
    tabUrl: sender.tab?.url ?? null
  };
}

// --------------------------------------------------------------------------- //
// Frame authorization
// --------------------------------------------------------------------------- //

/** Why a frame was refused. Safe to log and to surface as a diagnostic code:
 * these are structural states, never page content and never user data. */
export type FrameDenialReason =
  | "NO_SENDER_TAB"
  | "FRAME_ORIGIN_UNRESOLVABLE"
  | "HANDOFF_URL_MISMATCH"
  | "FRAME_ORIGIN_NOT_IN_WORKFLOW"
  | "TAB_LEFT_WORKFLOW";

export type FrameAuthorization =
  | { ok: true; isTopFrame: boolean }
  | { ok: false; reason: FrameDenialReason };

/** The two URLs a frame may legitimately relate itself to: where the launch was
 * prepared for, and where the workflow has since navigated. */
function workflowUrls(launch: PendingLaunch): string[] {
  return [launch.officialUrl, launch.applicationUrl].filter(
    (value): value is string => typeof value === "string" && value.length > 0
  );
}

function joinsWorkflow(launch: PendingLaunch, candidate: URL): boolean {
  return workflowUrls(launch).some((url) => originJoinsWorkflow(url, candidate));
}

/**
 * May this exact document receive the session package for this launch?
 *
 * Deny by default. Exactly two shapes are authorized:
 *
 *   TOP FRAME     its own URL must still match the handoff. Unchanged from the
 *                 previous behaviour, and the reason a tab that navigates away
 *                 stops filling.
 *
 *   NESTED FRAME  its own origin must join the workflow — the same registrable
 *                 domain as the application, or an allow-listed ATS host — AND
 *                 the tab it lives in must itself still be on the workflow. The
 *                 second condition is what stops a page that has navigated
 *                 somewhere unrelated from re-qualifying its children by
 *                 embedding an ATS-shaped frame.
 *
 * A third-party frame — an ad, analytics, chat or CDN widget — satisfies
 * neither and is refused, whatever its document happens to contain.
 */
export function authorizeFrameForLaunch(
  sender: SenderContext | null,
  launch: PendingLaunch
): FrameAuthorization {
  if (!sender) return { ok: false, reason: "NO_SENDER_TAB" };

  if (sender.isTopFrame) {
    if (!sender.frameUrl) return { ok: false, reason: "FRAME_ORIGIN_UNRESOLVABLE" };
    return urlsMatchForHandoff(launch.applicationUrl, sender.frameUrl.href)
      ? { ok: true, isTopFrame: true }
      : { ok: false, reason: "HANDOFF_URL_MISMATCH" };
  }

  // Nested frame. An opaque origin (sandboxed frame, data: URL) resolves to
  // nothing here and is refused rather than guessed at.
  if (!sender.frameOrigin) return { ok: false, reason: "FRAME_ORIGIN_UNRESOLVABLE" };
  if (!joinsWorkflow(launch, sender.frameOrigin)) {
    return { ok: false, reason: "FRAME_ORIGIN_NOT_IN_WORKFLOW" };
  }

  const tabUrl = parseHttpUrl(sender.tabUrl);
  // No readable tab URL is not evidence the tab is still on the workflow.
  if (!tabUrl) return { ok: false, reason: "TAB_LEFT_WORKFLOW" };
  const tabStillOnWorkflow =
    urlsMatchForHandoff(launch.applicationUrl, tabUrl.href) || joinsWorkflow(launch, tabUrl);
  if (!tabStillOnWorkflow) return { ok: false, reason: "TAB_LEFT_WORKFLOW" };

  return { ok: true, isTopFrame: false };
}

/**
 * May this sender BIND the tab it is in to an active handoff?
 *
 * A weaker, separate question from `authorizeFrameForLaunch`: binding asks
 * whether the TAB is the one the launch was prepared for, so the tab's own
 * top-level URL is legitimate evidence even when a nested frame is the one
 * reporting in. Binding alone never authorizes a frame to receive anything —
 * the caller must still pass `authorizeFrameForLaunch` afterwards.
 */
/**
 * May a document on `candidate` take part in this launch's workflow at all?
 *
 * The origin half of `authorizeFrameForLaunch`, exposed on its own so the
 * worker can evaluate a frame it knows only from its probe record — without
 * fabricating a MessageSender to ask the question.
 */
export function originJoinsLaunchWorkflow(launch: PendingLaunch, candidate: URL): boolean {
  return joinsWorkflow(launch, candidate);
}

export function senderCanBindTab(sender: SenderContext | null, launch: PendingLaunch): boolean {
  if (!sender) return false;
  const candidates = [sender.frameUrl?.href, sender.tabUrl].filter(
    (value): value is string => typeof value === "string" && value.length > 0
  );
  return candidates.some((url) => urlsMatchForHandoff(launch.applicationUrl, url));
}

/**
 * Which frames exist, which of them belong to this application, and which of
 * those Chrome will not let us near yet.
 *
 * The finding this exists to fix (XA-06, Stage 3C-2)
 * -------------------------------------------------
 * Stage 3C made employer/ATS host access optional, so an embedded ATS frame
 * starts out with no grant and no content script. Discovering that it needs one
 * was left to the worker's frame enumeration — and that enumeration is built
 * from `scripting.executeScript({ allFrames: true })`, which reports one result
 * per INJECTABLE frame. The ungranted ATS frame is by definition not injectable,
 * so Chrome omitted it, the worker saw only the employer's top frame, and the
 * "this frame needs permission" verdict became unreachable. The optional
 * `webNavigation` path that would have seen it is never requested.
 *
 * The circularity: the one API that could report the frame requiring permission
 * was itself gated on already having that permission.
 *
 * The top document can see it. `iframe[src]` is a property of the PARENT's own
 * markup and stays readable across origins, so the employer page's own content
 * script — which we do hold a grant for — can name the ATS origin without ever
 * touching the ATS frame. That observation is the missing input, and this module
 * merges it with Chrome's enumeration instead of letting either one win outright.
 *
 * Visibility is not trust
 * -----------------------
 * An employer page also embeds ad slots, consent managers, analytics and chat
 * widgets, and every one of them is equally observable. So an observed origin is
 * only ever a HINT about where the application might be; authority to act on it
 * comes from `originJoinsWorkflow` — the same predicate the frame gate and the
 * host-permission gate already use — applied BEFORE ranking, so an unrelated
 * frame cannot win a tie, create false ambiguity, or be named to the user as
 * the site that needs access.
 *
 * Five states stay distinguishable here, because collapsing any two of them is
 * how authority leaks:
 *
 *     OBSERVED          the top document saw an iframe pointing there
 *     TRUSTED           its origin belongs to the active workflow
 *     GRANTED           Chrome holds a host permission for it
 *     CONFIRMED/ACTIVE  Chrome reports the frame and a content script answers
 *     FILL AUTHORIZED   Stage 3B lease — decided elsewhere, never here
 *
 * Nothing in this module is sender identity. A `FrameDiscoveryRecord` sourced
 * from observation carries `frameId: null` and `contentScriptResponds: false`
 * and can never stand in for `chrome.runtime.MessageSender`. Once the grant
 * exists and a content script reports in, Stage 3A decides who it is.
 */

import { originPatternFor } from "../security/siteAccess";
import type { FrameOutcome } from "./frameInventory";

/** Where a record's identity came from. Never inferred, never upgraded. */
export type FrameEvidenceSource =
  /** Chrome enumerated this frame and gave it a real frame id. */
  | "chrome_confirmed"
  /** The top document saw the iframe; Chrome cannot report it yet. */
  | "observed_ungranted";

/**
 * One frame, with its provenance attached.
 *
 * `frameId` is `null` for an observed-only record and is NEVER fabricated: a
 * made-up id would be accepted by `tabs.sendMessage` targeting and would let
 * discovery evidence masquerade as a real frame.
 */
export interface FrameDiscoveryRecord {
  source: FrameEvidenceSource;
  /** Chrome's frame id, or null when the frame is known only from the DOM. */
  frameId: number | null;
  parentFrameId: number | null;
  /** Canonical scheme+host. Portless, matching Chrome match-pattern semantics. */
  origin: string | null;
  /** Redacted path shape. Diagnostic only — never a locator, never a query. */
  pathShape: string | null;
  urlKind: string;
  /** Chrome-confirmed only. An observed record is never "active". */
  contentScriptResponds: boolean;
  hostPermissionGranted: boolean;
  applicationEvidence: boolean;
  fieldCount: number;
  sandboxTokens: string[];
  opaqueOrigin: boolean;
  /** Does this origin belong to the ACTIVE workflow? Decided by
   * `originJoinsWorkflow`, never by how application-shaped the frame looks. */
  workflowTrusted: boolean;
}

/**
 * The canonical origin a permission decision may be made about.
 *
 * Routed through `originPatternFor` so there is exactly ONE URL-security
 * implementation in the extension: it rejects `javascript:`, `data:`, `blob:`,
 * `file:`, `chrome:`, `chrome-extension:`, `about:`, non-loopback `http`, URLs
 * carrying credentials, hostnames containing `*`, and anything unparseable —
 * then drops the port, because a Chrome match pattern has no port and the host
 * is the unit of authority.
 *
 * Returns null for everything it will not vouch for. `iframe[src]` is
 * page-controlled data, so this runs on BOTH sides: the content script resolves
 * relative URLs against its own document, and the worker re-validates whatever
 * string actually arrived rather than trusting the sender's parsing.
 */
export function canonicalFrameOrigin(raw: string | null | undefined): string | null {
  const pattern = originPatternFor(raw);
  // `originPatternFor` yields `<scheme>//<host>/*`; the origin is that without
  // the trailing match-all path.
  return pattern ? pattern.slice(0, -2) : null;
}

/** The Chrome match pattern for a canonical origin. */
export function patternForOrigin(origin: string | null): string | null {
  return origin ? `${origin}/*` : null;
}

/**
 * Combine Chrome's enumeration with the top document's observation.
 *
 * MERGE, not override. Chrome-confirmed identity always wins for a frame both
 * sources can see — it carries a real frame id, a ping result and a probe — but
 * an observed origin Chrome cannot report is RETAINED rather than discarded,
 * because that is precisely the frame whose permission is missing.
 *
 * Deduplicated by canonical origin: several iframes pointing at one ATS origin
 * are one permission question, not several.
 */
export function mergeFrameInventories(
  confirmed: FrameDiscoveryRecord[],
  observed: FrameDiscoveryRecord[]
): FrameDiscoveryRecord[] {
  const seen = new Set(confirmed.map((frame) => frame.origin).filter(Boolean) as string[]);
  const merged = [...confirmed];
  for (const frame of observed) {
    if (!frame.origin || seen.has(frame.origin)) continue;
    seen.add(frame.origin);
    merged.push(frame);
  }
  return merged;
}

/**
 * How actionable a candidate is. Only ever applied to ALREADY-TRUSTED records.
 *
 * Chrome-confirmed evidence outranks observation of the same shape, so a frame
 * we can actually talk to is preferred over one we have only seen — but an
 * observed frame with no grant still scores, because "ask for this origin" is a
 * real remedy and "we cannot see it" is not.
 */
function candidateScore(frame: FrameDiscoveryRecord): number {
  return (frame.applicationEvidence ? 100 : 0)
    + Math.min(frame.fieldCount, 50)
    + (frame.source === "chrome_confirmed" ? 20 : 0)
    + (frame.urlKind === "https" ? 10 : 0)
    - (frame.opaqueOrigin ? 50 : 0);
}

/**
 * The one frame worth acting on, or nothing.
 *
 * Untrusted origins are removed BEFORE ranking, not filtered out of the winner
 * afterwards. That ordering is the whole point: an ad iframe that scores as
 * application-shaped must not be able to tie with the real ATS frame, and must
 * not be able to create ambiguity that denies service to it either. Stage 3C
 * hit that class of bug once already.
 *
 * Fails closed on genuine ambiguity — two DIFFERENT trusted origins the
 * evidence cannot separate. Asking the user to grant both would hand out more
 * authority than the workflow has established a need for, so we ask for
 * neither. Several frames on ONE origin are not ambiguous: they are a single
 * permission question, and `mergeFrameInventories` has already collapsed them.
 */
export function selectTrustedApplicationCandidate(
  frames: FrameDiscoveryRecord[]
): FrameDiscoveryRecord | null {
  const eligible = frames.filter((frame) =>
    frame.workflowTrusted && frame.origin !== null && frame.frameId !== 0);
  if (eligible.length === 0) return null;

  const ranked = [...eligible].sort((a, b) => {
    const delta = candidateScore(b) - candidateScore(a);
    if (delta !== 0) return delta;
    // Deterministic, and deliberately NOT DOM order: positional order is
    // page-controlled, so letting it decide would hand the choice to the page.
    return (a.origin ?? "").localeCompare(b.origin ?? "");
  });

  const best = ranked[0];
  const runnerUp = ranked[1];
  if (runnerUp
    && runnerUp.origin !== best.origin
    && candidateScore(runnerUp) === candidateScore(best)) {
    return null;
  }
  return best;
}

/**
 * Name the ONE cause, so the user gets one remedy.
 *
 * Order matters. An opaque sandbox is checked first because no grant and no
 * injection can ever reach it. A missing grant is checked before a missing
 * content script because the grant is the CAUSE of the missing script — which
 * is exactly the inversion Stage 3C-V found: an ungranted frame was being
 * reported as unreachable, a verdict whose only remedy is "reopen it as a tab",
 * instead of as unpermitted, whose remedy is the one grant the user can give.
 */
export function frameDiscoveryOutcome(candidate: FrameDiscoveryRecord | null): FrameOutcome {
  if (!candidate) return "APPLICATION_FRAME_CONTENT_SCRIPT_UNAVAILABLE";
  if (candidate.opaqueOrigin) return "APPLICATION_FRAME_SANDBOXED_OPAQUE";
  if (!candidate.hostPermissionGranted) return "APPLICATION_FRAME_PERMISSION_MISSING";
  if (!candidate.contentScriptResponds) return "APPLICATION_FRAME_CONTENT_SCRIPT_UNAVAILABLE";
  if (candidate.fieldCount > 0) return "APPLICATION_FRAME_DISCOVERY_COMPLETED";
  if (candidate.applicationEvidence) return "APPLICATION_FRAME_FOUND";
  return "APPLICATION_FRAME_DISCOVERY_ZERO_FIELDS";
}

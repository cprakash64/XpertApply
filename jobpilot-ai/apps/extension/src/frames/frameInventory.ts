/**
 * What is actually in this tab's frames, and why can't we reach the application?
 *
 * The live failure this exists to fix: the destination application renders
 * inside an iframe, and JobPilot showed
 *
 *     "The application is inside a frame JobPilot isn't allowed to read."
 *
 * That message was produced by ONE piece of evidence — `iframe.contentDocument`
 * threw — which proves only that the frame is cross-origin. It does not
 * establish whether a content script is running there, whether the extension
 * holds a host permission for it, whether the frame is sandboxed to an opaque
 * origin, or whether the frame even has a real URL. Those are four different
 * problems with four different fixes, and collapsing them into one sentence
 * left the user with no action and us with no diagnosis.
 *
 * This module is the parent document's side of the answer: everything a parent
 * can legitimately observe about a child frame WITHOUT reading into it. The
 * `src` attribute and the `sandbox` token list are properties of the parent's
 * own DOM, so they remain readable across origins — and they are exactly what
 * we need to decide between "inject there", "ask for permission", and "reopen
 * this frame as a normal tab".
 *
 * Nothing here reads into a frame, and nothing here records a query string.
 */

/** Stable outcomes. Each names ONE cause with ONE remedy. */
export type FrameOutcome =
  | "APPLICATION_FRAME_FOUND"
  | "APPLICATION_FRAME_PERMISSION_MISSING"
  | "APPLICATION_FRAME_CONTENT_SCRIPT_UNAVAILABLE"
  | "APPLICATION_FRAME_SANDBOXED_OPAQUE"
  | "APPLICATION_FRAME_DISCOVERY_STARTED"
  | "APPLICATION_FRAME_DISCOVERY_COMPLETED"
  | "APPLICATION_FRAME_DISCOVERY_ZERO_FIELDS";

/**
 * How a frame's URL is shaped.
 *
 * This matters more than it looks. A content script declared for an https match
 * pattern is NOT injected into `about:blank`, `about:srcdoc`, `blob:` or
 * `data:` frames unless the registration opts in via `match_origin_as_fallback`.
 * An ATS that mounts its application into a scripted blank frame therefore gets
 * no content script at all — and from the parent it looks identical to a
 * cross-origin frame we lack permission for.
 */
export type FrameUrlKind =
  | "https"
  | "http_local"
  | "about_blank"
  | "about_srcdoc"
  | "blob"
  | "data"
  | "empty"
  | "other";

export interface ObservedFrame {
  /** Index among this document's iframes. Positional only, never an identity. */
  frameIndex: number;
  /** Origin only. Never a path, never a query string. */
  origin: string | null;
  /** Path with identifiers replaced. Diagnostic shape, not a locator. */
  pathShape: string | null;
  urlKind: FrameUrlKind;
  /** The `src` attribute as the PARENT sees it — readable cross-origin. */
  srcObservable: boolean;
  /** Sandbox tokens, when the parent set them. An empty array with
   * `sandboxed: true` is the most restrictive (fully opaque) case. */
  sandboxTokens: string[];
  sandboxed: boolean;
  /** A sandbox without `allow-same-origin` yields an opaque origin: no host
   * permission can ever match it, and no content script can talk to us. */
  opaqueOrigin: boolean;
  /** Could this frame's document be read from here? */
  sameOriginReadable: boolean;
  /** Applicant-shaped controls, when readable. Zero when not. */
  readableFieldCount: number;
}

const REDACTED_SEGMENT = "<id>";

/** Path with locale prefixes and identifiers replaced. */
export function redactPathShape(rawUrl: string, base?: string): string | null {
  try {
    const segments = new URL(rawUrl, base).pathname.split("/").filter(Boolean).map((segment) => {
      if (/^[a-z]{2}([-_][a-z]{2,4})?$/i.test(segment)) return "<locale>";
      if (/^\d+$/.test(segment)) return REDACTED_SEGMENT;
      if (/\d/.test(segment) && segment.length >= 8) return REDACTED_SEGMENT;
      return segment.toLowerCase().slice(0, 32);
    });
    return `/${segments.join("/")}`;
  } catch {
    return null;
  }
}

/**
 * Classify a frame's `src`.
 *
 * `base` matters: an ATS that embeds its application with a RELATIVE src
 * (`src="/apply/embed"`) was classified as "other", which erased its origin and
 * made a perfectly reopenable frame look like it had no address at all.
 */
export function classifyFrameUrl(raw: string | null, base?: string): FrameUrlKind {
  if (!raw || raw.trim() === "") return "empty";
  const value = raw.trim().toLowerCase();
  if (value === "about:blank") return "about_blank";
  if (value === "about:srcdoc") return "about_srcdoc";
  if (value.startsWith("blob:")) return "blob";
  if (value.startsWith("data:")) return "data";
  if (value.startsWith("https:")) return "https";
  if (value.startsWith("http://localhost") || value.startsWith("http://127.0.0.1")) return "http_local";
  if (value.startsWith("http:")) return "other";
  // A scheme-relative or path-relative src resolves against the document.
  if (base) {
    try {
      const resolved = new URL(raw, base);
      if (resolved.protocol === "https:") return "https";
      if (resolved.protocol === "http:") {
        return ["localhost", "127.0.0.1"].includes(resolved.hostname) ? "http_local" : "other";
      }
    } catch {
      /* unparseable: fall through to "other" */
    }
  }
  return "other";
}

/**
 * Does this frame carry a sandbox that produces an opaque origin?
 *
 * `sandbox` without `allow-same-origin` puts the frame in an origin that
 * matches no host permission and shares nothing with anyone. No amount of
 * permission-granting reaches it, so the honest remedy is to open the frame's
 * URL as a normal tab instead of pretending a request would help.
 */
function sandboxState(frame: HTMLIFrameElement): {
  tokens: string[];
  sandboxed: boolean;
  opaqueOrigin: boolean;
} {
  if (!frame.hasAttribute("sandbox")) return { tokens: [], sandboxed: false, opaqueOrigin: false };
  const tokens = (frame.getAttribute("sandbox") ?? "")
    .split(/\s+/)
    .map((token) => token.trim().toLowerCase())
    .filter(Boolean);
  return {
    tokens,
    sandboxed: true,
    opaqueOrigin: !tokens.includes("allow-same-origin")
  };
}

function applicantControlCount(doc: Document): number {
  return doc.querySelectorAll(
    'input:not([type=hidden]):not([type=submit]):not([type=button]),textarea,select,[contenteditable=true],[role=combobox]'
  ).length;
}

/**
 * Observe every iframe in this document.
 *
 * Deliberately parent-side only: no message passing, no permissions, no async.
 * The background pairs this with real frame ids, ping results and permission
 * state to produce the full picture.
 */
export function observeFrames(doc: Document = document): ObservedFrame[] {
  return Array.from(doc.querySelectorAll("iframe")).map((frame, frameIndex) => {
    // JobPilot's own UI never contains an employer application.
    const raw = frame.getAttribute("src");
    const urlKind = classifyFrameUrl(raw, doc.location?.href);
    const sandbox = sandboxState(frame);

    let origin: string | null = null;
    let pathShape: string | null = null;
    if (urlKind === "https" || urlKind === "http_local") {
      try {
        origin = new URL(raw!, doc.location?.href).origin;
        pathShape = redactPathShape(raw!, doc.location?.href);
      } catch {
        origin = null;
      }
    }

    let sameOriginReadable = false;
    let readableFieldCount = 0;
    try {
      const inner = frame.contentDocument;
      if (inner) {
        sameOriginReadable = true;
        readableFieldCount = applicantControlCount(inner);
      }
    } catch {
      // Cross-origin. Expected, and not an error.
    }

    return {
      frameIndex,
      origin,
      pathShape,
      urlKind,
      srcObservable: Boolean(raw),
      sandboxTokens: sandbox.tokens,
      sandboxed: sandbox.sandboxed,
      opaqueOrigin: sandbox.opaqueOrigin,
      sameOriginReadable,
      readableFieldCount
    };
  });
}

/**
 * Which observed frame is most likely to hold the application?
 *
 * Ranked by how actionable the frame is, not merely by how application-shaped
 * it looks: a readable frame with controls beats an https frame we could ask
 * permission for, which beats a blank/opaque frame we can only reopen.
 */
export function selectApplicationFrame(frames: ObservedFrame[]): ObservedFrame | null {
  const scored = frames
    .map((frame) => {
      let score = 0;
      if (frame.readableFieldCount > 0) score += 100 + frame.readableFieldCount;
      if (frame.urlKind === "https") score += 40;
      if (frame.urlKind === "http_local") score += 20;
      if (!frame.sandboxed) score += 10;
      if (frame.opaqueOrigin) score -= 30;
      // A frame with no src at all is script-populated; it is a real candidate
      // but the weakest one, because there is no URL to reopen.
      if (frame.urlKind === "empty" || frame.urlKind === "about_blank") score += 5;
      return { frame, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score);
  return scored[0]?.frame ?? null;
}

export interface FrameVerdictInput {
  frame: ObservedFrame | null;
  /** Did a content script in that frame answer a ping? */
  contentScriptResponds: boolean;
  /** Does the extension hold a host permission covering the frame origin? */
  hostPermissionGranted: boolean;
  /** Fields the frame itself reported discovering, when it could report. */
  reportedFieldCount: number | null;
}

/**
 * Name the ONE cause, so the user gets one remedy instead of a shrug.
 */
export function frameVerdict(input: FrameVerdictInput): FrameOutcome {
  const { frame } = input;
  if (!frame) return "APPLICATION_FRAME_CONTENT_SCRIPT_UNAVAILABLE";
  // Checked first: no permission grant and no injection can ever reach an
  // opaque origin, so suggesting either would be a lie.
  if (frame.opaqueOrigin) return "APPLICATION_FRAME_SANDBOXED_OPAQUE";
  if (frame.origin && !input.hostPermissionGranted) return "APPLICATION_FRAME_PERMISSION_MISSING";
  if (!input.contentScriptResponds) return "APPLICATION_FRAME_CONTENT_SCRIPT_UNAVAILABLE";
  if (input.reportedFieldCount === 0) return "APPLICATION_FRAME_DISCOVERY_ZERO_FIELDS";
  if (input.reportedFieldCount !== null && input.reportedFieldCount > 0) {
    return "APPLICATION_FRAME_DISCOVERY_COMPLETED";
  }
  return "APPLICATION_FRAME_FOUND";
}

/**
 * Can this frame be safely reopened as a top-level application tab?
 *
 * The fallback that always works when injection and permissions cannot: the
 * frame's `src` is a normal navigable URL, so we hand it to the existing
 * validated-destination path, which binds the session and carries the package.
 *
 * Requires a real https URL. A blank, blob, data or srcdoc frame has no URL to
 * open, and saying otherwise would produce a broken tab.
 */
export function reopenableFrameUrl(frame: ObservedFrame | null, doc: Document = document): string | null {
  if (!frame) return null;
  if (frame.urlKind !== "https") return null;
  const element = doc.querySelectorAll("iframe")[frame.frameIndex] as HTMLIFrameElement | undefined;
  const raw = element?.getAttribute("src");
  if (!raw) return null;
  try {
    const resolved = new URL(raw, doc.location?.href);
    return resolved.protocol === "https:" ? resolved.toString() : null;
  } catch {
    return null;
  }
}

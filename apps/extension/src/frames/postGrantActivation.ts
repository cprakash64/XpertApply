import { canonicalFrameOrigin } from "./frameDiscovery";

export interface PostGrantFrame {
  frameId: number;
  url?: string;
}

export type PostGrantActivationResult =
  | { state: "active"; frameIds: number[]; attempts: number }
  | {
      state: "pending";
      frameIds: number[];
      attempts: number;
      reason: "frame_not_confirmed" | "injection_failed" | "bootstrap_unconfirmed";
    }
  | { state: "permission_revoked"; frameIds: []; attempts: number };

export interface PostGrantActivationDependencies {
  permissionGranted(): Promise<boolean>;
  enumerate(): Promise<PostGrantFrame[]>;
  workflowTrusted(origin: string): boolean;
  frameMatches(frame: PostGrantFrame): boolean;
  ping(frameId: number): Promise<boolean>;
  inject(frameIds: number[]): Promise<void>;
  wait(ms: number): Promise<void>;
}

/**
 * Turn one exact frame-origin grant into a live content-script instance.
 *
 * Enumeration is refreshed on every bounded attempt. An observed iframe hint
 * never enters this function and no frame id is inferred from DOM order: only
 * a concrete id returned by Chrome for the exact granted and workflow-trusted
 * origin can be targeted. Permission is checked again immediately before the
 * privileged injection so revocation fails closed.
 */
export async function activateGrantedApplicationFrame(
  targetOrigin: string,
  dependencies: PostGrantActivationDependencies,
  maxAttempts = 4
): Promise<PostGrantActivationResult> {
  let lastFrameIds: number[] = [];
  let lastReason: "frame_not_confirmed" | "injection_failed" | "bootstrap_unconfirmed" =
    "frame_not_confirmed";

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (!(await dependencies.permissionGranted())) {
      return { state: "permission_revoked", frameIds: [], attempts: attempt };
    }

    const frames = await dependencies.enumerate();
    const frameIds = Array.from(new Set(frames
      .filter((frame) => frame.frameId > 0)
      .filter((frame) => canonicalFrameOrigin(frame.url) === targetOrigin)
      .filter(() => dependencies.workflowTrusted(targetOrigin))
      .filter((frame) => dependencies.frameMatches(frame))
      .map((frame) => frame.frameId)))
      .sort((a, b) => a - b);
    lastFrameIds = frameIds;

    // More than one concrete frame still is not one selected application.
    // Fail closed instead of handing the session to every same-origin frame.
    if (frameIds.length !== 1) {
      lastReason = "frame_not_confirmed";
    } else {
      const alreadyActive = await Promise.all(frameIds.map((frameId) => dependencies.ping(frameId)));
      const activeIds = frameIds.filter((_, index) => alreadyActive[index]);
      if (activeIds.length > 0) return { state: "active", frameIds: activeIds, attempts: attempt };

      // Close the discovery→injection revocation window. Sender trust remains
      // authoritative after injection; this check merely ensures we do not
      // execute when Chrome has already withdrawn the exact host authority.
      if (!(await dependencies.permissionGranted())) {
        return { state: "permission_revoked", frameIds: [], attempts: attempt };
      }

      try {
        await dependencies.inject(frameIds);
        lastReason = "bootstrap_unconfirmed";
        const bootstrapped = await Promise.all(frameIds.map((frameId) => dependencies.ping(frameId)));
        const bootstrappedIds = frameIds.filter((_, index) => bootstrapped[index]);
        if (bootstrappedIds.length > 0) {
          return { state: "active", frameIds: bootstrappedIds, attempts: attempt };
        }
      } catch {
        // A navigation can invalidate a frame id between enumeration and
        // injection. Do not reuse it: the next attempt enumerates from Chrome
        // again and either obtains the new id or remains pending.
        lastReason = "injection_failed";
      }
    }

    if (attempt < maxAttempts) await dependencies.wait(Math.min(100 * 2 ** (attempt - 1), 400));
  }

  return { state: "pending", frameIds: lastFrameIds, attempts: maxAttempts, reason: lastReason };
}

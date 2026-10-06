/**
 * Content-script instance ownership.
 *
 * Reloading an unpacked MV3 extension invalidates the old script's
 * `chrome.runtime` connection, but the page and its isolated-world globals can
 * stay alive.  A newly injected bundle must therefore be allowed to supersede
 * the old one; a boolean "already loaded" guard permanently traps the page on
 * the orphaned instance.
 */

export const CONTENT_INSTANCE_KEY = "__jobpilotContentInstance";

export function makeContentInstanceId(buildId: string): string {
  return `${buildId}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
}

export function claimContentInstance(
  target: Record<string, unknown>,
  instanceId: string
): () => boolean {
  target[CONTENT_INSTANCE_KEY] = instanceId;
  return () => target[CONTENT_INSTANCE_KEY] === instanceId;
}


const WORKFLOW_INSTANCE_KEY = "__xpertapplyLiveWorkflowInstanceV1__";

/** Same-runtime reinjection must retain the workflow ledger and action owner.
 * The captured runtime liveness check permits a new bundle after extension
 * reload, even when the isolated world's old globals survived. */
export function claimWorkflowContentInstance(
  target: Record<string, unknown>,
  instanceId: string,
  buildId: string,
  runtimeIsLive: () => boolean
): () => boolean {
  const previous = target[WORKFLOW_INSTANCE_KEY] as
    | { buildId: string; isLive: () => boolean }
    | undefined;
  if (previous?.buildId === buildId) {
    try {
      if (previous.isLive()) return () => false;
    } catch {
      // An orphaned runtime cannot retain ownership.
    }
  }
  const isCurrent = claimContentInstance(target, instanceId);
  target[WORKFLOW_INSTANCE_KEY] = { buildId, isLive: () => isCurrent() && runtimeIsLive() };
  return isCurrent;
}

import { lastError } from "../logger";
import { MSG, type LaunchViewState } from "../messages";
import {
  createApplicationAssistant,
  type ActionResponse,
  type ApplicationAssistantContext
} from "../ui/applicationAssistant";
import {
  showOverlay,
  type ApplicationOverlayController
} from "./applicationOverlay";

interface OverlayContextResponse {
  ok?: boolean;
  context?: ApplicationAssistantContext;
}

interface OverlayViewResponse {
  ok?: boolean;
  view?: LaunchViewState | null;
}

export interface MountedApplicationOverlay {
  overlay: ApplicationOverlayController;
  refresh(): Promise<void>;
  dispose(): void;
}

// Toolbar and workflow scripts are separately bundled into the same extension
// isolated world. Their module-local registries must not create two controllers
// for the same document. This registry is never exposed to the page world.
const overlayWorld = globalThis as typeof globalThis & {
  __xpertapplyAssistantMountsV1__?: WeakMap<Document, MountedApplicationOverlay>;
  __xpertapplyOverlayWorkflowSurfacesV1__?: WeakMap<Document, HTMLElement>;
};
const mounts = overlayWorld.__xpertapplyAssistantMountsV1__ ??= new WeakMap<Document, MountedApplicationOverlay>();
const workflowSurfaces = overlayWorld.__xpertapplyOverlayWorkflowSurfacesV1__ ??= new WeakMap<Document, HTMLElement>();

/** Retain workflow presentation without granting passive UI opening authority. */
export function registerApplicationOverlayWorkflowSurface(surface: HTMLElement, ownerDocument: Document = document): () => void {
  workflowSurfaces.get(ownerDocument)?.remove();
  workflowSurfaces.set(ownerDocument, surface);
  const existing = mounts.get(ownerDocument);
  if (existing?.overlay.host.isConnected) {
    existing.overlay.root.querySelector("[data-overlay-workflow-extensions]")?.replaceChildren(surface);
  }
  return () => {
    if (workflowSurfaces.get(ownerDocument) !== surface) return;
    workflowSurfaces.delete(ownerDocument);
    surface.remove();
    mounts.get(ownerDocument)?.overlay.destroy();
  };
}

function sendWorker<T>(message: object): Promise<T | undefined> {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(message, (response) => {
        if (lastError()) return resolve(undefined);
        resolve(response as T | undefined);
      });
    } catch {
      resolve(undefined);
    }
  });
}

export function mountApplicationAssistantOverlay(options: {
  document?: Document;
  confirmAction?: (message: string) => boolean | Promise<boolean>;
} = {}): MountedApplicationOverlay {
  const ownerDocument = options.document ?? document;
  const existing = mounts.get(ownerDocument);
  if (existing?.overlay.host.isConnected) return existing;
  existing?.dispose();

  const overlay = showOverlay(ownerDocument);
  const surface = workflowSurfaces.get(ownerDocument);
  if (surface) overlay.root.querySelector("[data-overlay-workflow-extensions]")?.replaceChildren(surface);
  const controller = createApplicationAssistant({
    root: overlay.root,
    confirmAction: options.confirmAction ?? ((message) => window.confirm(message)),
    context: {
      async get() {
        const response = await sendWorker<OverlayContextResponse>({ type: MSG.OVERLAY_GET_CONTEXT });
        return response?.ok && response.context
          ? response.context
          : { available: false, status: "missing" };
      },
      subscribe() {
        // A content script is bound to one immutable document. Navigation
        // destroys it; storage view changes drive ordinary context refreshes.
        return () => undefined;
      }
    },
    views: {
      async get() {
        const response = await sendWorker<OverlayViewResponse>({ type: MSG.OVERLAY_GET_VIEW });
        return response?.ok ? response.view ?? null : null;
      },
      subscribe(listener) {
        if (typeof chrome === "undefined" || !chrome.runtime?.onMessage) return () => undefined;
        const onMessage = (raw: unknown, sender: chrome.runtime.MessageSender): boolean => {
          if (sender.id !== chrome.runtime.id || (raw as { type?: unknown })?.type !== MSG.OVERLAY_VIEW_CHANGED) return false;
          // The event is deliberately not authoritative. The controller's
          // refresh generation rejects late/out-of-order responses.
          listener(0, undefined);
          return false;
        };
        chrome.runtime.onMessage.addListener(onMessage);
        return () => chrome.runtime.onMessage.removeListener(onMessage);
      }
    },
    actions: {
      startAutofill: (_tabId, reason) => sendWorker<ActionResponse>({ type: MSG.OVERLAY_START_AUTOFILL, reason }),
      clearSession: () => sendWorker<ActionResponse>({ type: MSG.OVERLAY_CLEAR_SESSION }),
      completeSession: (_tabId, sessionId) => sendWorker<ActionResponse>({ type: MSG.OVERLAY_COMPLETE_SESSION, sessionId }),
      async requestSiteAccess(pattern) {
        // Invoke only from the controller's direct button handler. Never relay
        // permission prompts through the service worker, where user activation
        // is not authoritative. Chrome may withhold this API from a content
        // script; fail closed and leave the qualified Side Panel grant path.
        if (typeof chrome === "undefined" || !chrome.permissions?.request) return false;
        return chrome.permissions.request({ origins: [pattern] });
      },
      reportSiteAccess: (_tabId, pattern, granted) => sendWorker<ActionResponse>({
        type: MSG.OVERLAY_SITE_ACCESS_RESULT,
        pattern,
        granted
      })
    },
    // Consumer overlays never render build/protocol/tab diagnostics. Tests and
    // internal tooling can still supply the controller's diagnostics adapter
    // directly without exposing a production control.
  });

  const stopKeyboardPropagation = (event: Event): void => event.stopPropagation();
  const keyboardEvents = ["keydown", "keyup", "keypress"] as const;
  for (const type of keyboardEvents) overlay.host.addEventListener(type, stopKeyboardPropagation);

  let disposed = false;
  let mounted!: MountedApplicationOverlay;
  let refreshQueued = false;
  let recoveryInFlight: Promise<void> | null = null;
  const requestRefresh = (): void => {
    if (disposed || refreshQueued) return;
    refreshQueued = true;
    queueMicrotask(() => {
      refreshQueued = false;
      if (!disposed) void controller.refresh().catch(() => undefined);
    });
  };
  const recover = (): void => {
    if (!overlay.host.isConnected || overlay.getState() === "ABSENT") {
      mounted.dispose();
      return;
    }
    if (recoveryInFlight) return;
    recoveryInFlight = sendWorker({ type: MSG.TOOLBAR_OVERLAY_READY })
      .then(() => requestRefresh())
      .finally(() => { recoveryInFlight = null; });
  };
  const onVisibilityChange = (): void => {
    if (ownerDocument.visibilityState === "visible") recover();
  };
  const ownerWindow = ownerDocument.defaultView;
  ownerDocument.addEventListener("visibilitychange", onVisibilityChange);
  ownerWindow?.addEventListener("focus", recover);
  ownerWindow?.addEventListener("pageshow", recover);
  mounted = {
    overlay,
    refresh: () => controller.refresh(),
    dispose() {
      if (disposed) return;
      disposed = true;
      ownerDocument.removeEventListener("visibilitychange", onVisibilityChange);
      ownerWindow?.removeEventListener("focus", recover);
      ownerWindow?.removeEventListener("pageshow", recover);
      for (const type of keyboardEvents) overlay.host.removeEventListener(type, stopKeyboardPropagation);
      controller.dispose();
      if (mounts.get(ownerDocument) === mounted) mounts.delete(ownerDocument);
    }
  };
  overlay.onDestroy(() => mounted.dispose());
  mounts.set(ownerDocument, mounted);
  requestRefresh();
  return mounted;
}

/** Reserved for the future explicit toolbar path; passive widget updates never call this. */
export function reopenApplicationAssistantOverlay(ownerDocument: Document = document): MountedApplicationOverlay {
  const mounted = mountApplicationAssistantOverlay({ document: ownerDocument });
  mounted.overlay.show();
  mounted.overlay.focus();
  void mounted.refresh();
  return mounted;
}

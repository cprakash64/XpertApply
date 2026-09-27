import { lastError } from "../logger";
import { MSG, type LaunchViewState } from "../messages";
import { STORAGE_KEYS } from "../state";
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
  dispose(): void;
}

const mounts = new WeakMap<Document, MountedApplicationOverlay>();

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
        if (typeof chrome === "undefined" || !chrome.storage?.onChanged) return () => undefined;
        const onChanged = (changes: Record<string, chrome.storage.StorageChange>, areaName: string) => {
          if (areaName !== "session" && chrome.storage.session) return;
          const change = changes[STORAGE_KEYS.VIEW_KEY];
          if (!change) return;
          const next = (change.newValue as Record<string, LaunchViewState>) || {};
          for (const [tabId, view] of Object.entries(next)) listener(Number(tabId), view);
        };
        chrome.storage.onChanged.addListener(onChanged);
        return () => chrome.storage.onChanged.removeListener(onChanged);
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
    diagnostics: {
      enabled: typeof chrome !== "undefined" && !chrome.runtime.getManifest().update_url,
      surface: "overlay"
    }
  });

  let disposed = false;
  const mounted: MountedApplicationOverlay = {
    overlay,
    dispose() {
      if (disposed) return;
      disposed = true;
      controller.dispose();
      if (mounts.get(ownerDocument) === mounted) mounts.delete(ownerDocument);
    }
  };
  overlay.onDestroy(() => mounted.dispose());
  mounts.set(ownerDocument, mounted);
  void controller.refresh();
  return mounted;
}

/** Reserved for the future explicit toolbar path; passive widget updates never call this. */
export function reopenApplicationAssistantOverlay(ownerDocument: Document = document): MountedApplicationOverlay {
  return mountApplicationAssistantOverlay({ document: ownerDocument });
}

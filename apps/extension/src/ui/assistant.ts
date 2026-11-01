import type { AssistantContext } from "../assistantWindow";
import { lastError } from "../logger";
import { MSG, type AutofillReason, type LaunchViewState } from "../messages";
import { STORAGE_KEYS } from "../state";
import {
  createApplicationAssistant,
  type ActionResponse,
  type ApplicationAssistantContext
} from "./applicationAssistant";

interface AssistantContextResponse {
  ok?: boolean;
  context?: AssistantContext;
}

function sendWorker(message: object): Promise<ActionResponse | undefined> {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(message, (response) => {
        const error = lastError();
        if (error) return resolve({ ok: false, error });
        resolve(response as ActionResponse | undefined);
      });
    } catch (error) {
      resolve({ ok: false, error: String(error) });
    }
  });
}

function getWorkerContext(): Promise<AssistantContextResponse | undefined> {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage({ type: MSG.ASSISTANT_GET_CONTEXT }, (response) => {
        if (lastError()) return resolve(undefined);
        resolve(response as AssistantContextResponse | undefined);
      });
    } catch {
      resolve(undefined);
    }
  });
}

const assistant = createApplicationAssistant({
  root: document,
  confirmAction: (message) => window.confirm(message),
  context: {
    async get(): Promise<ApplicationAssistantContext> {
      const response = await getWorkerContext();
      const workerContext = response?.ok ? response.context : undefined;
      const tabId = workerContext?.status === "bound" ? workerContext.state.boundJobTabId : undefined;
      return { tabId, available: tabId != null, status: workerContext?.status ?? "waiting" };
    },
    subscribe(listener) {
      const onMessage = (message: unknown, sender: chrome.runtime.MessageSender) => {
        if (sender.id === chrome.runtime.id
          && typeof message === "object"
          && message !== null
          && "type" in message
          && message.type === MSG.ASSISTANT_CONTEXT_CHANGED) {
          listener();
        }
      };
      chrome.runtime.onMessage.addListener(onMessage);
      return () => chrome.runtime.onMessage.removeListener(onMessage);
    }
  },
  views: {
    async get(tabId) {
      const stored = await (chrome.storage.session ?? chrome.storage.local).get(STORAGE_KEYS.VIEW_KEY);
      const map = (stored[STORAGE_KEYS.VIEW_KEY] as Record<string, LaunchViewState>) || {};
      return map[String(tabId)] ?? null;
    },
    subscribe(listener) {
      const onChanged = (changes: Record<string, chrome.storage.StorageChange>, areaName: string) => {
        if (areaName !== "session" && chrome.storage.session) return;
        const change = changes[STORAGE_KEYS.VIEW_KEY];
        if (!change) return;
        const prior = (change.oldValue as Record<string, LaunchViewState>) || {};
        const next = (change.newValue as Record<string, LaunchViewState>) || {};
        for (const id of new Set([...Object.keys(prior), ...Object.keys(next)])) {
          listener(Number(id), next[id] ?? null);
        }
      };
      chrome.storage.onChanged.addListener(onChanged);
      return () => chrome.storage.onChanged.removeListener(onChanged);
    }
  },
  actions: {
    startAutofill: (tabId: number, reason: AutofillReason) => sendWorker({
      type: MSG.ASSISTANT_START_AUTOFILL,
      tabId,
      reason
    }),
    clearSession: (tabId) => sendWorker({ type: MSG.ASSISTANT_CLEAR_SESSION, tabId }),
    completeSession: (tabId, sessionId) => sendWorker({
      type: MSG.ASSISTANT_COMPLETE_SESSION,
      tabId,
      sessionId
    }),
    requestSiteAccess: (pattern) => chrome.permissions.request({ origins: [pattern] }),
    reportSiteAccess: (tabId, pattern, granted) => sendWorker({
      type: MSG.ASSISTANT_SITE_ACCESS_RESULT,
      tabId,
      pattern,
      granted
    })
  },
  diagnostics: {
    enabled: !chrome.runtime.getManifest().update_url,
    surface: "assistant"
  }
});

window.addEventListener("unload", () => assistant.dispose(), { once: true });
void assistant.refresh();

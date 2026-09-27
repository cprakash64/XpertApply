/**
 * Side panel: an OBSERVER of the tab-scoped launch state stored in
 * chrome.storage.local. It never drives detection itself and never blocks
 * autofill on its own rendering — autofill starts automatically from the launch.
 *
 * It subscribes to storage changes for the current employer tab and renders the
 * stage, ATS, counters, document status, review items and any actionable failure
 * reason. "Fill application" triggers the SAME canonical runner as the automatic
 * launch (START_AUTOFILL → background → content), and is disabled while a run is
 * active. Every button surfaces chrome.runtime.lastError instead of failing
 * silently. It never submits.
 */

import { lastError } from "../logger";
import { BUILD_INFO } from "../buildInfo";
import { getApiBase } from "../config";
import { MSG, type LaunchViewState } from "../messages";
import { classifyEnvironment, safeApiBase, SIDE_PANEL_RUNTIME_KEY } from "../runtimeIdentity";
import { STORAGE_KEYS } from "../state";
import { createApplicationAssistant, type ActionResponse } from "./applicationAssistant";

async function currentTabId(): Promise<number | undefined> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.id;
}


async function publishRuntimeIdentity(): Promise<void> {
  await chrome.storage.local.set({
    [SIDE_PANEL_RUNTIME_KEY]: {
      buildId: BUILD_INFO.buildId,
      version: BUILD_INFO.version,
      environment: classifyEnvironment(await getApiBase()),
      apiBase: safeApiBase(await getApiBase())
    }
  });
}

function sendBackground(message: object): Promise<ActionResponse | undefined> {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(message, (resp) => {
        const err = lastError();
        if (err) return resolve({ ok: false, error: err });
        resolve(resp as ActionResponse);
      });
    } catch (e) {
      resolve({ ok: false, error: String(e) });
    }
  });
}

const assistant = createApplicationAssistant({
  root: document,
  confirmAction: (message) => window.confirm(message),
  context: {
    async get() {
      const tabId = await currentTabId();
      return { tabId, available: tabId != null };
    },
    subscribe(listener) {
      const onActivated = () => listener();
      chrome.tabs.onActivated.addListener(onActivated);
      return () => chrome.tabs.onActivated.removeListener(onActivated);
    }
  },
  views: {
    async get(tabId) {
      const store = await (chrome.storage.session ?? chrome.storage.local).get(STORAGE_KEYS.VIEW_KEY);
      const map = (store[STORAGE_KEYS.VIEW_KEY] as Record<string, LaunchViewState>) || {};
      return map[String(tabId)] ?? null;
    },
    subscribe(listener) {
      const onChanged = (changes: Record<string, chrome.storage.StorageChange>, areaName: string) => {
        if (areaName !== "session" && chrome.storage.session) return;
        const change = changes[STORAGE_KEYS.VIEW_KEY];
        if (!change) return;
        const map = (change.newValue as Record<string, LaunchViewState>) || {};
        for (const [id, nextView] of Object.entries(map)) listener(Number(id), nextView);
      };
      chrome.storage.onChanged.addListener(onChanged);
      return () => chrome.storage.onChanged.removeListener(onChanged);
    }
  },
  actions: {
    startAutofill: (tabId, reason) => sendBackground({ type: MSG.START_AUTOFILL, tabId, reason }),
    clearSession: (tabId) => sendBackground({ type: MSG.CLEAR_SESSION, tabId }),
    completeSession: (_tabId, sessionId) => sendBackground({ type: MSG.COMPLETE_SESSION, sessionId }),
    requestSiteAccess: (pattern) => chrome.permissions.request({ origins: [pattern] }),
    reportSiteAccess: (tabId, pattern, granted) => sendBackground({ type: MSG.SITE_ACCESS_RESULT, tabId, pattern, granted })
  },
  diagnostics: {
    enabled: !chrome.runtime.getManifest().update_url,
    surface: "sidePanel"
  }
});

window.addEventListener("unload", () => assistant.dispose(), { once: true });
void publishRuntimeIdentity().then(() => assistant.refresh());

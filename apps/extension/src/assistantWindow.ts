export const ASSISTANT_STATE_KEY = "xpertapplyAssistantStateV1";

export interface AssistantState {
  assistantWindowId?: number;
  boundJobTabId?: number;
}

export type AssistantContextStatus = "waiting" | "bound" | "missing" | "unsupported";

export interface AssistantContext {
  state: AssistantState;
  status: AssistantContextStatus;
  title?: string;
  url?: string;
}

const ASSISTANT_PATH = "assistant.html";
let creationInFlight: Promise<chrome.windows.Window> | null = null;

function sessionStorage(): chrome.storage.StorageArea {
  return chrome.storage.session ?? chrome.storage.local;
}

export function assistantUrl(): string {
  return chrome.runtime.getURL(ASSISTANT_PATH);
}

export async function readAssistantState(): Promise<AssistantState> {
  const stored = await sessionStorage().get(ASSISTANT_STATE_KEY);
  const candidate = stored[ASSISTANT_STATE_KEY] as AssistantState | undefined;
  return {
    ...(Number.isInteger(candidate?.assistantWindowId) ? { assistantWindowId: candidate!.assistantWindowId } : {}),
    ...(Number.isInteger(candidate?.boundJobTabId) ? { boundJobTabId: candidate!.boundJobTabId } : {})
  };
}

async function writeAssistantState(state: AssistantState): Promise<void> {
  await sessionStorage().set({ [ASSISTANT_STATE_KEY]: state });
}

function isAssistantTab(tab: chrome.tabs.Tab): boolean {
  return tab.url === assistantUrl() || tab.pendingUrl === assistantUrl();
}

export async function validateJobTab(tabId: number): Promise<chrome.tabs.Tab | null> {
  if (!Number.isInteger(tabId) || tabId < 0) return null;
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab || isAssistantTab(tab)) return null;
  const rawUrl = tab.url ?? tab.pendingUrl;
  if (!rawUrl) return null;
  try {
    const url = new URL(rawUrl);
    return url.protocol === "http:" || url.protocol === "https:" ? tab : null;
  } catch {
    return null;
  }
}

export async function findExistingAssistant(): Promise<chrome.windows.Window | null> {
  const windows = await chrome.windows.getAll({ populate: true });
  const matches = windows
    .filter((window) => window.id != null && window.tabs?.some(isAssistantTab))
    .sort((a, b) => a.id! - b.id!);
  const canonical = matches[0] ?? null;
  // Only windows proven to contain our exact extension-owned page are closed.
  // This makes a cross-worker race converge without ever trusting a stale ID
  // or touching an unrelated popup window.
  await Promise.all(matches.slice(1).map((window) =>
    chrome.windows.remove(window.id!).catch(() => undefined)
  ));
  const state = await readAssistantState();
  await writeAssistantState({
    ...state,
    ...(canonical?.id != null ? { assistantWindowId: canonical.id } : { assistantWindowId: undefined })
  });
  return canonical;
}

export async function bindAssistantToJobTab(tabId: number): Promise<boolean> {
  const tab = await validateJobTab(tabId);
  if (!tab) return false;
  const state = await readAssistantState();
  await writeAssistantState({ ...state, boundJobTabId: tabId });
  await notifyAssistantContextChanged();
  return true;
}

export async function clearBoundJobTab(tabId?: number): Promise<void> {
  const state = await readAssistantState();
  if (tabId != null && state.boundJobTabId !== tabId) return;
  await writeAssistantState({ ...state, boundJobTabId: undefined });
  await notifyAssistantContextChanged();
}

export async function clearAssistantWindowReference(windowId?: number): Promise<void> {
  const state = await readAssistantState();
  if (windowId != null && state.assistantWindowId !== windowId) return;
  await writeAssistantState({ ...state, assistantWindowId: undefined });
}

export async function createAssistant(jobTabId?: number): Promise<chrome.windows.Window> {
  if (creationInFlight) return creationInFlight;
  creationInFlight = (async () => {
    const discovered = await findExistingAssistant();
    if (discovered) {
      if (jobTabId != null) await bindAssistantToJobTab(jobTabId);
      return discovered;
    }
    const created = await chrome.windows.create({
      url: assistantUrl(),
      type: "popup",
      width: 460,
      height: 800,
      focused: true
    });
    if (created.id == null) throw new Error("ASSISTANT_WINDOW_ID_UNAVAILABLE");
    const state = await readAssistantState();
    await writeAssistantState({ ...state, assistantWindowId: created.id });
    if (jobTabId != null) await bindAssistantToJobTab(jobTabId);
    return created;
  })();
  try {
    return await creationInFlight;
  } finally {
    creationInFlight = null;
  }
}

export async function focusAssistant(windowId: number): Promise<void> {
  await chrome.windows.update(windowId, { focused: true });
}

export async function openOrFocusAssistant(jobTabId?: number): Promise<chrome.windows.Window> {
  const existing = await findExistingAssistant();
  if (existing?.id != null) {
    if (jobTabId != null) await bindAssistantToJobTab(jobTabId);
    await focusAssistant(existing.id);
    return existing;
  }
  return createAssistant(jobTabId);
}

export async function getAssistantContext(): Promise<AssistantContext> {
  const state = await readAssistantState();
  if (state.boundJobTabId == null) return { state, status: "waiting" };
  const tab = await validateJobTab(state.boundJobTabId);
  if (!tab) return { state, status: "missing" };
  return { state, status: "bound", title: tab.title || undefined, url: tab.url || tab.pendingUrl };
}

export async function restoreAssistantAfterServiceWorkerWake(): Promise<AssistantContext> {
  await findExistingAssistant();
  const state = await readAssistantState();
  if (state.boundJobTabId != null && !(await validateJobTab(state.boundJobTabId))) {
    await clearBoundJobTab(state.boundJobTabId);
  }
  return getAssistantContext();
}

export async function handleAssistantWindowRemoved(windowId: number): Promise<void> {
  const state = await readAssistantState();
  if (state.assistantWindowId === windowId) await clearAssistantWindowReference(windowId);
}

export async function handleBoundTabUpdated(tabId: number): Promise<void> {
  const state = await readAssistantState();
  if (state.boundJobTabId !== tabId) return;
  if (!(await validateJobTab(tabId))) await clearBoundJobTab(tabId);
  else await notifyAssistantContextChanged();
}

async function notifyAssistantContextChanged(): Promise<void> {
  await chrome.runtime.sendMessage({ type: "XPERTAPPLY_ASSISTANT_CONTEXT_CHANGED" }).catch(() => undefined);
}

export function isTrustedAssistantSender(sender: chrome.runtime.MessageSender): boolean {
  return sender.id === chrome.runtime.id && sender.url === assistantUrl();
}

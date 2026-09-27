import { MSG } from "../messages";
import type { AssistantContext } from "../assistantWindow";

const status = document.querySelector<HTMLElement>("#status")!;
const detail = document.querySelector<HTMLElement>("#detail")!;

function render(context: AssistantContext | null): void {
  detail.hidden = true;
  detail.textContent = "";
  if (!context || context.status === "waiting") {
    status.textContent = "Open or select a job application page to begin.";
    return;
  }
  if (context.status === "missing") {
    status.textContent = "The selected job tab is no longer available. Select a job application page to continue.";
    return;
  }
  if (context.status === "unsupported") {
    status.textContent = "Application assistance is unavailable on the current page.";
    return;
  }
  status.textContent = "A job application tab is connected.";
  const label = context.title?.trim() || "Job application page";
  detail.textContent = label;
  detail.hidden = false;
}

async function refresh(): Promise<void> {
  const response = await chrome.runtime.sendMessage({ type: MSG.ASSISTANT_GET_CONTEXT }).catch(() => null) as
    | { ok?: boolean; context?: AssistantContext }
    | null;
  render(response?.ok ? response.context ?? null : null);
}

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === MSG.ASSISTANT_CONTEXT_CHANGED) void refresh();
});

void refresh();

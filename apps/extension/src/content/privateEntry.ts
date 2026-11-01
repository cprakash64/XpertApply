import { MSG, parseRuntimeMessage } from "../messages";
import { FIELD_ENTRY_PAGE, fieldEntryHeight, type FieldEntryField, type FieldEntryToggle } from "../fieldEntry";

export interface PrivateEntryOptions {
  fields: FieldEntryField[];
  submitLabel: string;
  toggle?: FieldEntryToggle;
  /** Resolves true when the value was accepted and used. Runs in the content script. */
  onSubmit: (values: string[], toggled: boolean | undefined) => Promise<boolean>;
}

type Pending = { element: HTMLElement; options: PrivateEntryOptions };
const pending = new Map<string, Pending>();
let receiverInstalled = false;

function installReceiver(): void {
  if (receiverInstalled) return;
  receiverInstalled = true;
  chrome.runtime.onMessage.addListener((raw, sender, sendResponse) => {
    const message = parseRuntimeMessage(raw);
    if (message?.type !== MSG.FIELD_ENTRY_DELIVER) return false;
    // Only the worker delivers; it has no tab. A page cannot send runtime messages.
    if (sender.id !== chrome.runtime.id || sender.tab) return false;
    const entry = pending.get(message.entryId);
    if (!entry || !entry.element.isConnected) {
      pending.delete(message.entryId);
      sendResponse({ ok: false });
      return false;
    }
    void entry.options.onSubmit(message.values.map(String), message.toggled).then(
      (ok) => sendResponse({ ok }),
      () => sendResponse({ ok: false })
    );
    return true;
  });
}

/**
 * A text-entry block whose inputs live in an extension-origin iframe. If the
 * iframe cannot be created or loaded the block says so; it NEVER falls back to
 * an input in the employer page's document.
 */
export function createPrivateEntry(options: PrivateEntryOptions): HTMLElement {
  const entryId = crypto.randomUUID();
  const hasRuntime = typeof chrome !== "undefined" && Boolean(chrome.runtime?.id);
  if (hasRuntime) installReceiver();
  const element = document.createElement("div");
  element.className = "private-entry";
  element.setAttribute("data-private-entry", entryId);
  const unavailable = (): void => {
    pending.delete(entryId);
    element.textContent = "";
    const note = document.createElement("div");
    note.className = "why";
    note.textContent = "This page does not allow a private entry box. Type this answer directly on the employer's form instead.";
    element.appendChild(note);
  };
  if (!hasRuntime) { unavailable(); return element; }
  pending.set(entryId, { element, options });
  chrome.runtime.sendMessage({
    type: MSG.FIELD_ENTRY_REGISTER, entryId, fields: options.fields,
    submitLabel: options.submitLabel, toggle: options.toggle
  }, (response?: { ok?: boolean }) => {
    void chrome.runtime.lastError;
    if (!response?.ok) { unavailable(); return; }
    const frame = document.createElement("iframe");
    frame.title = "XpertApply private entry";
    frame.src = `${chrome.runtime.getURL(FIELD_ENTRY_PAGE)}#${encodeURIComponent(entryId)}`;
    frame.setAttribute("referrerpolicy", "no-referrer");
    frame.style.cssText = `display:block;width:100%;border:0;background:transparent;height:${fieldEntryHeight(options.fields.length, Boolean(options.toggle))}px`;
    frame.addEventListener("error", unavailable);
    element.appendChild(frame);
  });
  return element;
}

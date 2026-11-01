import { MSG } from "../messages";
import type { FieldEntryConfig } from "../fieldEntry";

const entryId = decodeURIComponent(location.hash.slice(1));
const form = document.getElementById("f") as HTMLFormElement;

function send<T>(message: object): Promise<T | undefined> {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(message, (response) => { void chrome.runtime.lastError; resolve(response as T | undefined); });
    } catch { resolve(undefined); }
  });
}

async function main(): Promise<void> {
  const config = await send<{ ok: boolean; config?: FieldEntryConfig }>({ type: MSG.FIELD_ENTRY_CONFIG, entryId });
  if (!config?.ok || !config.config) {
    form.textContent = "This entry expired. Close and reopen the assistant.";
    return;
  }
  const { fields, submitLabel, toggle } = config.config;
  const inputs = fields.map((field) => {
    const input = document.createElement("input");
    input.type = "text";
    input.placeholder = field.placeholder;
    input.setAttribute("aria-label", field.placeholder);
    input.value = field.value;
    input.autocomplete = "off";
    form.appendChild(input);
    return input;
  });
  let box: HTMLInputElement | null = null;
  if (toggle) {
    const label = document.createElement("label");
    label.className = "toggle";
    box = document.createElement("input");
    box.type = "checkbox";
    box.checked = toggle.checked;
    label.append(box, document.createTextNode(toggle.label));
    form.appendChild(label);
  }
  const button = document.createElement("button");
  button.type = "submit";
  button.textContent = submitLabel;
  form.appendChild(button);
  const msg = document.createElement("div");
  msg.id = "msg";
  msg.setAttribute("role", "status");
  form.appendChild(msg);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    button.disabled = true;
    msg.textContent = "";
    const response = await send<{ ok: boolean }>({
      type: MSG.FIELD_ENTRY_SUBMIT, entryId, values: inputs.map((input) => input.value), toggled: box ? box.checked : undefined
    });
    if (!response?.ok) {
      button.disabled = false;
      msg.textContent = "That could not be used. Check it and try again.";
    }
  });
}

void main();

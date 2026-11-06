/**
 * Site-access page: first-run onboarding and the standing place to see and change what Chrome has granted.
 *
 * It is an extension page, so it can call chrome.permissions.request from a real click. The request is the
 * FIRST statement of the click handler, with nothing awaited before it: an await first would end the user
 * gesture and Chrome would refuse the dialog. State shown here is always read from Chrome
 * (permissions.getAll), never from our own records, and it refreshes on permissions.onAdded/onRemoved.
 */
import { ONBOARDING_PATTERNS, SITE_GROUPS, groupAccess, isSupportedAtsWildcard } from "../siteGrants";
import { getOnboarding, setOnboarding, suppressedReason, clearSuppression } from "../siteAccessStore";

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const OWN_ORIGINS = /^https:\/\/(?:www\.)?(?:xpertapply\.com|api\.xpertapply\.com)\/\*$/;

function setStatus(text: string): void { $("status").textContent = text; }

async function granted(): Promise<string[]> {
  return (await chrome.permissions.getAll()).origins ?? [];
}

function row(name: string, state: string, on: boolean, label: string, action: () => void, primary = false): HTMLElement {
  const el = document.createElement("div");
  el.className = "row";
  const text = document.createElement("div");
  const n = document.createElement("div"); n.className = "name"; n.textContent = name;
  const s = document.createElement("div"); s.className = `state${on ? " on" : ""}`; s.textContent = state;
  text.append(n, s);
  const b = document.createElement("button");
  b.type = "button"; b.textContent = label; if (primary) b.className = "primary";
  b.addEventListener("click", action);
  el.append(text, b);
  return el;
}

async function render(): Promise<void> {
  const origins = await granted();
  const groups = $("groups");
  groups.replaceChildren();
  for (const group of SITE_GROUPS) {
    const on = groupAccess(origins, group) === "granted";
    const suppressed = on ? null : await suppressedReason(group.pattern);
    const note = group.support === "limited" ? " (limited: standard fields only)" : "";
    const state = on ? `Allowed${note}` : suppressed === "revoked" ? `Turned off${note}` : suppressed === "declined" ? `Not allowed${note}` : `Not enabled${note}`;
    groups.append(row(group.label, state, on, on ? "Turn off" : "Allow", () => {
      if (on) {
        void chrome.permissions.remove({ origins: [group.pattern] }).then(() => render());
      } else {
        // Gesture-bound: first statement, no await before it.
        void chrome.permissions.request({ origins: [group.pattern] }).then(async (ok) => {
          if (ok) await clearSuppression(group.pattern);
          await render();
        }).catch(() => setStatus("Chrome did not show the prompt. Try again."));
      }
    }));
  }
  const others = origins.filter((pattern) => !isSupportedAtsWildcard(pattern) && !OWN_ORIGINS.test(pattern)
    && !SITE_GROUPS.some((group) => pattern.endsWith(`.${group.suffix}/*`) || pattern === `https://${group.suffix}/*`));
  const custom = $("custom");
  custom.replaceChildren();
  $("customCard").hidden = others.length === 0;
  for (const pattern of others) {
    custom.append(row(pattern.replace(/^https:\/\//, "").replace(/\/\*$/, ""), "Allowed", true, "Remove", () => {
      void chrome.permissions.remove({ origins: [pattern] }).then(() => render());
    }));
  }
  const all = SITE_GROUPS.every((group) => groupAccess(origins, group) === "granted");
  $("enableCard").hidden = all;
}

function onEnable(): void {
  // First statement: the click's user gesture is still live. Nothing is awaited before this call.
  const request = chrome.permissions.request({ origins: [...ONBOARDING_PATTERNS] });
  setStatus("Waiting for your choice in Chrome…");
  request.then(async (ok) => {
    await setOnboarding(ok ? "enabled" : "declined");
    setStatus(ok ? "Automatic assistance is on for supported job sites." : "No problem. Nothing was changed. You can enable it any time from here.");
    await render();
  }).catch(() => setStatus("Chrome did not show the prompt. Click the button again."));
}

async function main(): Promise<void> {
  const welcome = new URLSearchParams(location.search).get("welcome") === "1";
  if (welcome) {
    $("title").textContent = "Welcome to XpertApply";
    $("lead").textContent = "Optional: let XpertApply's assistant appear on supported job applications. You stay in control.";
  }
  $("enable").addEventListener("click", onEnable);
  $("notNow").addEventListener("click", () => {
    void setOnboarding("skipped").then(() => { setStatus("Skipped. XpertApply will only ask when you open a supported application."); });
  });
  chrome.permissions.onAdded.addListener(() => { void render(); });
  chrome.permissions.onRemoved.addListener(() => { void render(); });
  const prior = await getOnboarding();
  if (prior?.status === "enabled") setStatus("Automatic assistance is on for supported job sites.");
  await render();
}

void main();

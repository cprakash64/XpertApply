import { MSG } from "../messages";

export const TOOLBAR_DISCLOSURE_HOST_ID = "xpertapply-toolbar-disclosure-v1";

/**
 * Static first-use disclosure shown BEFORE the toolbar path reads the page.
 *
 * Nothing here touches the employer page's forms or text: it is fixed copy and
 * two buttons. The root is closed for the same reason the assistant's is, and
 * only a trusted click on Continue is honoured.
 */
export function showToolbarDisclosure(ownerDocument: Document = document): void {
  ownerDocument.getElementById(TOOLBAR_DISCLOSURE_HOST_ID)?.remove();
  const host = ownerDocument.createElement("div");
  host.id = TOOLBAR_DISCLOSURE_HOST_ID;
  const root = host.attachShadow({ mode: "closed" });
  root.innerHTML = `
    <style>
      :host{all:initial}
      .box{position:fixed;right:16px;bottom:16px;z-index:2147483647;width:min(380px,calc(100vw - 32px));box-sizing:border-box;
        padding:18px;border-radius:14px;background:#fff;color:#1a2b21;border:1px solid rgba(57,93,70,.28);
        box-shadow:0 12px 36px rgba(26,43,33,.22);font:14px/1.45 system-ui,-apple-system,Segoe UI,sans-serif}
      h2{margin:0 0 8px;font-size:16px;line-height:1.3}
      ul{margin:0 0 14px;padding-left:18px}li{margin:0 0 6px}
      .row{display:flex;gap:8px;justify-content:flex-end}
      button{min-height:36px;padding:0 16px;border-radius:9px;font:inherit;font-weight:600;cursor:pointer;border:1px solid #1e744c}
      .go{background:#1e744c;color:#fff}.no{background:#fff;color:#1e744c}
      button:focus-visible{outline:3px solid #1e744c;outline-offset:2px}
    </style>
    <div class="box" role="dialog" aria-modal="false" aria-labelledby="t" aria-describedby="d">
      <h2 id="t" tabindex="-1">Let XpertApply read this application page?</h2>
      <ul id="d">
        <li>You clicked the XpertApply toolbar icon, so Chrome lets XpertApply temporarily access this tab.</li>
        <li>To show the assistant, XpertApply reads which fields this application form has. That happens in your browser.</li>
        <li>Opening the assistant does not fill or submit anything.</li>
        <li>Page or application information goes to XpertApply only when you choose a feature that needs it, such as matching your saved answers to this form's questions.</li>
        <li>This temporary access ends when you leave this site or close the tab.</li>
      </ul>
      <div class="row"><button class="no" type="button" data-cancel>Cancel</button><button class="go" type="button" data-continue>Continue</button></div>
    </div>`;
  const remove = (): void => host.remove();
  const cont = root.querySelector<HTMLButtonElement>("[data-continue]")!;
  cont.addEventListener("click", (event) => {
    if (!event.isTrusted) return;
    cont.disabled = true;
    chrome.runtime.sendMessage({ type: MSG.TOOLBAR_DISCLOSURE_ACCEPT }, (response?: { ok?: boolean }) => {
      void chrome.runtime.lastError;
      if (response?.ok) remove();
      else cont.disabled = false;
    });
  });
  root.querySelector<HTMLButtonElement>("[data-cancel]")!.addEventListener("click", (event) => {
    if (event.isTrusted) remove();
  });
  root.addEventListener("keydown", (event) => {
    if ((event as KeyboardEvent).key === "Escape" && event.isTrusted) remove();
  });
  (ownerDocument.body ?? ownerDocument.documentElement).appendChild(host);
  root.getElementById("t")?.focus({ preventScroll: true });
}

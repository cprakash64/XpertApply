/**
 * The four fixture pages for Stage 3C-V2 manual acceptance.
 *
 * Every page carries a large, plain-language status panel so the human running
 * the test reads outcomes off the screen instead of out of DevTools. The panel
 * reports only what the page can honestly observe about itself:
 *
 *   • the XpertApply widget host element (`#jobpilot-assisted-apply`), which the
 *     content script creates in the frame it runs in;
 *   • whether any forbidden legacy `data-jobpilot-*` marker is visible;
 *   • the live value of every field, so a fill — or the absence of one — is
 *     visible;
 *   • whether the form was ever submitted.
 *
 * Nothing here reads across origins and nothing here talks to the extension.
 */

/** Synthetic. Every value belongs to no one. */
export const PROFILE = {
  email: "fixture.candidate@example.test",
  full_name: "Fixture Candidate",
  first_name: "Fixture",
  last_name: "Candidate",
  phone: "+1-555-0100"
};

const PANEL_CSS = `
  :root { color-scheme: light dark; }
  body { font: 15px/1.5 system-ui, sans-serif; margin: 0; padding: 16px; }
  .xa-panel { border: 3px solid #444; border-radius: 8px; padding: 12px 16px; margin-bottom: 16px;
              background: #fffbe6; color: #111; }
  .xa-panel h2 { margin: 0 0 8px; font-size: 16px; letter-spacing: .04em; text-transform: uppercase; }
  .xa-row { display: flex; justify-content: space-between; gap: 16px; padding: 3px 0;
            border-bottom: 1px dotted #bbb; font-family: ui-monospace, monospace; font-size: 14px; }
  .xa-row b { font-weight: 700; }
  .yes { color: #b00020; font-weight: 700; }
  .no  { color: #0a6b2d; font-weight: 700; }
  .neutral { color: #333; }
  form { border: 1px solid #999; border-radius: 8px; padding: 12px 16px; }
  label { display: block; margin-top: 10px; font-weight: 600; }
  input[type=text], input[type=email], input[type=tel], select { width: 320px; padding: 4px; }
  .danger { border: 2px solid #b00020; padding: 8px; border-radius: 6px; margin-top: 12px; }
`;

/**
 * The live status panel.
 *
 * `dangerous` names the rows where YES is the bad answer, so the colour coding
 * matches the meaning of the test rather than the truth of the boolean.
 */
const PANEL_JS = `
(function () {
  const rows = [];
  function row(label, value, dangerousWhenYes) {
    rows.push({ label, value, dangerousWhenYes });
  }
  function scan() {
    const widget = !!document.getElementById("jobpilot-assisted-apply");
    const traced = Array.from(document.querySelectorAll("*")).reduce((count, element) =>
      count + Array.from(element.attributes).filter((attribute) => attribute.name.startsWith("data-jobpilot-")).length, 0);
    const fields = Array.from(document.querySelectorAll("input,select,textarea"));
    const filled = fields.filter((f) =>
      f.type === "checkbox" || f.type === "radio" ? f.checked
      : f.type === "file" ? (f.files && f.files.length > 0)
      : String(f.value || "").trim() !== "");
    const file = document.querySelector("input[type=file]");
    const attached = file && file.files && file.files.length ? file.files[0].name : null;

    rows.length = 0;
    row("SCRIPT ACTIVE (widget)", widget ? "YES" : "NO", true);
    row("XPERTAPPLY DOM TRACE", traced > 0 ? "YES (" + traced + " fields)" : "NO", true);
    row("ANY FIELD FILLED", filled.length ? "YES (" + filled.length + ")" : "NO", true);
    row("RESUME RECEIVED", attached ? "YES — " + attached : "NO", true);
    row("FORM SUBMITTED", window.__xaSubmitted ? "YES" : "NO", true);
    for (const f of fields) {
      if (f.type === "file") continue;
      const v = f.type === "checkbox" || f.type === "radio"
        ? (f.checked ? "CHECKED" : "unchecked")
        : (String(f.value || "") || "(empty)");
      row("field " + (f.id || f.name), v, false);
    }

    const host = document.getElementById("xa-panel-body");
    if (!host) return;
    host.innerHTML = rows.map(function (r) {
      const isYes = String(r.value).startsWith("YES") || r.value === "CHECKED";
      const cls = r.dangerousWhenYes ? (isYes ? "yes" : "no") : "neutral";
      return '<div class="xa-row"><span>' + r.label + '</span><b class="' + cls + '">' + r.value + '</b></div>';
    }).join("");
  }
  window.__xaSubmitted = false;
  document.addEventListener("submit", function (e) {
    // Never let a submission actually leave the fixture — but do record that
    // one was attempted, because that is a hard failure for this stage.
    e.preventDefault();
    window.__xaSubmitted = true;
    scan();
  }, true);
  setInterval(scan, 400);
  document.addEventListener("DOMContentLoaded", scan);
  scan();
})();
`;

function shell(title, heading, body) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
    <style>${PANEL_CSS}</style></head><body>
    <h1>${heading}</h1>
    <div class="xa-panel"><h2>${heading} — live status</h2><div id="xa-panel-body"></div></div>
    ${body}
    <script>${PANEL_JS}</script>
  </body></html>`;
}

/**
 * The XpertApply web app, on a first-party origin the manifest already trusts.
 *
 * This is the REAL production launch path: the page posts the same
 * `START_ASSISTED_APPLY` message the product posts, the declaratively-injected
 * first-party content script forwards it, and the worker opens the employer tab
 * and records what host access the workflow needs. Nothing about the launch is
 * simulated and no extension storage is touched by hand.
 */
export function launcherPage(applicationUrl, extensionId) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>XpertApply — fixture</title>
  <style>${PANEL_CSS}
    button { font-size: 18px; padding: 12px 20px; margin-top: 12px; cursor: pointer; }
    #log { font-family: ui-monospace, monospace; white-space: pre-wrap; margin-top: 16px;
           border: 1px solid #999; padding: 10px; border-radius: 6px; min-height: 4em; }
  </style></head><body>
  <h1>XpertApply — Stage 3C-V2 launcher</h1>
  <div class="xa-panel"><h2>What this page is</h2>
    <div class="xa-row"><span>origin</span><b>https://xpertapply.com</b></div>
    <div class="xa-row"><span>role</span><b>first-party bridge (static content script)</b></div>
    <div class="xa-row"><span>application URL</span><b>${applicationUrl}</b></div>
    <div class="xa-row"><span>extension detected</span><b id="ext">checking…</b></div>
  </div>
  <p>Click below to start a real assisted-apply workflow. This posts the same
     message the production web app posts — nothing is simulated.</p>
  <button id="apply">Apply with XpertApply</button>
  <div id="log">(no launch yet)</div>
  <script>
    const WEB = "jobpilot-web";
    const EXT = "jobpilot-extension";
    const EXTENSION_ID = ${JSON.stringify(extensionId)};
    const logEl = document.getElementById("log");
    function log(line) { logEl.textContent = line + "\\n" + logEl.textContent; }

    window.addEventListener("message", (e) => {
      const d = e.data;
      if (!d || d.source !== EXT) return;
      if (d.type === "JOBPILOT_START_ASSISTED_APPLY_RESULT") {
        log("launch result: " + JSON.stringify(d.result));
      }
    });
    const extStatus = document.getElementById("ext");
    if (!/^[a-p]{32}$/.test(EXTENSION_ID) || typeof chrome === "undefined" || typeof chrome.runtime?.sendMessage !== "function") {
      extStatus.textContent = "NOT CONFIGURED — set XPERTAPPLY_EXTENSION_ID";
    } else {
      chrome.runtime.sendMessage(EXTENSION_ID, { type: "XPERTAPPLY_EXTERNAL_PING" }, (result) => {
        if (chrome.runtime.lastError || result?.ok !== true) {
          extStatus.textContent = "NO — browser runtime did not reach the extension";
          return;
        }
        extStatus.textContent = "YES — v" + result.info.version + " (protocol " + result.info.protocolVersion + ")";
      });
    }

    document.getElementById("apply").addEventListener("click", () => {
      const requestId = "3cv2-" + Date.now();
      log("posting START_ASSISTED_APPLY (requestId " + requestId + ")");
      window.postMessage({
        source: WEB,
        type: "JOBPILOT_START_ASSISTED_APPLY",
        payload: {
          requestId,
          launchToken: "fixture-launch-token",
          sessionId: 55,
          jobId: 1,
          officialUrl: ${JSON.stringify(applicationUrl)},
          atsType: null
        }
      }, location.origin);
    });
  </script></body></html>`;
}

/** The employer page. No application of its own — the application is embedded,
 * and the ad frame is deliberately FIRST in DOM order. */
export function employerPage(atsOrigin, adsOrigin) {
  return shell("Careers — Fixture Employer", "EMPLOYER (top frame)", `
    <h2>Software Engineer</h2>
    <p>Apply using the form below.</p>
    <h3>Sponsored (unrelated third party)</h3>
    <iframe id="ads" src="${adsOrigin}/widget" width="640" height="420"
            style="border:2px dashed #b00020"></iframe>
    <h3>Application</h3>
    <iframe id="ats" src="${atsOrigin}/embed/1" width="820" height="900"
            style="border:2px solid #0a6b2d"></iframe>
  `);
}

/**
 * The real application, on the ATS origin.
 *
 * Beyond the safe identity fields it carries one field for each downstream
 * safety finding, so a permission grant cannot quietly re-open any of them:
 *
 *   XA-02  a legal attestation the candidate must make personally
 *   XA-03  a work-authorisation question scoped to a NON-US jurisdiction
 *   XA-04  a sponsorship question asked with negated polarity
 *   plus   a field the human types into before the fill runs
 */
export function atsPage() {
  return shell("Apply — Fixture ATS", "ATS APPLICATION FRAME", `
    <form id="application-form" action="/submit" method="post">
      <label for="first_name">First name</label>
      <input type="text" id="first_name" name="first_name" />

      <label for="last_name">Last name</label>
      <input type="text" id="last_name" name="last_name" />

      <label for="email">Email</label>
      <input type="email" id="email" name="email" />

      <label for="phone">Phone</label>
      <input type="tel" id="phone" name="phone" />

      <label for="resume">Resume</label>
      <input type="file" id="resume" name="resume" />

      <label for="pretyped">Preferred name (TYPE SOMETHING HERE BEFORE FILLING)</label>
      <input type="text" id="pretyped" name="preferred_name" />

      <div class="danger">
        <label for="work_auth_de">Are you legally authorised to work in Germany?</label>
        <select id="work_auth_de" name="work_auth_de">
          <option value="">Select…</option><option>Yes</option><option>No</option>
        </select>

        <label for="no_sponsorship">Do you NOT require visa sponsorship?</label>
        <select id="no_sponsorship" name="no_sponsorship">
          <option value="">Select…</option><option>Yes</option><option>No</option>
        </select>

        <label for="attest">
          <input type="checkbox" id="attest" name="attest" />
          I certify under penalty of perjury that the information above is true.
        </label>
      </div>

      <p><button type="submit" id="final-submit">Submit application</button></p>
    </form>
  `);
}

/** An unrelated widget, deliberately MORE application-shaped than the real
 * application, with identically-named fields. It must receive nothing. */
export function adsPage() {
  return shell("Sponsored", "UNRELATED / AD FRAME", `
    <form id="lead-form" action="/submit" method="post">
      <label for="first_name">First name</label><input type="text" id="first_name" name="first_name" />
      <label for="last_name">Last name</label><input type="text" id="last_name" name="last_name" />
      <label for="email">Email</label><input type="email" id="email" name="email" />
      <label for="phone">Phone</label><input type="tel" id="phone" name="phone" />
      <label for="resume">Resume</label><input type="file" id="resume" name="resume" />
      <p><button type="submit">Get matched</button></p>
    </form>
  `);
}

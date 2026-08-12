/**
 * Two safety properties that must hold no matter what else changes:
 *
 * 1. The extension does no application-page work on XpertApply's own web app.
 *    If it scanned, observed, or autofilled there it would be mutating the very
 *    page the user is reading, which is both wrong and a plausible cause of
 *    render defects on XpertApply itself.
 *
 * 2. The user's XpertApply password never reaches an employer site, and no
 *    password is ever typed by the extension at all.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { JOBPILOT_WEB_ORIGINS, isApprovedJobPilotOrigin } from "../config";

function readSource(relative: string): string {
  return readFileSync(resolve(process.cwd(), relative), "utf8");
}

describe("XpertApply origin self-exclusion", () => {
  it("recognises every XpertApply origin", () => {
    for (const origin of ["http://localhost:3000", "http://127.0.0.1:3000", "https://app.jobpilot.ai"]) {
      expect(isApprovedJobPilotOrigin(origin), origin).toBe(true);
    }
  });

  it("does not treat an employer or look-alike origin as XpertApply", () => {
    for (const origin of [
      "https://boards.greenhouse.io",
      "https://jobs.lever.co",
      "https://app.jobpilot.ai.evil.test",
      "https://notapp.jobpilot.ai",
      "http://localhost:3001",
      "https://app.jobpilot.ai:8443"
    ]) {
      expect(isApprovedJobPilotOrigin(origin), origin).toBe(false);
    }
  });

  it("gates the two content-script roles on the origin, before any DOM work", () => {
    const bootstrap = readSource("src/content/bootstrap.ts");
    // The very first thing the script does is branch on the origin.
    const gate = bootstrap.indexOf("isApprovedJobPilotOrigin(location.origin)");
    const atsInit = bootstrap.indexOf("initAtsPage()");
    expect(gate).toBeGreaterThan(-1);
    expect(atsInit).toBeGreaterThan(gate);

    // The XpertApply-origin role is a message bridge only: it must not scan the
    // DOM for forms, observe mutations, or autofill.
    const webOriginRole = bootstrap.slice(
      bootstrap.indexOf("function initWebOrigin()"),
      bootstrap.indexOf("function validLaunch(")
    );
    for (const forbidden of [
      "resolveApplicationForm",
      "detectAdapter",
      "discoverAndFill",
      "runAutofill",
      "MutationObserver",
      "observeMutations",
      "createWidget",
      "classifyPage"
    ]) {
      expect(webOriginRole, `initWebOrigin must not call ${forbidden}`).not.toContain(forbidden);
    }
  });

  it("excludes XpertApply origins from the employer content script in the manifest", () => {
    const manifest = JSON.parse(readSource("manifest.json"));
    const employerScript = manifest.content_scripts.find((entry: { matches: string[] }) =>
      entry.matches.includes("https://*/*")
    );
    expect(employerScript).toBeTruthy();
    for (const origin of ["http://localhost:3000/*", "http://127.0.0.1:3000/*", "https://app.jobpilot.ai/*"]) {
      expect(employerScript.exclude_matches, origin).toContain(origin);
    }
  });

  it("keeps the manifest and the runtime allow-list in agreement", () => {
    const manifest = JSON.parse(readSource("manifest.json"));
    const employerScript = manifest.content_scripts.find((entry: { matches: string[] }) =>
      entry.matches.includes("https://*/*")
    );
    // Every origin the code trusts is also excluded from employer injection —
    // otherwise one of the two would silently drift.
    const excluded: string[] = employerScript.exclude_matches;
    for (const origin of JOBPILOT_WEB_ORIGINS) {
      expect(excluded.some((pattern) => pattern.startsWith(origin)), origin).toBe(true);
    }
  });

  it("keeps ATS host permissions intact", () => {
    const manifest = JSON.parse(readSource("manifest.json"));
    expect(manifest.host_permissions).toContain("https://*/*");
  });
});

describe("credential safety", () => {
  const bootstrap = readSource("src/content/bootstrap.ts");
  const client = readSource("src/api/client.ts");
  const background = readSource("src/background.ts");

  it("never types into a password field", () => {
    // The only password handling in the codebase is Workday's own encrypted
    // profile credential, which flows through the normal answer pipeline —
    // never through the login handler added for employer authentication.
    const authHandler = bootstrap.slice(
      bootstrap.indexOf("function prefillLoginEmail()"),
      bootstrap.indexOf("function reportUnsupportedListing(")
    );
    expect(authHandler).not.toMatch(/type="password"/);
    expect(authHandler).not.toMatch(/\bpassword\b/i);
  });

  it("prefills only an email/login identifier field", () => {
    const authHandler = bootstrap.slice(
      bootstrap.indexOf("function prefillLoginEmail()"),
      bootstrap.indexOf("function reportUnsupportedListing(")
    );
    expect(authHandler).toContain('input[type="email"]');
    expect(authHandler).toMatch(/email\\b\|\\busername\\b\|\\blogin\\b/);
    // Only fills an EMPTY field, so it never overwrites what the user typed.
    expect(authHandler).toContain("input.value.trim()");
  });

  it("never sends a password or the XpertApply login token to the API", () => {
    for (const [name, source] of [["client", client], ["background", background]] as const) {
      expect(source, `${name} must not post a password`).not.toMatch(/body:\s*JSON\.stringify\(\{[^}]*password/i);
    }
  });

  it("does not put the email itself in the auth message", () => {
    const messages = readSource("src/messages.ts");
    const block = messages.slice(messages.indexOf("MSG.EMPLOYER_AUTH_REQUIRED;"));
    expect(block).toContain("emailPrefilled: boolean");
    // A boolean flag, never the address.
    expect(block.slice(0, 400)).not.toMatch(/email:\s*string/);
  });

  it("never logs a token or a session token", () => {
    for (const [name, source] of [
      ["bootstrap", bootstrap],
      ["background", background],
      ["client", client]
    ] as const) {
      const logCalls = source.match(/log\.(debug|info|warn|error)\([^)]*\)/g) ?? [];
      for (const call of logCalls) {
        expect(call, `${name}: ${call}`).not.toMatch(/sessionToken|launchToken|handoffToken|\bpassword\b/);
      }
    }
  });

  it("does not create an employer account on its own", () => {
    // Nothing in the auth path clicks a create-account control; the phrase is
    // in the FORBIDDEN list for activation, and the handler only waits.
    const surface = readSource("src/ats/applicationSurface.ts");
    expect(surface).toMatch(/sign\\s\*\(in\|up\)/);
    const authHandler = bootstrap.slice(
      bootstrap.indexOf("async function handleEmployerAuth()"),
      bootstrap.indexOf("function stopAuthWatch()")
    );
    expect(authHandler).not.toMatch(/\.click\(\)/);
  });

  it("never bypasses CAPTCHA, MFA, passkey or SSO", () => {
    for (const term of ["captcha", "recaptcha", "hcaptcha", "passkey", "webauthn", "otp", "2fa"]) {
      expect(bootstrap.toLowerCase(), term).not.toContain(`${term}.click`);
    }
  });
});

describe("bounded field detection", () => {
  const bootstrap = readSource("src/content/bootstrap.ts");

  it("bounds the wait for a destination application", () => {
    // The invariant, not the mechanism: waiting for the application must have a
    // hard ceiling. (The attempt-counted backoff loop this used to assert was
    // replaced by mutation-driven readiness, because a fixed number of attempts
    // concluded "zero fields" before the destination had hydrated at all.)
    expect(bootstrap).toMatch(/APPLICATION_READINESS_TIMEOUT_MS\s*=\s*[\d_]+/);
    const ceiling = Number(
      bootstrap.match(/APPLICATION_READINESS_TIMEOUT_MS\s*=\s*([\d_]+)/)![1].replace(/_/g, "")
    );
    expect(ceiling).toBeGreaterThan(0);
    expect(ceiling).toBeLessThanOrEqual(60_000);
    expect(bootstrap).toContain("timeoutMs: APPLICATION_READINESS_TIMEOUT_MS");

    // And the wait itself must be genuinely terminal, never open-ended.
    const readiness = readSource("src/content/applicationReadiness.ts");
    expect(readiness).toContain("deadlineTimer = view.setTimeout(");
    expect(readiness).toContain("APPLICATION_DISCOVERY_TIMEOUT");
  });

  it("never leaves the widget on Detecting fields with no terminal outcome", () => {
    // The live blocker: the destination opened, the form hydrated, and the panel
    // stayed on "Detecting fields / Filled 0 of 0" indefinitely.
    expect(bootstrap).toContain("function reportDestinationFailure(");
    for (const code of [
      "APPLICATION_ROOT_NOT_FOUND",
      "APPLICATION_FRAME_UNAVAILABLE",
      "FIELD_DISCOVERY_RETURNED_ZERO",
      "APPLICATION_DISCOVERY_TIMEOUT"
    ]) {
      expect(readSource("src/content/applicationReadiness.ts"), code).toContain(code);
    }
  });

  it("no longer advertises an unbounded attempt counter to the user", () => {
    expect(bootstrap).not.toMatch(/Detecting fields \(attempt/);
  });

  it("classifies the page before polling for controls", () => {
    const loop = bootstrap.slice(
      bootstrap.indexOf("async function discoverAndFill("),
      bootstrap.indexOf("// Employer authentication (workstream 3)")
    );
    expect(loop.indexOf("classifyPage(document)")).toBeGreaterThan(-1);
    expect(loop.indexOf("classifyPage(document)")).toBeLessThan(loop.indexOf("detectAdapter("));
  });

  it("watches for hydration instead of polling a fixed number of times", () => {
    // A destination application routinely renders AFTER the content script
    // announces readiness, so a bounded poll that starts immediately can expire
    // before the form exists. Readiness is mutation-driven with a settling
    // window, and the old fixed backoff must not come back.
    const readiness = readSource("src/content/applicationReadiness.ts");
    expect(readiness).toContain("new MutationObserver(");
    expect(readiness).toContain("quietMs");
    expect(bootstrap).not.toMatch(/delay\(Math\.min\(250 \* 2 \*\* attempt, 2000\)\)/);
    expect(bootstrap).not.toContain("MAX_DISCOVERY_ATTEMPTS");
  });

  it("clicks an Apply CTA at most once per CTA fingerprint", () => {
    // Keyed on the control itself (url + role + accessible name), not merely on
    // the page: a client-side route change to the real application is a
    // different page that may legitimately need its own activation, while the
    // SAME control must never be clicked twice.
    expect(bootstrap).toContain("activatedFingerprints");
    expect(bootstrap).toContain("ctaFingerprint(candidate.element, location.href)");
    expect(bootstrap).toContain("activatedFingerprints.add(fingerprint)");
    expect(bootstrap).toMatch(/if \(activatedFingerprints\.has\(fingerprint\)\) \{/);
  });

  it("treats a dispatched click as unproven until a transition is observed", () => {
    // The defect this guards: `element.click()` throws nothing on a page that
    // ignores synthetic clicks, so "no exception" was mistaken for success.
    expect(bootstrap).toContain("const transition = await waitForTransition(before)");
    expect(bootstrap).toContain("offerUserGestureActivation()");
  });

  it("tries a validated URL destination BEFORE any synthetic click", () => {
    // The live failure: a script-dispatched click carries isTrusted:false and
    // a site may simply ignore it. Reading the destination is the only
    // strategy that does not depend on trusted input, so it must come first.
    const activation = bootstrap.slice(
      bootstrap.indexOf("async function activateApplicationSurfaceOnce()"),
      bootstrap.indexOf("let pendingManualCta")
    );
    const destinationAt = activation.indexOf("resolveApplyDestination(candidate.element");
    const dispatchAt = activation.indexOf("activateApplyCta(candidate.element");
    expect(destinationAt).toBeGreaterThan(-1);
    expect(dispatchAt).toBeGreaterThan(-1);
    expect(destinationAt).toBeLessThan(dispatchAt);
    // Navigation goes through the service worker, never chrome.tabs directly.
    expect(activation).toContain("MSG.ACTIVATE_APPLICATION_DESTINATION");
    expect(bootstrap).not.toContain("chrome.tabs.");
  });

  it("never reports a form timeout while still on the entry URL", () => {
    expect(bootstrap).toContain("const stillOnEntryUrl =");
    // Still on the page we started from means no application form could have
    // rendered yet, so the message must ask for the one real click instead of
    // blaming a form that was never opened.
    const report = bootstrap.slice(
      bootstrap.indexOf("function reportDestinationFailure("),
      bootstrap.indexOf("function recordDestinationReadiness(")
    );
    expect(report).toContain("Click once to open the application form.");
    expect(report).toContain("its form did not finish loading in time");
    expect(report.indexOf("canOpen")).toBeLessThan(report.indexOf("its form did not finish loading in time"));
  });

  it("dispatches a full pointer sequence rather than a bare click", () => {
    const pageState = readSource("src/ats/pageState.ts");
    for (const event of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
      expect(pageState, `activateApplyCta must dispatch ${event}`).toContain(`"${event}"`);
    }
    // The activation path must not fall back to a bare click as its PRIMARY
    // strategy — that is exactly what silently failed in production.
    const activation = bootstrap.slice(
      bootstrap.indexOf("async function activateApplicationSurfaceOnce()"),
      bootstrap.indexOf("let pendingManualCta")
    );
    expect(activation).toContain("activateApplyCta(candidate.element, document)");
    expect(activation).not.toMatch(/candidate\.element\.click\(\)/);
  });

  it("offers a manual fallback instead of a misleading form timeout", () => {
    expect(bootstrap).toContain("offerOpenApplication: true");
    expect(bootstrap).toContain("Click once to open the application form");
  });
});

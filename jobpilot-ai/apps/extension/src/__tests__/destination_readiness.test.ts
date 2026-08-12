/**
 * Destination-application readiness.
 *
 * The live blocker these tests encode: the "I'm interested" CTA opened the
 * destination application, the content script attached, the session rebound —
 * and the widget then sat on "Detecting fields / Filled 0 of 0" while the page
 * visibly contained a resume upload, first/last name, email, confirm email,
 * city, phone country code, phone number, Experience and Education.
 *
 * The destination hydrates AFTER the content script announces readiness, so a
 * single immediate scan sees zero applicant controls. Concluding from that scan
 * is the bug. Every test below is about that boundary.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  awaitApplicationReadiness,
  censusChildFrames,
  collectApplicationEvidence,
  hasApplicationEvidence
} from "../content/applicationReadiness";
import { discoverFields } from "../fields/discovery";
import { ResolutionRunCoordinator } from "../content/resolutionRun";

/** The destination form as the user actually sees it, once hydrated. */
const HYDRATED_APPLICATION = `
  <main>
    <h2>Personal information</h2>
    <form id="application">
      <label for="resume">Resume</label><input id="resume" name="resume" type="file" required>
      <label for="first">First name</label><input id="first" name="first_name" required>
      <label for="last">Last name</label><input id="last" name="last_name" required>
      <label for="email">Email</label><input id="email" name="email" type="email" required>
      <label for="confirm">Confirm email</label><input id="confirm" name="confirm_email" type="email" required>
      <label for="city">City</label><input id="city" name="city" required>
      <label for="country">Phone country code</label>
      <select id="country" name="phone_country"><option value="">Select</option><option value="+1">+1</option></select>
      <label for="phone">Phone number</label><input id="phone" name="phone" type="tel" required>
      <label for="linkedin">LinkedIn profile</label><input id="linkedin" name="linkedin" type="url">
      <h3>Experience</h3><button type="button">Add experience</button>
      <h3>Education</h3><button type="button">Add education</button>
    </form>
  </main>`;

/** The destination BEFORE hydration: a real page, but no application yet. */
const PRE_HYDRATION = `<main><div id="app"><p>Loading your application…</p></div></main>`;

function hydrate(html = HYDRATED_APPLICATION): void {
  document.body.innerHTML = html;
}

beforeEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = PRE_HYDRATION;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("application evidence", () => {
  it("finds nothing on a page whose application has not rendered yet", () => {
    const evidence = collectApplicationEvidence(document);
    expect(evidence.applicantControlCount).toBe(0);
    expect(hasApplicationEvidence(evidence)).toBe(false);
  });

  it("recognizes the live destination form once it hydrates", () => {
    hydrate();
    const evidence = collectApplicationEvidence(document);
    expect(evidence).toMatchObject({
      resumeUpload: true,
      nameFields: true,
      emailFields: true,
      phoneField: true,
      repeatableSectionControls: true,
      multiFieldForm: true,
      personalInformationHeading: true
    });
    expect(hasApplicationEvidence(evidence)).toBe(true);
  });

  it("never treats XpertApply's own widget as an application", () => {
    // Otherwise the extension proves its own premise and waits forever on a
    // page that has no employer form at all.
    document.body.innerHTML = `
      <div id="jobpilot-assisted-apply">
        <h2>Personal information</h2>
        <input name="first_name"><input name="last_name">
        <input name="email" type="email"><input name="phone" type="tel">
        <input type="file">
      </div>`;
    const evidence = collectApplicationEvidence(document);
    expect(evidence.applicantControlCount).toBe(0);
    expect(hasApplicationEvidence(evidence)).toBe(false);
  });
});

describe("bounded readiness", () => {
  it("returns immediately when the destination is already hydrated", async () => {
    hydrate();
    const result = await awaitApplicationReadiness({ timeoutMs: 2000, quietMs: 10 });
    expect(result.ready).toBe(true);
    expect(result.failureCode).toBeNull();
    expect(result.stage).toBe("APPLICATION_ROOT_FOUND");
    expect(result.fieldCount).toBeGreaterThan(0);
  });

  it("does not treat a zero-field scan before hydration as terminal", async () => {
    // THE regression. The content script is ready first; the form arrives after.
    const stages: string[] = [];
    const pending = awaitApplicationReadiness({
      timeoutMs: 3000,
      quietMs: 20,
      onStage: (stage) => stages.push(stage)
    });
    // Nothing to discover at this instant — and that must not decide anything.
    expect(collectApplicationEvidence(document).applicantControlCount).toBe(0);
    setTimeout(() => hydrate(), 60);

    const result = await pending;
    expect(result.ready).toBe(true);
    expect(result.failureCode).toBeNull();
    expect(stages).toContain("APPLICATION_ROOT_WAITING");
    expect(stages).toContain("APPLICATION_ROOT_FOUND");
    expect(result.fieldCount).toBeGreaterThan(0);
  });

  it("re-arms when the application root is replaced during hydration", async () => {
    const pending = awaitApplicationReadiness({ timeoutMs: 4000, quietMs: 60 });
    // A partial application: enough to be recognized, then remounted with the
    // full field set. Discovering the partial one would produce dead element
    // references and an undercount.
    setTimeout(() => hydrate(`<main><form id="application">
      <label for="a">First name</label><input id="a" name="first_name" required>
      <label for="b">Last name</label><input id="b" name="last_name" required>
      <label for="c">Email</label><input id="c" name="email" type="email" required>
      <label for="d">Phone number</label><input id="d" name="phone" type="tel" required>
    </form></main>`), 40);
    // A React remount swapping the whole application root mid-flight.
    setTimeout(() => hydrate(), 90);

    const result = await pending;
    expect(result.ready).toBe(true);
    expect(result.rootReplacements).toBeGreaterThan(0);
    // The FINAL form is what got measured, not the intermediate one.
    expect(collectApplicationEvidence(document).personalInformationHeading).toBe(true);
  });

  it("survives an SPA route transition that swaps the whole document body", async () => {
    const pending = awaitApplicationReadiness({ timeoutMs: 4000, quietMs: 20 });
    setTimeout(() => { document.body.innerHTML = "<main><h1>Loading route…</h1></main>"; }, 30);
    setTimeout(() => hydrate(), 80);
    const result = await pending;
    expect(result.ready).toBe(true);
  });

  it("stops at the deadline with an honest failure code, never a silent zero", async () => {
    const result = await awaitApplicationReadiness({ timeoutMs: 150, quietMs: 20 });
    expect(result.ready).toBe(false);
    expect(result.failureCode).toBe("APPLICATION_ROOT_NOT_FOUND");
    expect(result.elapsedMs).toBeGreaterThanOrEqual(150);
    // The stage names where it stopped rather than claiming success.
    expect(result.stage).not.toBe("FIELD_DISCOVERY_COMPLETED");
  });

  it("names an unreadable frame instead of reporting zero fields", async () => {
    document.body.innerHTML = `${PRE_HYDRATION}<iframe src="https://ats.example.test/apply"></iframe>`;
    // jsdom does not load the frame, so contentDocument is unavailable — the
    // same shape as a genuinely cross-origin application frame.
    Object.defineProperty(document.querySelector("iframe")!, "contentDocument", {
      configurable: true,
      get() { throw new Error("cross-origin"); }
    });

    const result = await awaitApplicationReadiness({ timeoutMs: 150, quietMs: 20 });
    expect(result.ready).toBe(false);
    expect(result.failureCode).toBe("APPLICATION_FRAME_UNAVAILABLE");
    expect(result.frames).toHaveLength(1);
    expect(result.frames[0]).toMatchObject({ accessible: false, origin: "https://ats.example.test" });
  });

  it("aggregates fields from a readable child frame", () => {
    document.body.innerHTML = `<iframe id="ats"></iframe>`;
    const frame = document.querySelector<HTMLIFrameElement>("#ats")!;
    frame.contentDocument!.body.innerHTML = HYDRATED_APPLICATION;

    const frames = censusChildFrames(document);
    expect(frames[0].accessible).toBe(true);
    expect(frames[0].applicantControlCount).toBeGreaterThan(0);
  });

  it("is ready as soon as a readable child frame holds the application", async () => {
    // Judging readiness on the top document alone means waiting out the entire
    // timeout and then reporting a failure for a form we can read perfectly
    // well — the "0 of 0" symptom wearing a different hat.
    document.body.innerHTML = `${PRE_HYDRATION}<iframe id="ats"></iframe>`;
    const frame = document.querySelector<HTMLIFrameElement>("#ats")!;
    frame.contentDocument!.body.innerHTML = HYDRATED_APPLICATION;

    const result = await awaitApplicationReadiness({ timeoutMs: 3000, quietMs: 20 });
    expect(result.ready).toBe(true);
    expect(result.failureCode).toBeNull();
    expect(result.evidenceLocation).toBe("frame");
    expect(result.elapsedMs).toBeLessThan(3000);
    expect(result.fieldCount).toBeGreaterThan(0);
  });
});

describe("destination run isolation", () => {
  it("gives the destination a fresh run id that invalidates the listing page's run", () => {
    // The listing tab and the destination tab are different observations of
    // different documents. A late resolver response from the listing run must
    // never be applied to destination fields.
    const runs = new ResolutionRunCoordinator();
    const listingRun = runs.begin("build-abc");
    expect(runs.accepts(listingRun.id)).toBe(true);

    const destinationRun = runs.begin("build-abc");
    expect(destinationRun.id).not.toBe(listingRun.id);
    expect(runs.accepts(destinationRun.id)).toBe(true);
    // The stale listing run is rejected outright, not merged.
    expect(runs.accepts(listingRun.id)).toBe(false);
  });

  it("treats a zero-field result as technical, never as a completed application", async () => {
    // "FIELD_DISCOVERY_RETURNED_ZERO" is a failure code, so it can never reach
    // the widget as a green "all caught up" with nothing filled.
    const result = await awaitApplicationReadiness({ timeoutMs: 120, quietMs: 20 });
    expect(result.ready).toBe(false);
    expect(result.failureCode).not.toBeNull();
    expect(["APPLICATION_ROOT_NOT_FOUND", "APPLICATION_FRAME_UNAVAILABLE", "FIELD_DISCOVERY_RETURNED_ZERO", "APPLICATION_DISCOVERY_TIMEOUT"])
      .toContain(result.failureCode);
  });
});

describe("discovery on the hydrated destination", () => {
  it("puts every visible scalar field into the inventory", () => {
    hydrate();
    const fields = discoverFields(document.querySelector("#application")!);
    const labels = fields.map((field) => `${field.label} ${field.ariaLabel} ${field.name}`.toLowerCase());

    // The widget said "Filled 0 of 0" beside exactly these controls.
    for (const expected of [
      "first", "last", "email", "confirm", "city", "phone_country", "phone"
    ]) {
      expect(labels.some((label) => label.includes(expected)), expected).toBe(true);
    }
    expect(fields.length).toBeGreaterThanOrEqual(7);
  });

  it("a visible application with applicant controls can never discover zero", () => {
    hydrate();
    const evidence = collectApplicationEvidence(document);
    const fields = discoverFields(document.querySelector("#application")!);
    // The invariant, stated directly: evidence present implies inventory > 0.
    expect(hasApplicationEvidence(evidence)).toBe(true);
    expect(fields.length).toBeGreaterThan(0);
  });
});

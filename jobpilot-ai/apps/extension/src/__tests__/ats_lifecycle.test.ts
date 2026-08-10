import { beforeEach, describe, expect, it } from "vitest";
import { AtsLifecycleRun, domMetrics, waitForAtsParse } from "../content/atsLifecycle";

beforeEach(() => { document.body.innerHTML = ""; history.replaceState({}, "", "/application"); });

describe("ATS resume-parse lifecycle", () => {
  it("detects async ATS mutations, settles, and counts the post-parse DOM", async () => {
    const form = document.createElement("form");
    form.innerHTML = '<input name="resume"><input name="old-auth">';
    document.body.appendChild(form);
    const run = new AtsLifecycleRun(66, "build-test");
    const waiting = waitForAtsParse(form, run.signal(), { quietWindowMs: 35, activityGraceMs: 15, maximumWaitMs: 500 });
    window.setTimeout(() => {
      form.innerHTML = '<input name="first" value="ATS"><textarea name="summary"></textarea><button role="combobox" aria-label="Work authorization"></button><section><h2>Projects</h2><button type="button">Add</button></section>';
    }, 5);
    const result = await waiting;
    expect(result.activityDetected).toBe(true);
    expect(result.reason).toBe("quiet_window");
    expect(result.fieldCountAfter).toBeGreaterThan(result.fieldCountBefore);
    expect(result.populatedAfter).toBe(1);
    expect(result.sectionCountAfter).toBe(1);
  });

  it("invalidates pre-parse tokens and accepts only the new DOM generation", () => {
    document.body.innerHTML = "<form id='application'></form>";
    const run = new AtsLifecycleRun(66, "build-test");
    const old = run.token();
    const current = run.invalidatePreParse("parse_finished");
    expect(run.accepts(old)).toBe(false);
    expect(run.accepts(current)).toBe(true);
    expect(current.domGeneration).toBe(1);
  });

  it("ignores a late pre-parse resolver result after post-parse rediscovery", async () => {
    const run = new AtsLifecycleRun(66, "build-test");
    const old = run.token();
    let ledgerState = "new-run";
    const late = Promise.resolve().then(() => {
      if (run.accepts(old)) ledgerState = "old-missing";
    });
    run.invalidatePreParse("parse_finished");
    await late;
    expect(ledgerState).toBe("new-run");
  });

  it("keeps every transition attributable without personal values", () => {
    const run = new AtsLifecycleRun(66, "build-test", "page-safe");
    run.transition("WAITING_FOR_ATS_PARSE", "resume_upload_committed", { scalarFields: 2 });
    const [entry] = run.trace();
    expect(entry).toMatchObject({ applicationSessionId: 66, extensionBuildId: "build-test", pageFingerprint: "page-safe", domGeneration: 0 });
    expect(JSON.stringify(entry)).not.toContain("resume text");
  });

  it("ignores JobPilot widget-only mutations", async () => {
    const form = document.createElement("form"); document.body.appendChild(form);
    const widget = document.createElement("div"); widget.id = "jobpilot-assisted-apply"; document.body.appendChild(widget);
    const run = new AtsLifecycleRun(66, "build-test");
    const waiting = waitForAtsParse(form, run.signal(), { quietWindowMs: 25, activityGraceMs: 20, maximumWaitMs: 200 });
    widget.appendChild(document.createElement("button"));
    const result = await waiting;
    expect(result.activityDetected).toBe(false);
    expect(result.reason).toBe("no_activity_observed");
  });

  it("reports current scalar, populated, and optional-section metrics", () => {
    document.body.innerHTML = '<form><input value="ATS"><input><section><h2>Awards</h2></section></form>';
    expect(domMetrics(document)).toMatchObject({ scalarFields: 2, populatedFields: 1, repeatableSections: 1 });
  });
});

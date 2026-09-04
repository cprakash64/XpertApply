/**
 * Stage 3B-R1 — the corrections Stage 3B's own Remaining Risks called for.
 *
 * Stage 3B proved compatibility by looking for CONTRADICTIONS: a foreign
 * country name from a finite list, an English negation token. Finding none, it
 * filled. Every test here attacks that shape of proof:
 *
 *   • a country the list has never heard of is not a US question;
 *   • a question in a language the patterns do not cover is not a US question;
 *   • "no negation found" is not "the question asks the thing affirmatively";
 *   • a timer expiring is not evidence about which frame holds the application.
 *
 * The invariant: a consequential answer requires POSITIVE evidence that the
 * question asks the matching thing. Absence of contradiction is not evidence.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { discoverFields } from "../fields/discovery";
import { buildMappings } from "../fields/mapping";
import { applyFill } from "../fields/runner";
import {
  checkSemanticCompatibility,
  countryFromJobLocation,
  detectPolarity,
  readJurisdiction
} from "../fields/answerSemantics";
import type { PendingLaunch } from "../messages";
import type { ApplicationSessionData, SessionAnswer } from "../types";

// --------------------------------------------------------------------------- //
// Fixtures
// --------------------------------------------------------------------------- //

function answer(canonical_key: string, value: string, extra: Partial<SessionAnswer> = {}): SessionAnswer {
  return {
    canonical_key, value, display_value: value, source: "profile",
    confidence: 1, sensitive: false, requires_review: false, verified: true, ...extra
  };
}

/** Profile truth: authorized in the US; does NOT require sponsorship. */
function session(jobLocation: string | null = "San Francisco, CA"): ApplicationSessionData {
  return {
    sessionId: 1,
    atsType: null,
    officialUrl: "https://boards.greenhouse.io/acme/1",
    jobTitle: "Backend Engineer",
    company: "Acme",
    jobLocation,
    unresolvedQuestions: [],
    answers: [
      answer("work_authorization_us", "Yes"),
      answer("sponsorship_required_now", "No"),
      answer("sponsorship_required_future", "No")
    ]
  };
}

async function fillSelect(question: string, options: string[], data = session()) {
  document.body.innerHTML = `<form id="app"><label for="q">${question}</label>` +
    `<select id="q" name="q" required><option value="">Select…</option>` +
    options.map((o) => `<option>${o}</option>`).join("") + `</select></form>`;
  const fields = discoverFields(document.querySelector("#app")!);
  const { mappings } = buildMappings(fields, data);
  await applyFill(fields, mappings, data);
  const value = (document.getElementById("q") as HTMLSelectElement).value;
  return { selected: value === "" ? null : value, mapping: mappings[0] };
}

const YES_NO = ["Yes", "No"];
const reasonOf = (mapping: { decision?: unknown }) =>
  (mapping.decision as { reason?: string } | undefined)?.reason;

// --------------------------------------------------------------------------- //
// XA-03 · jurisdiction requires positive proof
// --------------------------------------------------------------------------- //

describe("XA-03/R1 · a US answer requires the question to be established as US", () => {
  it("refuses a foreign country the recogniser has never heard of", async () => {
    // The Stage 3B gap exactly: not on the list, so no contradiction was found,
    // so the US answer was applied. An unlisted country must be indistinguishable
    // from any other failure to establish US — because it is one.
    for (const country of ["Uruguay", "Vietnam", "Ghana", "Kazakhstan", "Fiji"]) {
      const { selected, mapping } = await fillSelect(
        `Are you legally authorized to work in ${country}?`, YES_NO
      );
      expect(selected).toBeNull();
      expect(reasonOf(mapping)).toBe("JURISDICTION_UNKNOWN");
    }
  });

  it("refuses when the question names no country and the posting has no usable location", async () => {
    for (const location of [null, "", "Remote", "Multiple locations", "Anywhere"]) {
      const { selected, mapping } = await fillSelect(
        "Are you legally authorized to work?", YES_NO, session(location)
      );
      expect(selected).toBeNull();
      expect(reasonOf(mapping)).toBe("JURISDICTION_UNKNOWN");
    }
  });

  it("refuses a question naming two countries at once", async () => {
    const { selected, mapping } = await fillSelect(
      "Are you authorized to work in the United States or Canada?", YES_NO
    );
    expect(selected).toBeNull();
    expect(reasonOf(mapping)).toBe("JURISDICTION_AMBIGUOUS");
  });

  it("refuses when the question and the posting disagree", async () => {
    // The question outranks the posting: the employer asked about Germany.
    const { selected, mapping } = await fillSelect(
      "Are you legally authorized to work in Germany?", YES_NO, session("San Francisco, CA")
    );
    expect(selected).toBeNull();
    expect(reasonOf(mapping)).toBe("JURISDICTION_MISMATCH");
  });

  it("refuses wording in a language the recognisers do not cover", async () => {
    // No English negation, no listed country — the Stage 3B gate saw nothing to
    // object to. Not understanding the question is not permission to answer it.
    for (const question of [
      "Sind Sie berechtigt, in Deutschland zu arbeiten?",
      "¿Está usted autorizado para trabajar?",
      "Êtes-vous autorisé à travailler ?",
      "您是否有合法工作许可？",
      "Czy posiadasz pozwolenie na pracę?"
    ]) {
      const { selected } = await fillSelect(question, YES_NO);
      expect(selected).toBeNull();
    }
  });

  it("accepts a question that names the United States", async () => {
    const { selected } = await fillSelect(
      "Are you legally authorized to work in the United States?", YES_NO
    );
    expect(selected).toBe("Yes");
  });

  it("accepts a jurisdiction-silent question when the posting establishes the US", async () => {
    // The posting is trustworthy first-party metadata about the JOB — never
    // read from the employer's page.
    const { selected } = await fillSelect("Work Authorization", YES_NO, session("Austin, TX"));
    expect(selected).toBe("Yes");
  });

  it("refuses the same question when the posting establishes somewhere else", async () => {
    const { selected, mapping } = await fillSelect(
      "Work Authorization", YES_NO, session("Berlin, Germany")
    );
    expect(selected).toBeNull();
    expect(reasonOf(mapping)).toBe("JURISDICTION_MISMATCH");
  });

  it("reads a posting's location only when it establishes exactly one country", () => {
    expect(countryFromJobLocation("San Francisco, CA")).toBe("US");
    expect(countryFromJobLocation("Remote - United States")).toBe("US");
    expect(countryFromJobLocation("London, United Kingdom")).toBe("GB");
    expect(countryFromJobLocation("Berlin, Germany")).toBe("DE");
    // Not established:
    expect(countryFromJobLocation("Remote")).toBeNull();
    expect(countryFromJobLocation("")).toBeNull();
    expect(countryFromJobLocation(null)).toBeNull();
    expect(countryFromJobLocation("Multiple locations")).toBeNull();
    expect(countryFromJobLocation("London or New York")).toBeNull();
    expect(countryFromJobLocation("Kigali, Rwanda")).toBeNull();
  });

  it("never treats silence as proof, at the predicate level", () => {
    const silent = readJurisdiction("Are you legally authorized to work?", {});
    expect(silent.country).toBeNull();
    expect(silent.source).toBe("none");
  });
});

// --------------------------------------------------------------------------- //
// XA-04 · polarity requires positive proof
// --------------------------------------------------------------------------- //

describe("XA-04/R1 · polarity must be established, not merely un-contradicted", () => {
  const KEY = "sponsorship_required_future";

  it("classifies the four states distinctly", () => {
    expect(detectPolarity(KEY, "Will you now or in the future require sponsorship?")).toBe("affirmative");
    expect(detectPolarity(KEY, "I will not require sponsorship.")).toBe("negative");
    expect(detectPolarity(KEY, "Do you require sponsorship? You will not require sponsorship."))
      .toBe("ambiguous");
    expect(detectPolarity(KEY, "Benötigen Sie ein Visum-Sponsoring?")).toBe("unknown");
    expect(detectPolarity(KEY, "")).toBe("unknown");
  });

  it("refuses a question whose polarity it cannot read", async () => {
    for (const question of [
      "Benötigen Sie Visum-Sponsoring?",
      "¿Necesita patrocinio de visa?",
      "Sponsorship",
      "Visa?",
      "Please indicate your status regarding the above."
    ]) {
      const { selected, mapping } = await fillSelect(question, YES_NO);
      expect(selected).toBeNull();
      expect(["POLARITY_UNKNOWN", "JURISDICTION_UNKNOWN", "NO_VERIFIED_ANSWER"])
        .toContain(reasonOf(mapping));
    }
  });

  it("refuses explicit negation, double negation, without, and unless", async () => {
    for (const question of [
      "I do not now, nor in the future, will require sponsorship to work in the United States.",
      "Do you NOT require sponsorship now or in the future to work in the United States?",
      "Can you work in the United States without requiring sponsorship?",
      "Are you unable to work in the United States unless sponsorship is provided?"
    ]) {
      const { selected } = await fillSelect(question, YES_NO);
      expect(selected).toBeNull();
    }
  });

  it("refuses a truncated prompt that names the topic but asserts nothing", async () => {
    for (const question of ["Sponsorship required", "Visa sponsorship:", "Sponsorship status"]) {
      const { selected } = await fillSelect(question, YES_NO);
      expect(selected).toBeNull();
    }
  });

  it("refuses a prompt that asserts the thing and its opposite", async () => {
    const { selected, mapping } = await fillSelect(
      "Will you require sponsorship in the United States? Confirm you will not require sponsorship.",
      YES_NO
    );
    expect(selected).toBeNull();
    expect(reasonOf(mapping)).toBe("POLARITY_AMBIGUOUS");
  });

  it("still answers the combined present/future affirmative form", async () => {
    const { selected } = await fillSelect(
      "Will you now or in the future require sponsorship for employment visa status in the United States?",
      YES_NO
    );
    expect(selected).toBe("No");
  });

  it("does not let a preamble flip the question that follows it", () => {
    expect(detectPolarity(
      "work_authorization_us",
      "We do not discriminate. Are you legally authorized to work in the United States?"
    )).toBe("affirmative");
  });

  it("keeps 'without sponsorship' from negating an authorization question", () => {
    expect(detectPolarity(
      "work_authorization_us",
      "Are you legally authorized to work in the United States without sponsorship?"
    )).toBe("affirmative");
  });

  it("refuses polarity-unknown before jurisdiction is even consulted", () => {
    // Order matters for the diagnostic: an unreadable question is unreadable
    // whatever country it names.
    expect(checkSemanticCompatibility(KEY, "Visumsponsoring in den USA?", {}))
      .toEqual({ ok: false, reason: "POLARITY_UNKNOWN" });
  });
});

// --------------------------------------------------------------------------- //
// XA-05 · the demographic invariant, on the path that actually runs
//
// These are the guarantees `fields/eeoMapping.ts` advertised and never
// delivered — it consumed the backend's internal canonical tokens while the
// extension only ever receives display labels. Asserted here against the live
// buildMappings → applyFill path and the real contract.
// --------------------------------------------------------------------------- //

describe("XA-05/R1 · demographic answers fail closed on the live path", () => {
  const consented = (value: string) =>
    answer("race", value, { sensitive: true, source: "profile_eeo" });

  async function fillDemographic(question: string, options: string[], stored: string, multiple = false) {
    const data = session();
    data.answers.push(consented(stored));
    document.body.innerHTML = `<form id="app"><label for="q">${question}</label>` +
      `<select id="q" name="q"${multiple ? " multiple" : ""} required>` +
      `<option value="">Select…</option>${options.map((o) => `<option>${o}</option>`).join("")}</select></form>`;
    const fields = discoverFields(document.querySelector("#app")!);
    const { mappings } = buildMappings(fields, data);
    await applyFill(fields, mappings, data);
    const el = document.getElementById("q") as HTMLSelectElement;
    return { selected: el.value === "" ? null : el.value, mapping: mappings[0] };
  }

  it("fills when exactly one option says the same thing", async () => {
    const { selected } = await fillDemographic(
      "Please select your race/ethnicity", ["Asian", "White", "Decline to self-identify"], "Asian"
    );
    expect(selected).toBe("Asian");
  });

  it("refuses when no option means the same thing", async () => {
    const { selected, mapping } = await fillDemographic(
      "Please select your race/ethnicity", ["Group A", "Group B"], "Asian"
    );
    expect(selected).toBeNull();
    expect(reasonOf(mapping)).toBe("DEMOGRAPHIC_NO_EXACT_OPTION");
  });

  it("refuses when two options match the same stored value", async () => {
    const { selected, mapping } = await fillDemographic(
      "Please select your race/ethnicity", ["Asian", "Asian", "White"], "Asian"
    );
    expect(selected).toBeNull();
    expect(reasonOf(mapping)).toBe("DEMOGRAPHIC_AMBIGUOUS_OPTION");
  });

  it("refuses to squeeze several stored values into a single-select", async () => {
    const { selected, mapping } = await fillDemographic(
      "Please select your race/ethnicity", ["Asian", "White"], "Asian|White"
    );
    expect(selected).toBeNull();
    expect(reasonOf(mapping)).toBe("DEMOGRAPHIC_MULTI_VALUE_IN_SINGLE_SELECT");
  });

  it("never collapses two different veteran answers into one", async () => {
    // "not a protected veteran" and "not a veteran" are different answers.
    const data = session();
    data.answers.push(answer("veteran_status", "I am not a protected veteran", { sensitive: true, source: "profile_eeo" }));
    document.body.innerHTML = `<form id="app"><label for="q">Are you a protected veteran?</label>` +
      `<select id="q" name="q" required><option value="">Select…</option>` +
      `<option>I am not a veteran</option><option>Decline to self-identify</option></select></form>`;
    const fields = discoverFields(document.querySelector("#app")!);
    const { mappings } = buildMappings(fields, data);
    await applyFill(fields, mappings, data);
    expect((document.getElementById("q") as HTMLSelectElement).value).toBe("");
  });

  it("equates a stored decline with however the employer words it", async () => {
    const { selected } = await fillDemographic(
      "Please select your race/ethnicity",
      ["Asian", "White", "Decline to self-identify"],
      "Prefer not to answer"
    );
    expect(selected).toBe("Decline to self-identify");
  });
});

// --------------------------------------------------------------------------- //
// §12 · the fieldset/legend classification gap
// --------------------------------------------------------------------------- //

describe("fieldset/legend work-authorization question", () => {
  it("fails closed rather than asserting anything", async () => {
    // With the question in a <legend>, the radio's own label is "Yes" and the
    // word "country" in the legend wins the keyword race, so the control is
    // classified `country` rather than work_authorization_us. That is a
    // CLASSIFICATION defect, but it cannot produce a false assertion: there is
    // no `country` answer that is a valid Yes/No option, so nothing is written.
    document.body.innerHTML = `<form id="app"><fieldset>
      <legend>Are you legally authorized to work in the country where the job is located?</legend>
      <label><input type="radio" name="q" id="q_0" value="Yes" required> Yes</label>
      <label><input type="radio" name="q" id="q_1" value="No"> No</label>
    </fieldset></form>`;
    const data = session();
    data.answers.push(answer("country", "United States"));
    const fields = discoverFields(document.querySelector("#app")!);
    const { mappings } = buildMappings(fields, data);
    await applyFill(fields, mappings, data);
    expect(document.querySelector('input[name="q"]:checked')).toBeNull();
  });
});

// --------------------------------------------------------------------------- //
// §8/§9 · the fill lease needs positive frame selection
// --------------------------------------------------------------------------- //

type Listener = (raw: unknown, sender: unknown, sendResponse: (r: unknown) => void) => boolean | void;

const APPLICATION_URL = "https://careers.acme.com/jobs/1/apply";

function launch(): PendingLaunch {
  return {
    version: 1, applicationId: "1", jobId: "1", applicationUrl: APPLICATION_URL,
    status: "prepared", handoffToken: "t", requestId: "r", sessionId: 1, launchToken: "t",
    officialUrl: APPLICATION_URL, expectedOrigin: "https://careers.acme.com",
    createdAt: Date.now(), expiresAt: Date.now() + 900_000,
    state: "package_ready", protocolVersion: 3, atsType: null
  };
}

function installFakeChrome() {
  const store: Record<string, unknown> = {};
  const messageListeners: Listener[] = [];
  (globalThis as unknown as { chrome: unknown }).chrome = {
    runtime: {
      onInstalled: { addListener: () => undefined },
      onMessage: { addListener: (fn: Listener) => messageListeners.push(fn) },
      lastError: undefined,
      getManifest: () => ({ update_url: undefined, version: "0.2.0" })
    },
    storage: {
      local: {
        get: async (key: string) => ({ [key]: store[key] }),
        set: async (obj: Record<string, unknown>) => Object.assign(store, obj),
        remove: async (key: string) => { delete store[key]; }
      }
    },
    tabs: {
      onRemoved: { addListener: () => undefined }, onUpdated: { addListener: () => undefined },
      onCreated: { addListener: () => undefined },
      create: vi.fn(async () => ({ id: 9 })), get: vi.fn(async () => { throw new Error("none"); }),
      update: vi.fn(async () => ({})), query: vi.fn(async () => []),
      sendMessage: vi.fn((_t: number, _m: unknown, cb?: (r: unknown) => void) => cb?.(undefined))
    },
    windows: { update: vi.fn(async () => ({})) },
    scripting: { executeScript: vi.fn(async () => undefined) },
    permissions: { contains: vi.fn(async () => true), request: vi.fn(async () => true) },
    sidePanel: { setPanelBehavior: vi.fn(async () => undefined) }
  };
  return { messageListeners };
}

function sender(frameId: number, url = APPLICATION_URL) {
  return { tab: { id: 7, url: APPLICATION_URL }, frameId, url } as unknown as chrome.runtime.MessageSender;
}

function dispatch(listeners: Listener[], raw: unknown, from: unknown): Promise<unknown> {
  return new Promise((resolve) => {
    let done = false;
    for (const fn of listeners) {
      const keep = fn(raw, from, (r) => { if (!done) { done = true; resolve(r); } });
      if (!keep && !done) continue;
    }
  });
}

type Lease = { granted: boolean; reason: string };

describe("fill lease · only a positively selected frame fills", () => {
  beforeEach(() => { vi.resetModules(); });
  afterEach(() => { vi.unstubAllGlobals(); });

  async function bootWorker() {
    const { messageListeners } = installFakeChrome();
    const state = await import("../state");
    await state.putPending(7, launch());
    const bg = await import("../background");
    return { messageListeners, bg };
  }

  const ask = (listeners: Listener[], frameId: number, rootConfident = true, url?: string) =>
    dispatch(listeners, { type: "JOBPILOT_REQUEST_FILL_LEASE", rootConfident }, sender(frameId, url)) as Promise<Lease>;

  it("A · grants to the top frame that resolved the application", async () => {
    const { messageListeners } = await bootWorker();
    expect(await ask(messageListeners, 0)).toMatchObject({ granted: true, reason: "TOP_FRAME" });
  });

  it("B · refuses a same-origin sibling once the top frame owns the application", async () => {
    const { messageListeners, bg } = await bootWorker();
    bg.registerFrameProbe(7, 0, {
      isTopFrame: true, sanitizedUrl: APPLICATION_URL, rootConfident: true,
      applicationLabelsFound: ["first_name", "email"], bestScore: 40
    });
    expect(await ask(messageListeners, 3, true, "https://careers.acme.com/vendor-widget"))
      .toMatchObject({ granted: false, reason: "TOP_FRAME_OWNS_APPLICATION" });
  });

  it("C · refuses an unrelated cross-origin frame (Stage 3A gate still first)", async () => {
    const { messageListeners, bg } = await bootWorker();
    bg.registerFrameProbe(7, 0, {
      isTopFrame: true, sanitizedUrl: APPLICATION_URL, rootConfident: true,
      applicationLabelsFound: [], bestScore: 40
    });
    const lease = await ask(messageListeners, 4, true, "https://ads.doubleclick.net/apply");
    expect(lease.granted).toBe(false);
    expect(lease.reason).toBe("FRAME_ORIGIN_NOT_IN_WORKFLOW");
  });

  it("D · grants to an embedded ATS when the top frame holds no application", async () => {
    const { messageListeners, bg } = await bootWorker();
    bg.registerFrameProbe(7, 0, {
      isTopFrame: true, sanitizedUrl: APPLICATION_URL, rootConfident: false,
      applicationLabelsFound: [], bestScore: 2
    });
    bg.registerFrameProbe(7, 5, {
      isTopFrame: false, sanitizedUrl: "https://boards.greenhouse.io/e/1", rootConfident: true,
      applicationLabelsFound: ["first_name", "email", "resume"], bestScore: 55
    });
    expect(await ask(messageListeners, 5, true, "https://boards.greenhouse.io/e/1"))
      .toMatchObject({ granted: true, reason: "EMBEDDED_APPLICATION" });
  });

  it("E/H · a missing or slow frame-0 probe never authorizes a nested fill", async () => {
    // THE Stage 3B gap: the two-second wait expired and the nested frame was
    // granted. A timer elapsing says nothing about the top frame.
    const { messageListeners } = await bootWorker();
    const lease = await ask(messageListeners, 6, true, "https://boards.greenhouse.io/e/1");
    expect(lease).toMatchObject({ granted: false, reason: "FRAME_SELECTION_UNRESOLVED" });
  }, 20_000);

  it("F · refuses both when two nested frames are equally plausible", async () => {
    const { messageListeners, bg } = await bootWorker();
    bg.registerFrameProbe(7, 0, {
      isTopFrame: true, sanitizedUrl: APPLICATION_URL, rootConfident: false,
      applicationLabelsFound: [], bestScore: 1
    });
    for (const frameId of [5, 6]) {
      bg.registerFrameProbe(7, frameId, {
        isTopFrame: false, sanitizedUrl: `https://careers.acme.com/embed/${frameId}`,
        rootConfident: true, applicationLabelsFound: ["first_name", "email"], bestScore: 50
      });
    }
    const lease = await ask(messageListeners, 5, true, "https://careers.acme.com/embed/5");
    expect(lease).toMatchObject({ granted: false, reason: "FRAME_SELECTION_AMBIGUOUS" });
  });

  it("F · picks the strictly better frame when the evidence names one", async () => {
    const { messageListeners, bg } = await bootWorker();
    bg.registerFrameProbe(7, 0, {
      isTopFrame: true, sanitizedUrl: APPLICATION_URL, rootConfident: false,
      applicationLabelsFound: [], bestScore: 1
    });
    bg.registerFrameProbe(7, 5, {
      isTopFrame: false, sanitizedUrl: "https://careers.acme.com/embed/5", rootConfident: true,
      applicationLabelsFound: ["first_name", "email", "resume"], bestScore: 80
    });
    bg.registerFrameProbe(7, 6, {
      isTopFrame: false, sanitizedUrl: "https://careers.acme.com/embed/6", rootConfident: true,
      applicationLabelsFound: ["email"], bestScore: 20
    });
    expect(await ask(messageListeners, 5, true, "https://careers.acme.com/embed/5"))
      .toMatchObject({ granted: true });
    expect(await ask(messageListeners, 6, true, "https://careers.acme.com/embed/6"))
      .toMatchObject({ granted: false });
  });

  it("G · refuses when nothing anywhere resolved an application", async () => {
    const { messageListeners, bg } = await bootWorker();
    bg.registerFrameProbe(7, 0, {
      isTopFrame: true, sanitizedUrl: APPLICATION_URL, rootConfident: false,
      applicationLabelsFound: [], bestScore: 0
    });
    expect(await ask(messageListeners, 5, false, "https://careers.acme.com/embed/5"))
      .toMatchObject({ granted: false, reason: "FRAME_SELECTION_UNRESOLVED" });
  });

  it("refuses a lease for a tab with no active launch", async () => {
    installFakeChrome();
    const { messageListeners } = installFakeChrome();
    await import("../background");
    expect(await ask(messageListeners, 0)).toMatchObject({ granted: false, reason: "NO_ACTIVE_LAUNCH" });
  });
});

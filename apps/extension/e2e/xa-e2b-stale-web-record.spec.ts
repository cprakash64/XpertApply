import { expect, test } from "@playwright/test";
import { overlayCdp } from "./overlay-cdp";
import { PROFILES, directDrafts, employerTls, launchSignedIn, startDirectApi, submitsUntouched } from "./xa-core1-harness";

/**
 * EXT-E2B: the worker remembers the account and deployment of the LAST website launch. A direct draft was not launched by the
 * website, yet that old record was held against it: with the website last signed in as another account, or pointed at another
 * deployment, the run was refused before it read the form and the assistant sat on "Detecting… / Preparing…" with the generic
 * preparation error. A direct draft belongs to the extension's own account, so the record must not apply to it.
 */
const RECORDS: Array<[string, Record<string, unknown>]> = [
  ["the website was last signed in as another account", { webEnvironment: "unknown", webApiBase: null, webAuthenticatedUserId: 9 }],
  ["the website was last on another deployment", { webEnvironment: "staging", webApiBase: "https://api-staging.xpertapply.com", webAuthenticatedUserId: null }]
];

for (const [name, record] of RECORDS) {
  test(`a direct application is filled although ${name}`, async () => {
    test.setTimeout(120_000);
    const tls = await employerTls();
    const api = await startDirectApi();
    const b = await launchSignedIn({ api, tls });
    try {
      await b.worker.evaluate((value) => chrome.storage.local.set({ jobpilotWebRuntimeV2: value }), record);
      const p = await b.ctx.newPage();
      await p.goto("https://careers.withwaymo.com/jobs/ml-engineer/apply");
      await p.click("#apply-now");
      await expect.poll(() => p.inputValue("#first_name"), { timeout: 45_000 }).toBe(PROFILES[7].first_name);
      await expect.poll(() => p.inputValue("#email"), { timeout: 15_000 }).toBe(PROFILES[7].email);
      expect(directDrafts(api)).toHaveLength(1);
      const ov = overlayCdp(p);
      expect((await ov.text("#errors")) ?? "").toBe("");
      // The label is updated by the worker's next view push, which can trail the last field write by a round trip. It must resolve (not stay
      // stuck on "Detecting…"); Measured 4-15 ms over 30 runs.
      await expect.poll(async () => (await ov.text("#ats")) ?? "", { timeout: 15_000 }).not.toBe("Detecting…");
      expect(await submitsUntouched(p)).toEqual({ submits: 0, clicks: 0 });
    } finally { await b.close(); tls.server.close(); await api.close(); }
  });
}

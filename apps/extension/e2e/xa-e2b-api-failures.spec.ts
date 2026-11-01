import { expect, test } from "@playwright/test";
import { overlayCdp } from "./overlay-cdp";
import { employerTls, launchSignedIn, startDirectApi } from "./xa-core1-harness";

/**
 * EXT-E2B: a backend refusal while a direct application is being prepared ends in a stated, actionable assistant, never a spinner and
 * never the generic error. Staging runs the same routes as this owned mock; 401 means the credential is gone, anything else is an outage.
 */
const PREPARE = /couldn.t prepare this application/i;
const NOT_CONNECTED = /isn.t connected/i;
const CASES: Array<[string, (api: Awaited<ReturnType<typeof startDirectApi>>) => void, RegExp]> = [
  ["direct draft 500", (api) => { api.state.failDirect = true; api.state.directStatus = 500; }, PREPARE],
  ["direct draft 404", (api) => { api.state.failDirect = true; api.state.directStatus = 404; }, PREPARE],
  ["direct draft 403", (api) => { api.state.failDirect = true; api.state.directStatus = 403; }, PREPARE],
  ["direct draft 422", (api) => { api.state.failDirect = true; api.state.directStatus = 422; }, PREPARE],
  ["package fetch 403", (api) => { api.state.failSessions = true; api.state.sessionStatus = 403; }, PREPARE],
  ["package fetch 500", (api) => { api.state.failSessions = true; api.state.sessionStatus = 500; }, PREPARE],
  ["package fetch 401", (api) => { api.state.failSessions = true; api.state.sessionStatus = 401; }, NOT_CONNECTED]
];

for (const [name, arrange, message] of CASES) {
  test(`${name}: the assistant says what happened and nothing is filled`, async () => {
    test.setTimeout(90_000);
    const tls = await employerTls();
    const api = await startDirectApi();
    const b = await launchSignedIn({ api, tls });
    try {
      arrange(api);
      const p = await b.ctx.newPage();
      await p.goto("https://careers.withwaymo.com/jobs/ml-engineer/apply");
      await p.click("#apply-now");
      await expect(p.locator("#xpertapply-assistant-overlay-v1")).toHaveCount(1, { timeout: 30_000 });
      const ov = overlayCdp(p);
      await expect.poll(async () => (await ov.text("#errors")) ?? "", { timeout: 30_000 }).toMatch(message);
      expect((await ov.text("#errors")) ?? "").not.toMatch(/something went wrong while preparing/i);
      expect(await ov.text("#ats")).not.toBe("Detecting…");
      expect(await ov.text("#resume")).not.toBe("Preparing…");
      expect(await p.inputValue("#first_name")).toBe("");
    } finally { await b.close(); tls.server.close(); await api.close(); }
  });
}

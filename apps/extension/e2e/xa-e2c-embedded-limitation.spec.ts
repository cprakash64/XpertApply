import { expect, test } from "@playwright/test";
import { directDrafts, employerTls, launchSignedIn, overlayCount, startDirectApi } from "./xa-core1-harness";

/**
 * EXT-E2C, DOCUMENTED LIMITATION (not a feature): an application form that lives in a CROSS-ORIGIN IFRAME of a careers page, opened
 * directly with no website launch, is not supported. A direct draft is created only from a top-frame form (judgeApplicationEvidence
 * on the top frame, background.ts resolveDirectApplication), so this page gets no draft, no assistant, no request to XpertApply, and
 * the embedded frame receives nothing. Supporting it needs a separately reviewed design for per-frame grants; this test pins the
 * current, safe behavior so the limitation cannot silently become a data path.
 */
const EMBED = "https://job-boards.greenhouse.io/embed/job_app?for=sample&token=1";
const page = (host: string, url: string): string | null => {
  const u = new URL(url, "https://x");
  if (host === "careers.withwaymo.com" && u.pathname === "/careers/job") {
    return `<!doctype html><meta charset="utf-8"><title>Careers</title><main><h1>Engineer</h1><p>Description.</p><iframe id="gh" src="${EMBED}" width="800" height="700"></iframe></main>`;
  }
  if (host === "job-boards.greenhouse.io" && u.pathname === "/embed/job_app") {
    return `<!doctype html><meta charset="utf-8"><title>Embedded application</title><form id="application-form"><label for="first_name">First Name</label><input id="first_name"><label for="last_name">Last Name</label><input id="last_name"><label for="email">Email</label><input id="email" type="email"><label for="resume">Resume/CV</label><input id="resume" type="file"><button type="submit">Submit application</button></form>`;
  }
  return null;
};

test("a cross-origin embedded application opened directly gets no draft, no assistant and no data, and nothing is submitted", async () => {
  test.setTimeout(120_000);
  const tls = await employerTls([], page);
  const api = await startDirectApi();
  const b = await launchSignedIn({ api, tls });
  try {
    const p = await b.ctx.newPage();
    await p.goto("https://careers.withwaymo.com/careers/job?gh_jid=1");
    const frame = p.frameLocator("#gh");
    await expect(frame.locator("#first_name")).toBeVisible({ timeout: 15_000 });
    await p.waitForTimeout(12_000);
    expect(directDrafts(api)).toHaveLength(0);
    expect(api.log).toEqual([]);
    expect(await overlayCount(p)).toBe(0);
    expect(await frame.locator("#first_name").inputValue()).toBe("");
    expect(await frame.locator("#email").inputValue()).toBe("");
  } finally { await b.close(); tls.server.close(); await api.close(); }
});

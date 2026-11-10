import { expect, type Page } from "@playwright/test";
import { overlayCdp } from "./overlay-cdp";
import { launchFromWebsite } from "./cws-p1-launch-harness";
import { site } from "./employer-site";
import { ANSWERS, URL_, PROFILE, keyFor } from "./workday-shared";

/** Shared driver helpers for the Workday specs (EXT-LIVE-07). Same behaviour as the helpers in workday-fidelity.spec.ts. */
export async function launch(s: Awaited<ReturnType<typeof site>>, id: number, extra: Record<string, unknown> = {}) {
  return launchFromWebsite({
    html: "<!doctype html><title>unused</title>", sessionId: id, atsType: "workday", officialUrl: URL_, launchArgs: s.args,
    profile: { ...PROFILE, ...extra }, answers: ANSWERS, keyFor, jobTitle: "Engineer", company: "Acme", location: "Phoenix, AZ, United States"
  });
}
export type Emp = { signedIn: boolean; step: number; vals: Record<string, string>; work: any[]; edu: any[]; sites: any[]; resume: string; clicks: Record<string, number>; visited: string[]; err: number; errLabels: string[] };
export const emp = (p: Page) => p.evaluate(() => (window as unknown as { __emp: unknown }).__emp as Emp);
export const startReady = (ov: ReturnType<typeof overlayCdp>) => ov.evaluateWidget((r) => (r.querySelector<HTMLElement>('[data-w="start"]')?.style.display ?? "none") !== "none");
export const clickWidget = (ov: ReturnType<typeof overlayCdp>, w: string) => ov.evaluateWidget((r, name) => r.querySelector<HTMLButtonElement>(`[data-w="${name}"]`)!.click(), w);
export const status = (ov: ReturnType<typeof overlayCdp>) => ov.evaluateWidget((r) => r.querySelector('[data-w="status"]')?.textContent ?? "");

/** What the person would SEE for each rendered work/education row, read from the live DOM (not from the fixture's model). */
export async function visibleRows(p: Page) {
  return p.evaluate(() => {
    const q = (e: Element, sel: string) => (e.querySelector<HTMLInputElement>(sel)?.value ?? "");
    const work = Array.from(document.querySelectorAll('[data-automation-id^="workExperience-"]')).filter((e) => /-\d+$/.test(e.getAttribute("data-automation-id")!)).map((e) => ({
      title: q(e, '[data-automation-id="jobTitle"]'), company: q(e, '[data-automation-id="companyName"]'), location: q(e, '[data-automation-id="location"]'),
      current: Boolean(e.querySelector<HTMLInputElement>('[data-automation-id="currentlyWorkHere"]')?.checked),
      from: `${q(e, '[data-automation-id="startDate"] [data-automation-id="dateSectionMonth-input"]')}/${q(e, '[data-automation-id="startDate"] [data-automation-id="dateSectionYear-input"]')}`,
      to: e.querySelector('[data-automation-id="endDate"]') ? `${q(e, '[data-automation-id="endDate"] [data-automation-id="dateSectionMonth-input"]')}/${q(e, '[data-automation-id="endDate"] [data-automation-id="dateSectionYear-input"]')}` : "(hidden)",
      description: (e.querySelector<HTMLTextAreaElement>('[data-automation-id="roleDescription"]')?.value ?? "")
    }));
    const edu = Array.from(document.querySelectorAll('[data-automation-id^="education-"]')).filter((e) => /-\d+$/.test(e.getAttribute("data-automation-id")!)).map((e) => ({
      school: Array.from(e.querySelectorAll('[data-automation-id="school"] [data-automation-id="selectedItem"]')).map((x) => x.textContent).join("|"),
      degree: (e.querySelector('[data-automation-id="degree"]')?.textContent ?? "").trim(),
      major: Array.from(e.querySelectorAll('[data-automation-id="fieldOfStudy"] [data-automation-id="selectedItem"]')).map((x) => x.textContent).join("|"),
      gpa: q(e, '[data-automation-id="gradeAverage"]'), from: q(e, '[data-automation-id="firstYearAttended"] input'), to: q(e, '[data-automation-id="lastYearAttended"] input')
    }));
    const sites = Array.from(document.querySelectorAll('[data-automation-id^="website-"]')).filter((e) => /-\d+$/.test(e.getAttribute("data-automation-id")!)).map((e) => q(e, '[data-automation-id="url"]'));
    return { work, edu, sites };
  });
}

export async function begin(h: Awaited<ReturnType<typeof launch>>) {
  const { empPage } = await h.start();
  await expect(empPage.locator("#xpertapply-assistant-overlay-v1")).toHaveCount(1, { timeout: 45_000 });
  const ov = overlayCdp(empPage);
  return { empPage, ov };
}


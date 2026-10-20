import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";

const OUT = process.argv[2] ?? "/private/tmp/claude-501/-Users-cprakash-Documents-Jobs-XpertApply/4e188323-3d89-4501-b8ba-132b4b1de912/scratchpad/shots";
mkdirSync(OUT, { recursive: true });

const BASE = "http://localhost:3111";
const VIEWPORTS = [
  { name: "1440x900", width: 1440, height: 900 },
  { name: "1366x768", width: 1366, height: 768 },
  { name: "1280x800", width: 1280, height: 800 },
  { name: "tablet-820", width: 820, height: 1180 },
  { name: "mobile-390", width: 390, height: 844 }
];

const browser = await chromium.launch();
const report = [];

for (const vp of VIEWPORTS) {
  const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
  const page = await ctx.newPage();
  const errors = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));

  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.addStyleTag({ content: "html{scroll-behavior:auto !important}" });

  const overflow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
    bodyScrollWidth: document.body.scrollWidth,
    offenders: [...document.querySelectorAll("body *")]
      .filter((el) => el.getBoundingClientRect().right > document.documentElement.clientWidth + 1)
      .slice(0, 6)
      .map((el) => `${el.tagName}.${el.className}`.slice(0, 90))
  }));

  await page.screenshot({ path: `${OUT}/${vp.name}-01-hero.png` });

  // Walk the six stages by scrolling each to the viewport midline.
  const stageInfo = [];
  const ids = ["discover", "understand", "prepare", "connect", "apply", "track"];
  for (let i = 0; i < ids.length; i++) {
    await page.evaluate((id) => {
      const el = document.getElementById(`stage-${id}`);
      const r = el.getBoundingClientRect();
      window.scrollTo(0, window.scrollY + r.top + r.height / 2 - window.innerHeight / 2);
    }, ids[i]);
    await page.waitForTimeout(450);
    const state = await page.evaluate(() => {
      const story = document.querySelector(".xa-story");
      const active = document.querySelector('.xa-stage[data-state="active"]');
      const current = document.querySelector('.xa-controller__item[aria-current="true"]');
      const sidebar = document.querySelector(
        '.xa-story__sticky .xa-mock__nav-item[data-current="true"]'
      );
      const mock = document.querySelector(".xa-story__sticky .xa-mock");
      const controller = document.querySelector(".xa-controller");
      const cs = getComputedStyle(story);
      return {
        active: active?.id ?? null,
        controller: current?.textContent ?? null,
        sidebar: sidebar?.textContent ?? null,
        progress: Number(cs.getPropertyValue("--xa-progress")).toFixed(3),
        railColor: cs.getPropertyValue("--rail-progress-color").trim(),
        workspace: document.querySelector(".xa-story__sticky .xa-mock__head h4")?.textContent,
        mockBottom: mock ? Math.round(mock.getBoundingClientRect().bottom) : null,
        controllerBottom: controller
          ? Math.round(controller.getBoundingClientRect().bottom)
          : null,
        viewportH: window.innerHeight
      };
    });
    stageInfo.push({ stage: ids[i], ...state });
    if (i === 0 || i === 3 || i === 5) {
      await page.screenshot({ path: `${OUT}/${vp.name}-02-stage-${ids[i]}.png` });
    }
  }

  // Extension + trust + footer
  await page.evaluate(() => document.getElementById("extension").scrollIntoView());
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}/${vp.name}-03-extension.png` });

  await page.evaluate(() => document.getElementById("security").scrollIntoView());
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}/${vp.name}-04-security.png` });

  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}/${vp.name}-05-footer.png` });

  // Pricing modal
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(200);
  const pricingBtn = page.getByRole("button", { name: "Pricing" }).first();
  let pricingOk = null;
  try {
    if (vp.width < 900) {
      await page.getByRole("button", { name: "Open menu" }).click();
      await page.waitForTimeout(200);
    }
    await pricingBtn.click();
    await page.waitForTimeout(350);
    pricingOk = await page.evaluate(() => !!document.querySelector('[role="dialog"]'));
    await page.screenshot({ path: `${OUT}/${vp.name}-06-pricing.png` });
    await page.keyboard.press("Escape");
    await page.waitForTimeout(200);
  } catch (e) {
    pricingOk = `error: ${e.message.split("\n")[0]}`;
  }

  report.push({ viewport: vp.name, overflow, pricingOk, errors, stages: stageInfo });
  await ctx.close();
}

await browser.close();
console.log(JSON.stringify(report, null, 1));

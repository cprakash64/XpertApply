import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const readme = readFileSync(resolve(process.cwd(), "README.md"), "utf8");

function documentationErrors(text: string): string[] {
  const errors: string[] = [];
  if (/requires access to all HTTPS sites/i.test(text)) errors.push("blanket HTTPS access");
  if (/host permissions are restricted to the supported ATS hosts/i.test(text)) errors.push("fixed ATS allowlist");
  if (!text.includes("https://xpertapply.com") || !text.includes("https://www.xpertapply.com")) errors.push("production bridge origins");
  if (!/Employer\/ATS HTTPS access is \*\*optional\*\*/.test(text)) errors.push("optional employer access");
  if (!/exact workflow origin from a user gesture/.test(text)) errors.push("exact-origin grant boundary");
  return errors;
}

describe("README security-model consistency", () => {
  it("documents the production bridge and exact-origin optional permission model", () => {
    expect(documentationErrors(readme)).toEqual([]);
  });

  it("negative control rejects the historical blanket-access statement", () => {
    const stale = readme.replace(
      "Employer/ATS HTTPS access is **optional**, not install-time access to every\n  site.",
      "XpertApply requires access to all HTTPS sites."
    );
    expect(stale).not.toBe(readme);
    expect(documentationErrors(stale)).toContain("blanket HTTPS access");
  });
});

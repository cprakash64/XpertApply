import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Visa/status inference must stay out of the profile form.
 *
 * The removed defect: selecting a work-authorization status such as
 * `student_visa` or `opt_cpt` automatically set `requires_sponsorship = true`.
 * That is an immigration inference standing in for a legal answer the user
 * never gave, and it fed straight into employer applications.
 */
function readSource(relative: string): string {
  return readFileSync(resolve(process.cwd(), relative), "utf8");
}

describe("profile wizard does not infer legal answers", () => {
  const source = readSource("components/ProfileWizard.tsx");

  it("has no status-to-sponsorship suggestion table", () => {
    expect(source).not.toContain("sponsorshipSuggested");
  });

  it("never writes requires_sponsorship from the work-authorization handler", () => {
    const handler = source.slice(
      source.indexOf("function updateWorkAuthorization"),
      source.indexOf("async function save()")
    );
    expect(handler).toContain("work_authorization: value");
    expect(handler).not.toContain("requires_sponsorship");
  });

  it("does not couple any visa status to a sponsorship value", () => {
    for (const status of ["student_visa", "opt_cpt", "need_sponsorship_now", "need_sponsorship_future"]) {
      const index = source.indexOf(status);
      if (index === -1) continue;
      // The status may appear as a selectable option, but never within 200
      // characters of a requires_sponsorship assignment.
      const window = source.slice(Math.max(0, index - 200), index + 200);
      expect(window, `${status} is near a sponsorship assignment`).not.toMatch(
        /requires_sponsorship\s*[:=]/
      );
    }
  });
});

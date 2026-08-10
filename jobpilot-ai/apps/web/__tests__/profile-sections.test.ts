import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FOCUSED_SECTIONS, WIZARD_STEPS, type WizardSection } from "@/lib/profileSections";

const ROOT = join(__dirname, "..");

/** True when the file opens with a real "use client" directive. */
function hasUseClientDirective(source: string): boolean {
  const firstCode = source
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line !== "");
  return firstCode === '"use client";' || firstCode === "'use client';";
}

describe("wizard section map", () => {
  it("matches the wizard's own step order", () => {
    // The order is the wizard's contract; a step inserted there without
    // updating this map would silently open every editor on the wrong section.
    const wizard = readFileSync(join(ROOT, "components/ProfileWizard.tsx"), "utf8");
    const declared = /const steps = \[([\s\S]*?)\]/.exec(wizard)?.[1] ?? "";
    const labels = [...declared.matchAll(/"([^"]+)"/g)].map((match) => match[1]);

    expect(labels).toHaveLength(Object.keys(WIZARD_STEPS).length);
    const expectedLabels: Record<WizardSection, string> = {
      import: "Import",
      personal: "Basic info",
      preferences: "Job targets",
      education: "Education",
      experience: "Experience",
      projects: "Projects",
      skills: "Skills",
      links: "Links",
      review: "Review"
    };
    for (const [section, index] of Object.entries(WIZARD_STEPS)) {
      expect(labels[index], `${section} should map to step ${index}`).toBe(
        expectedLabels[section as WizardSection]
      );
    }
  });

  it("has a unique index per section", () => {
    const indices = Object.values(WIZARD_STEPS);
    expect(new Set(indices).size).toBe(indices.length);
  });

  /**
   * Regression guard. Every export of a `"use client"` module becomes a client
   * *reference* when a server component imports it, so reading WIZARD_STEPS
   * from ProfileWizard.tsx in the route handler yielded `undefined` and every
   * editor silently opened on step 0. The map has to live in a plain module.
   */
  it("is defined in a module that server components can read", () => {
    const source = readFileSync(join(ROOT, "lib/profileSections.ts"), "utf8");
    // The *directive* is what matters — a mention inside a comment is fine, so
    // this looks for it only where a directive can legally appear.
    expect(hasUseClientDirective(source)).toBe(false);

    const wizard = readFileSync(join(ROOT, "components/ProfileWizard.tsx"), "utf8");
    expect(hasUseClientDirective(wizard)).toBe(true);
    expect(wizard, "the step map must not be re-declared in the client module").not.toMatch(
      /export const WIZARD_STEPS/
    );
  });

  it("is imported by the editor route from the shared module", () => {
    const route = readFileSync(join(ROOT, "app/profile/[section]/page.tsx"), "utf8");
    expect(route).toMatch(/from "@\/lib\/profileSections"/);
    expect(route).not.toMatch(/WIZARD_STEPS[^;]*from "@\/components\/ProfileWizard"/);
  });

  /**
   * The route is a server component, so anything it *calls* — not just reads —
   * has to come from a plain module. A function exported from a "use client"
   * file fails at prerender with "Attempted to call X from the server", which
   * only the production build surfaces; jsdom tests render it happily.
   */
  it("only calls helpers that live outside a client module", () => {
    const route = readFileSync(join(ROOT, "app/profile/[section]/page.tsx"), "utf8");
    const clientImports = [...route.matchAll(/import \{([^}]*)\} from "@\/(components[^"]*)"/g)];
    for (const [, imported, source] of clientImports) {
      const file = readFileSync(join(ROOT, `${source}.tsx`), "utf8");
      if (!hasUseClientDirective(file)) continue;
      for (const name of imported.split(",").map((entry) => entry.trim()).filter(Boolean)) {
        // A component may be rendered; a bare function may not be invoked.
        expect(
          /^type /.test(name) || /^[A-Z]/.test(name),
          `${name} is imported from the client module ${source} — a server component can render a client component, but cannot call a client function`
        ).toBe(true);
      }
    }
  });

  it("resolves every focused section to an editor", () => {
    const editor = readFileSync(
      join(ROOT, "components/profile/editors/SectionEditor.tsx"),
      "utf8"
    );
    for (const section of FOCUSED_SECTIONS) {
      expect(editor, `${section} needs a case in SectionEditor`).toContain(`case "${section}":`);
    }
  });

  /**
   * Most focused sections mirror a wizard step, but they are not required to:
   * Certifications & Awards is a first-class profile section the onboarding
   * wizard never had. What must hold is that anything claiming to be a wizard
   * step really is one.
   */
  it("maps every wizard-backed section onto a real step", () => {
    for (const section of FOCUSED_SECTIONS) {
      if (section in WIZARD_STEPS) {
        expect(typeof WIZARD_STEPS[section as keyof typeof WIZARD_STEPS]).toBe("number");
      }
    }
    expect(WIZARD_STEPS).not.toHaveProperty("credentials");
  });

  it("covers every section the overview's Edit actions link to", () => {
    const overview = readFileSync(join(ROOT, "components/profile/ProfileOverview.tsx"), "utf8");
    const linked = new Set(
      [...overview.matchAll(/href="\/profile\/([a-z]+)"/g)].map((match) => match[1])
    );
    const known = new Set([...Object.keys(WIZARD_STEPS), ...FOCUSED_SECTIONS, "edit"]);
    for (const section of linked) {
      expect(known.has(section), `/profile/${section} has no editor route`).toBe(true);
    }
    // The overview must actually link somewhere for each editable card.
    expect(linked).toEqual(
      new Set([
        "personal",
        "preferences",
        "experience",
        "education",
        "projects",
        "skills",
        "credentials",
        "publications",
        "import",
        "edit"
      ])
    );
  });
});

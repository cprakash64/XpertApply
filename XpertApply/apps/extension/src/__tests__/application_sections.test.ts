import { describe, expect, it } from "vitest";
import {
  CONSENT_REVIEW_MESSAGE,
  classifyLegalQuestion,
  mapYesNoOption,
  mayAutoCheckConsent,
  resolveLegalAnswer
} from "../application/sensitivePolicy";
import {
  buildSelfIntroduction,
  canonicalUrlKey,
  classifyPlatform,
  entryFingerprint,
  isAcceptableIntroduction,
  isPublishableUrl,
  mapProficiency,
  selectAwards,
  selectInternships,
  selectLanguages,
  selectLinks,
  selectProjects,
  truncateOnBoundary,
  type ExperienceRecord,
  type LinkRecord
} from "../application/sectionData";
import {
  classifySectionHeading,
  controlBelongsToSection,
  findAddControl,
  findSections,
  isForbiddenControl
} from "../application/sectionControls";

const JOB = { title: "Machine Learning Engineer", company: "TikTok", requiredSkills: ["python", "pytorch", "recommendation"] };

function verified<T extends object>(item: T, id: string): T & { id: string; source: string; verified: boolean; confidence: number } {
  return { ...item, id, source: "explicit_user_answer", verified: true, confidence: 1 };
}

// --------------------------------------------------------------------------- //
// Legal answers
// --------------------------------------------------------------------------- //
describe("legal and sensitive answers", () => {
  it("fills only from an explicit, verified answer", () => {
    const result = resolveLegalAnswer({ value: true, source: "explicit_user_answer", verified: true });
    expect(result).toEqual({ status: "resolved", value: true, source: "explicit_user_answer" });
  });

  it("leaves a missing work-authorization answer for review", () => {
    expect(resolveLegalAnswer(null)).toEqual({
      status: "requires_review",
      reason: "missing_explicit_answer"
    });
    expect(resolveLegalAnswer({ value: null, source: "explicit_user_answer", verified: true })).toEqual({
      status: "requires_review",
      reason: "missing_explicit_answer"
    });
  });

  it("never treats unknown as No", () => {
    const result = resolveLegalAnswer({ value: null, source: "explicit_user_answer", verified: true });
    expect(result.status).toBe("requires_review");
    expect(JSON.stringify(result)).not.toContain("false");
  });

  it("refuses an answer inferred from a resume or profile parse", () => {
    for (const source of ["resume_parse", "profile_inferred", "previous_application", "heuristic"]) {
      expect(resolveLegalAnswer({ value: false, source, verified: true })).toEqual({
        status: "requires_review",
        reason: "untrusted_source"
      });
    }
  });

  it("refuses an unverified explicit answer", () => {
    expect(resolveLegalAnswer({ value: true, source: "explicit_user_answer", verified: false })).toEqual({
      status: "requires_review",
      reason: "unverified_answer"
    });
  });

  it("recognises the live question wordings", () => {
    expect(classifyLegalQuestion("Are you legally authorized to work in the US without restriction?")).toBe(
      "work_authorization"
    );
    expect(classifyLegalQuestion("Will you now or in the future require visa sponsorship or a visa transfer?")).toBe(
      "visa_sponsorship"
    );
    expect(classifyLegalQuestion("I have read and agree to the privacy policy")).toBe("privacy_consent");
    expect(classifyLegalQuestion("Where did you hear about this opportunity?")).toBeNull();
  });

  it("never auto-checks a legal attestation", () => {
    expect(mayAutoCheckConsent()).toBe(false);
    expect(CONSENT_REVIEW_MESSAGE).toMatch(/review and accept/i);
  });

  it("maps yes/no only onto unambiguous options", () => {
    expect(mapYesNoOption(true, ["Yes", "No"])).toBe("Yes");
    expect(mapYesNoOption(false, ["Yes", "No"])).toBe("No");
    // A qualified option is legally different and must not be auto-selected.
    expect(mapYesNoOption(true, ["Yes, with restrictions", "No"])).toBeNull();
    expect(mapYesNoOption(true, ["Prefer not to say", "Decline"])).toBeNull();
  });
});

// --------------------------------------------------------------------------- //
// Internships
// --------------------------------------------------------------------------- //
describe("internship selection", () => {
  const records: ExperienceRecord[] = [
    verified({ organization: "Acme", title: "ML Intern", startDate: "2025-06", endDate: "2025-09", employmentType: "internship" as const, skills: ["python", "pytorch"] }, "a"),
    verified({ organization: "Globex", title: "Software Engineer", startDate: "2023-01", endDate: "2025-01", employmentType: "full_time" as const, skills: ["java"] }, "b"),
    verified({ organization: "Initech", title: "Research Assistant", startDate: "2024-01", endDate: "2024-08", employmentType: "research" as const, skills: ["recommendation"] }, "c")
  ];

  it("uses only records explicitly classified as internship/co-op/research", () => {
    const { selected, skipped } = selectInternships(records, JOB);
    expect(selected.map((item) => item.id).sort()).toEqual(["a", "c"]);
    expect(skipped).toContainEqual({ id: "b", reason: "not_an_internship" });
  });

  it("never classifies a job as an internship from its title text", () => {
    const titled: ExperienceRecord[] = [
      verified({ organization: "Acme", title: "Summer Intern", startDate: "2025-06", employmentType: "full_time" as const }, "x")
    ];
    const { selected, skipped } = selectInternships(titled, JOB);
    expect(selected).toHaveLength(0);
    expect(skipped[0].reason).toBe("not_an_internship");
  });

  it("skips a record missing an employer or start date rather than guessing", () => {
    const partial: ExperienceRecord[] = [
      verified({ title: "ML Intern", startDate: "2025-06", employmentType: "internship" as const }, "no-org"),
      verified({ organization: "Acme", title: "ML Intern", employmentType: "internship" as const }, "no-date")
    ];
    const { selected, skipped } = selectInternships(partial, JOB);
    expect(selected).toHaveLength(0);
    expect(skipped.every((item) => item.reason === "missing_required_field")).toBe(true);
  });

  it("skips unverified records", () => {
    const unverified = [{ ...records[0], id: "u", verified: false }];
    expect(selectInternships(unverified, JOB).skipped[0]).toEqual({ id: "u", reason: "unverified" });
  });

  it("ranks the most job-relevant internship first and respects the limit", () => {
    const { selected } = selectInternships(records, JOB, 1);
    expect(selected).toHaveLength(1);
    expect(selected[0].id).toBe("a");
  });
});

// --------------------------------------------------------------------------- //
// Projects, links, awards, languages
// --------------------------------------------------------------------------- //
describe("project selection", () => {
  it("prefers technology overlap with the job and caps at three", () => {
    const projects = [
      verified({ name: "Recipe app", technologies: ["php"] }, "p1"),
      verified({ name: "Recommender", technologies: ["python", "pytorch", "recommendation"] }, "p2"),
      verified({ name: "Chatbot", technologies: ["python"] }, "p3"),
      verified({ name: "Blog", technologies: ["css"] }, "p4")
    ];
    const { selected } = selectProjects(projects, JOB);
    expect(selected).toHaveLength(3);
    expect(selected[0].id).toBe("p2");
  });
});

describe("work sample and SNS links", () => {
  it("rejects unsafe URLs", () => {
    expect(isPublishableUrl("http://example.com/x")).toBe(false);
    expect(isPublishableUrl("https://user:pw@example.com")).toBe(false);
    expect(isPublishableUrl("https://localhost/demo")).toBe(false);
    expect(isPublishableUrl("https://127.0.0.1/demo")).toBe(false);
    expect(isPublishableUrl("https://s3.example.com/f?X-Amz-Signature=abc")).toBe(false);
    expect(isPublishableUrl("https://drive.example.com/f?token=secret")).toBe(false);
    expect(isPublishableUrl("file:///Users/me/resume.pdf")).toBe(false);
    expect(isPublishableUrl(undefined)).toBe(false);
  });

  it("accepts a normal public link", () => {
    expect(isPublishableUrl("https://github.com/someone/project")).toBe(true);
  });

  it("does not publish a link the user marked unshareable", () => {
    const links: LinkRecord[] = [verified({ url: "https://github.com/me/private", shareable: false }, "l1")];
    expect(selectLinks(links).skipped[0]).toEqual({ id: "l1", reason: "not_shareable" });
  });

  it("maps platforms from the URL and never invents one from a name", () => {
    expect(classifyPlatform("https://www.linkedin.com/in/someone")).toBe("linkedin");
    expect(classifyPlatform("https://github.com/someone")).toBe("github");
    expect(classifyPlatform("https://scholar.google.com/citations?user=x")).toBe("google_scholar");
    expect(classifyPlatform("https://my-site.dev")).toBe("personal_website");
    expect(classifyPlatform("not a url")).toBeNull();
  });

  it("drops duplicate links that differ only in case or trailing slash", () => {
    const links: LinkRecord[] = [
      verified({ url: "https://github.com/Me/Project" }, "l1"),
      verified({ url: "https://github.com/me/project/" }, "l2")
    ];
    const { selected, skipped } = selectLinks(links);
    expect(selected).toHaveLength(1);
    expect(skipped[0]).toEqual({ id: "l2", reason: "duplicate" });
    expect(canonicalUrlKey("https://www.github.com/Me/Project/")).toBe("github.com/me/project");
  });
});

describe("awards", () => {
  it("keeps a verified award without inventing an issuer or date", () => {
    const awards = [verified({ name: "Dean's List" }, "a1")];
    const { selected } = selectAwards(awards, JOB);
    expect(selected[0].issuer).toBeUndefined();
    expect(selected[0].date).toBeUndefined();
  });
});

describe("language skills", () => {
  it("requires an explicit proficiency", () => {
    const languages = [verified({ language: "Hindi" }, "l1")];
    expect(selectLanguages(languages).skipped[0]).toEqual({ id: "l1", reason: "unknown_proficiency" });
  });

  it("maps canonical levels onto the destination's own labels", () => {
    const options = ["Native or bilingual", "Full professional", "Limited working", "Elementary"];
    expect(mapProficiency("native", options)).toBe("Native or bilingual");
    expect(mapProficiency("professional", options)).toBe("Full professional");
    expect(mapProficiency("working", options)).toBe("Limited working");
    expect(mapProficiency("elementary", options)).toBe("Elementary");
  });

  it("returns null when no destination level clearly corresponds", () => {
    expect(mapProficiency("working", ["Expert", "Beginner"])).toBeNull();
    expect(mapProficiency(undefined, ["Native"])).toBeNull();
  });
});

// --------------------------------------------------------------------------- //
// Self-introduction
// --------------------------------------------------------------------------- //
describe("self-introduction", () => {
  it("is grounded in supplied facts only and fits the limit", () => {
    const text = buildSelfIntroduction({
      jobTitle: "Machine Learning Engineer",
      company: "TikTok",
      qualifications: ["three years building recommendation systems", "an MS in Computer Science"],
      highlight: { title: "a ranking service", description: "serving production traffic" },
      careerFocus: "machine learning engineer"
    });
    expect(text).toContain("Machine Learning Engineer");
    expect(text).toContain("TikTok");
    expect(text).toContain("recommendation systems");
    expect(text.length).toBeLessThanOrEqual(900);
    expect(text).not.toMatch(/perfect candidate|passionate/i);
  });

  it("omits clauses for facts it was not given, rather than inventing them", () => {
    const text = buildSelfIntroduction({ qualifications: [], jobTitle: undefined, company: undefined });
    expect(text).toBe("");
  });

  it("rejects an AI rewrite that overclaims or invents metrics", () => {
    expect(isAcceptableIntroduction("I am the perfect candidate for this role.", 900)).toBe(false);
    expect(isAcceptableIntroduction("I improved latency by 40% single-handedly.", 900)).toBe(false);
    expect(isAcceptableIntroduction("I am extremely excited about this opportunity.", 900)).toBe(false);
    expect(isAcceptableIntroduction("I build recommendation systems and want to keep doing that here.", 900)).toBe(true);
  });

  it("respects a smaller destination limit on a sentence boundary", () => {
    const text = truncateOnBoundary("First sentence here. Second sentence follows. Third one too.", 45);
    expect(text.length).toBeLessThanOrEqual(45);
    expect(text.endsWith(".")).toBe(true);
  });
});

// --------------------------------------------------------------------------- //
// Idempotency
// --------------------------------------------------------------------------- //
describe("entry fingerprints", () => {
  it("is stable across description edits and formatting", () => {
    const a = entryFingerprint("internship_experience", { organization: "Acme  Corp", title: "ML Intern", startDate: "2025-06-01" });
    const b = entryFingerprint("internship_experience", { organization: "acme corp", title: "ml intern", startDate: "2025-06-15" });
    expect(a).toBe(b);
  });

  it("distinguishes different records and different sections", () => {
    const internship = entryFingerprint("internship_experience", { organization: "Acme", title: "ML Intern", startDate: "2025-06" });
    const project = entryFingerprint("project_experience", { name: "ML Intern", startDate: "2025-06" });
    expect(internship).not.toBe(project);
  });
});

// --------------------------------------------------------------------------- //
// Section / Add-control association
// --------------------------------------------------------------------------- //
function buildForm(): Document {
  const doc = document.implementation.createHTMLDocument("application");
  doc.body.innerHTML = `
    <form>
      <section id="s-intern"><h3>Internship Experience</h3><button type="button">+ Add</button></section>
      <section id="s-project"><h3>Project Experience</h3><button type="button">+ Add</button></section>
      <section id="s-samples"><h3>Work Samples</h3><button type="button">+ Add</button></section>
      <section id="s-awards"><h3>Honors and Awards</h3><button type="button">+ Add</button></section>
      <section id="s-lang"><h3>Language Skills</h3><button type="button">+ Add</button></section>
      <section id="s-intro"><h3>Self-introduction</h3><button type="button">+ Add</button></section>
      <section id="s-sns"><h3>SNS</h3><button type="button">+ Add</button></section>
      <section id="s-legal">
        <h3>Privacy</h3>
        <label><input type="checkbox" id="consent" /> I agree to the privacy policy</label>
        <button type="button">Delete application</button>
      </section>
      <button type="submit" id="final-submit">Submit application</button>
    </form>`;
  return doc;
}

describe("section and Add-control association", () => {
  it("classifies each live section heading", () => {
    expect(classifySectionHeading("Internship Experience")).toBe("internship_experience");
    expect(classifySectionHeading("Project Experience")).toBe("project_experience");
    expect(classifySectionHeading("Work Samples")).toBe("work_samples");
    expect(classifySectionHeading("Honors and Awards")).toBe("honors_awards");
    expect(classifySectionHeading("Language Skills")).toBe("language_skills");
    expect(classifySectionHeading("Self-introduction")).toBe("self_introduction");
    expect(classifySectionHeading("SNS")).toBe("sns");
    expect(classifySectionHeading("Tell us about your projects")).toBeNull();
  });

  it("finds every section and scopes each to its own container", () => {
    const doc = buildForm();
    const sections = findSections(doc);
    expect(sections.map((entry) => entry.section)).toEqual([
      "internship_experience", "project_experience", "work_samples",
      "honors_awards", "language_skills", "self_introduction", "sns"
    ]);
    for (const match of sections) {
      expect(match.container.querySelectorAll("h3")).toHaveLength(1);
    }
  });

  it("resolves the Add control belonging to each section, not by text alone", () => {
    const doc = buildForm();
    for (const match of findSections(doc)) {
      const control = findAddControl(match);
      expect(control, match.section).not.toBeNull();
      // The control it found is inside that section's own container.
      expect(doc.getElementById(sectionId(match.section))!.contains(control!)).toBe(true);
      expect(controlBelongsToSection(control!, match)).toBe(true);
    }
  });

  it("never treats submit, delete or consent controls as Add", () => {
    const doc = buildForm();
    expect(isForbiddenControl(doc.getElementById("final-submit")!)).toBe(true);
    const remove = Array.from(doc.querySelectorAll("button")).find((b) => /delete/i.test(b.textContent ?? ""));
    expect(isForbiddenControl(remove!)).toBe(true);
  });

  it("does not offer an Add control for the legal section", () => {
    const doc = buildForm();
    const legal = findSections(doc).find((entry) => entry.heading.textContent === "Privacy");
    expect(legal).toBeUndefined();
  });

  it("refuses to guess when a section holds two ambiguous Add controls", () => {
    const doc = document.implementation.createHTMLDocument("x");
    doc.body.innerHTML = `
      <section><h3>Work Samples</h3>
        <button type="button">+ Add</button>
        <button type="button">Add more</button>
      </section>`;
    const match = findSections(doc)[0];
    expect(findAddControl(match)).toBeNull();
  });

  it("ignores a hidden or disabled Add control", () => {
    const doc = document.implementation.createHTMLDocument("x");
    doc.body.innerHTML = `
      <section><h3>Honors and Awards</h3>
        <button type="button" disabled>+ Add</button>
      </section>`;
    const match = findSections(doc)[0];
    expect(findAddControl(match)).toBeNull();
  });
});

function sectionId(section: string): string {
  return {
    internship_experience: "s-intern",
    project_experience: "s-project",
    work_samples: "s-samples",
    honors_awards: "s-awards",
    language_skills: "s-lang",
    self_introduction: "s-intro",
    sns: "s-sns"
  }[section]!;
}

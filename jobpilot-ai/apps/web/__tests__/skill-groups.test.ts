import { describe, expect, it } from "vitest";
import { groupForSkill, groupSkills } from "@/lib/skillGroups";

describe("groupForSkill", () => {
  it("routes skills to the group a reader would expect", () => {
    expect(groupForSkill("PyTorch")).toBe("AI / Machine Learning");
    expect(groupForSkill("Machine Learning")).toBe("AI / Machine Learning");
    expect(groupForSkill("FastAPI")).toBe("Backend");
    expect(groupForSkill("Kubernetes")).toBe("Cloud / DevOps");
    expect(groupForSkill("TypeScript")).toBe("Languages");
    expect(groupForSkill("PostgreSQL")).toBe("Data");
    expect(groupForSkill("React")).toBe("Frontend");
  });

  it("matches regardless of punctuation or case", () => {
    expect(groupForSkill("Node.js")).toBe("Backend");
    expect(groupForSkill("node js")).toBe("Backend");
    expect(groupForSkill("NEXT.JS")).toBe("Frontend");
    expect(groupForSkill("CI/CD")).toBe("Cloud / DevOps");
  });

  it("prefers the longest matching keyword", () => {
    // "machine learning" must win over the bare "ml"/"ai" tokens, and
    // "spring boot" over "boot"-like short tokens.
    expect(groupForSkill("Machine Learning Engineering")).toBe("AI / Machine Learning");
    expect(groupForSkill("Spring Boot")).toBe("Backend");
  });

  it("does not let a short token swallow an unrelated skill", () => {
    // "r" (the language) must not claim "React", and "ai" must not claim
    // "LangChain" via a substring match.
    expect(groupForSkill("React")).toBe("Frontend");
    expect(groupForSkill("Rust")).toBe("Languages");
  });

  it("falls back to Other rather than dropping an unknown skill", () => {
    expect(groupForSkill("Underwater Basket Weaving")).toBe("Other");
  });
});

describe("groupSkills", () => {
  it("returns no groups for an empty list", () => {
    expect(groupSkills([])).toEqual([]);
  });

  it("places every skill in exactly one group", () => {
    const skills = [
      "Python", "PyTorch", "FastAPI", "Docker", "React", "PostgreSQL",
      "Underwater Basket Weaving"
    ];
    const groups = groupSkills(skills);
    const flattened = groups.flatMap((group) => group.skills);
    expect(flattened).toHaveLength(skills.length);
    expect(new Set(flattened)).toEqual(new Set(skills));
  });

  it("keeps counts adding up to the profile's real skill total", () => {
    const skills = Array.from({ length: 57 }, (_, index) => `Skill ${index}`);
    const total = groupSkills(skills).reduce((sum, group) => sum + group.skills.length, 0);
    expect(total).toBe(57);
  });

  it("ignores blank entries", () => {
    expect(groupSkills(["", "   ", "Python"])).toEqual([
      { name: "Languages", skills: ["Python"] }
    ]);
  });

  it("trims skills but never renames them", () => {
    const [group] = groupSkills(["  TypeScript  "]);
    expect(group.skills).toEqual(["TypeScript"]);
  });

  it("sorts Other last", () => {
    const groups = groupSkills(["Underwater Basket Weaving", "Python"]);
    expect(groups.map((group) => group.name)).toEqual(["Languages", "Other"]);
  });

  it("preserves the user's ordering inside a group", () => {
    const [group] = groupSkills(["TypeScript", "Python", "Rust"]);
    expect(group.skills).toEqual(["TypeScript", "Python", "Rust"]);
  });

  it("summarizes a realistic 50+ skill profile into a handful of groups", () => {
    const skills = [
      "Python", "TypeScript", "Java", "Go", "SQL",
      "PyTorch", "TensorFlow", "scikit-learn", "LangChain", "Hugging Face",
      "FastAPI", "Django", "Node.js", "GraphQL", "gRPC",
      "React", "Next.js", "Tailwind", "Redux",
      "AWS", "Docker", "Kubernetes", "Terraform", "GitHub Actions",
      "PostgreSQL", "Redis", "Kafka", "Spark", "Airflow"
    ];
    const groups = groupSkills(skills);
    // The whole point of the card: a small number of scannable groups.
    expect(groups.length).toBeLessThanOrEqual(8);
    expect(groups.every((group) => group.skills.length > 0)).toBe(true);
  });
});

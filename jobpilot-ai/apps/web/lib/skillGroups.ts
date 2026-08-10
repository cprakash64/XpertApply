/**
 * Grouping for the Profile overview's Skills card.
 *
 * Skills are stored as a flat, free-form string list, and a real profile has
 * 40–80 of them. Rendering that as chips produces a wall the user cannot skim,
 * which is the specific problem this card exists to avoid. So the overview
 * shows a handful of *groups* with counts instead.
 *
 * The matcher is deliberately simple and local: a keyword table, checked
 * longest-token-first so "spring boot" wins over "boot" and "machine learning"
 * over "learning". It is presentation-only — nothing here is persisted, no
 * skill is renamed, and a skill that matches nothing lands in "Other" rather
 * than being dropped. Changing this table can never change what the user's
 * profile actually stores.
 */

export type SkillGroup = {
  /** Display name of the group. */
  name: string;
  /** The user's own skill strings, unmodified, in their original order. */
  skills: string[];
};

/**
 * Group name -> tokens that imply it. Matching is substring-based on a
 * lowercased, punctuation-normalized skill, so "Node.js" matches "node".
 */
const GROUP_KEYWORDS: [string, string[]][] = [
  [
    "AI / Machine Learning",
    [
      "machine learning", "deep learning", "reinforcement learning", "computer vision",
      "natural language", "nlp", "llm", "large language model", "generative ai", "genai",
      "transformer", "pytorch", "tensorflow", "keras", "scikit", "sklearn", "hugging face",
      "huggingface", "langchain", "rag", "mlops", "xgboost", "opencv", "cuda", "diffusion",
      "neural network", "recommender", "ml", "ai"
    ]
  ],
  [
    "Data",
    [
      "sql", "postgres", "postgresql", "mysql", "sqlite", "mongodb", "redis", "cassandra",
      "dynamodb", "elasticsearch", "snowflake", "bigquery", "redshift", "databricks",
      "spark", "hadoop", "kafka", "airflow", "dbt", "etl", "pandas", "numpy", "tableau",
      "power bi", "looker", "data warehouse", "data pipeline", "analytics"
    ]
  ],
  [
    "Backend",
    [
      "fastapi", "django", "flask", "express", "nestjs", "spring boot", "spring", "rails",
      "laravel", "graphql", "grpc", "rest api", "rest", "microservice", "backend",
      "api design", "celery", "rabbitmq", "sqlalchemy", "node"
    ]
  ],
  [
    "Frontend",
    [
      "react", "next.js", "nextjs", "vue", "angular", "svelte", "redux", "tailwind",
      "css", "html", "sass", "webpack", "vite", "frontend", "ui", "ux", "figma",
      "accessibility", "responsive"
    ]
  ],
  [
    "Cloud / DevOps",
    [
      "aws", "azure", "gcp", "google cloud", "docker", "kubernetes", "k8s", "terraform",
      "ansible", "jenkins", "github actions", "gitlab ci", "ci/cd", "cicd", "helm",
      "prometheus", "grafana", "datadog", "linux", "nginx", "serverless", "lambda",
      "cloudformation", "devops", "observability", "s3", "ec2"
    ]
  ],
  [
    "Languages",
    [
      "python", "javascript", "typescript", "java", "c++", "c#", "c", "go", "golang",
      "rust", "ruby", "php", "swift", "kotlin", "scala", "r", "matlab", "bash", "shell",
      "perl", "haskell", "elixir", "dart"
    ]
  ],
  [
    "Tools & Practices",
    [
      "git", "github", "gitlab", "jira", "confluence", "agile", "scrum", "kanban",
      "testing", "pytest", "jest", "unit test", "tdd", "code review", "documentation"
    ]
  ]
];

/** Display order, so the card is stable regardless of the user's skill order. */
const GROUP_ORDER = GROUP_KEYWORDS.map(([name]) => name);

const OTHER_GROUP = "Other";

/**
 * Keywords sorted longest-first. A skill is tested against every keyword, and
 * the longest match wins, so "machine learning" is not claimed by "ml" and
 * "spring boot" is not claimed by a shorter token.
 */
const RANKED_KEYWORDS: { group: string; token: string }[] = GROUP_KEYWORDS.flatMap(
  ([group, tokens]) => tokens.map((token) => ({ group, token }))
).sort((a, b) => b.token.length - a.token.length);

/** Lowercase and collapse punctuation so "Node.js" and "node js" both match "node". */
function normalize(skill: string): string {
  return ` ${skill.toLowerCase().replace(/[^a-z0-9+#]+/g, " ").trim()} `;
}

/** Whole-token containment, so "r" does not match "react" and "ai" not "chain". */
function containsToken(haystack: string, token: string): boolean {
  return haystack.includes(` ${token.replace(/[^a-z0-9+#]+/g, " ").trim()} `);
}

/** The group one skill belongs to. Exported for direct testing. */
export function groupForSkill(skill: string): string {
  const normalized = normalize(skill);
  for (const { group, token } of RANKED_KEYWORDS) {
    if (containsToken(normalized, token)) {
      return group;
    }
  }
  return OTHER_GROUP;
}

/**
 * Bucket a flat skill list into display groups.
 *
 * Every input skill appears in exactly one output group — nothing is dropped
 * and nothing is duplicated, so the counts always add up to the profile's real
 * skill total. Empty groups are omitted; "Other" sorts last.
 */
export function groupSkills(skills: string[]): SkillGroup[] {
  const buckets = new Map<string, string[]>();
  for (const skill of skills) {
    const trimmed = skill.trim();
    if (!trimmed) continue;
    const group = groupForSkill(trimmed);
    const existing = buckets.get(group);
    if (existing) {
      existing.push(trimmed);
    } else {
      buckets.set(group, [trimmed]);
    }
  }

  return [...buckets.entries()]
    .map(([name, grouped]) => ({ name, skills: grouped }))
    .sort((a, b) => {
      // "Other" always last; the rest follow the declared group order.
      if (a.name === OTHER_GROUP) return 1;
      if (b.name === OTHER_GROUP) return -1;
      return GROUP_ORDER.indexOf(a.name) - GROUP_ORDER.indexOf(b.name);
    });
}

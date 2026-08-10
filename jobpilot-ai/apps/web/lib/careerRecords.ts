/**
 * The career record shapes and their wire normalizers.
 *
 * These mirror `lib/profileForm.ts`'s role for the profile record: one place
 * that knows how the API's career payload maps onto form state, so the wizard
 * and the focused editors cannot drift. The wire may send null for any column;
 * controlled inputs must always receive a string.
 *
 * Nothing here drops a field. `PUT /profile/career` deletes and re-inserts every
 * career row, so a field this module forgets to carry is a field the next save
 * destroys.
 */

export type EducationRecord = {
  school: string;
  degree: string;
  major: string;
  minor: string;
  start_date: string;
  end_date: string;
  gpa: string;
  gpa_scale: string;
  honors: string[];
  coursework: string[];
};

/**
 * A certification. The fields are exactly the ones `Certification` stores —
 * "does not expire" is represented by a null expiration date rather than a
 * separate flag, so no column was added for it.
 */
export type CertificationRecord = {
  name: string;
  issuer: string;
  issue_date: string;
  expiration_date: string;
  credential_url: string;
};

/** A published work. Mirrors the `Publication` table's columns. */
export type PublicationRecord = {
  title: string;
  venue: string;
  authors: string[];
  publication_date: string;
  url: string;
  doi: string;
  description: string;
};

/** An award or honour. Mirrors the `Award` table's columns. */
export type AwardRecord = {
  name: string;
  issuer: string;
  date: string;
  description: string;
};

export type ExperienceRecord = {
  company: string;
  title: string;
  location: string;
  start_date: string;
  end_date: string;
  currently_working: boolean;
  bullets: string[];
  technologies: string[];
  measurable_impact: string[];
};

export type ProjectRecord = {
  name: string;
  description: string;
  bullets: string[];
  technologies: string[];
  links: string[];
  start_date: string;
  end_date: string;
};

export type CareerForm = {
  education: EducationRecord[];
  experience: ExperienceRecord[];
  projects: ProjectRecord[];
  /**
   * Not editable in any current screen, but round-tripped verbatim: the career
   * PUT replaces these tables too, so dropping them here would silently delete
   * the user's certifications and awards on the next save.
   */
  certifications: CertificationRecord[];
  awards: AwardRecord[];
  publications: PublicationRecord[];
};

export const emptyCareer: CareerForm = {
  education: [],
  experience: [],
  projects: [],
  certifications: [],
  awards: [],
  publications: []
};

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function strList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

/**
 * These are DATE columns, so the wire value is `YYYY-MM-DD` and nothing else.
 * Both directions stay strict — matching the wizard's long-standing behaviour —
 * so a malformed value becomes "not set" rather than being forwarded to the API
 * and failing the whole career save.
 */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Wire value -> `<input type="date">` value. */
export function normalizeDate(value: unknown): string {
  const raw = text(value);
  return ISO_DATE.test(raw) ? raw : "";
}

/** Input value -> wire value. Unset is null, never "". */
export function cleanDate(value: string): string | null {
  return ISO_DATE.test(value) ? value : null;
}

export function normalizeEducationList(records: unknown[]): EducationRecord[] {
  return records.map((record) => {
    const item = (record ?? {}) as Record<string, unknown>;
    return {
      school: text(item.school),
      degree: text(item.degree),
      major: text(item.major),
      minor: text(item.minor),
      start_date: normalizeDate(item.start_date),
      end_date: normalizeDate(item.end_date),
      gpa: text(item.gpa),
      gpa_scale: text(item.gpa_scale) || "4.0",
      honors: strList(item.honors),
      coursework: strList(item.coursework)
    };
  });
}

export function normalizeExperienceList(records: unknown[]): ExperienceRecord[] {
  return records.map((record) => {
    const item = (record ?? {}) as Record<string, unknown>;
    return {
      company: text(item.company),
      title: text(item.title),
      location: text(item.location),
      start_date: normalizeDate(item.start_date),
      end_date: normalizeDate(item.end_date),
      currently_working: Boolean(item.currently_working),
      bullets: strList(item.bullets),
      technologies: strList(item.technologies),
      measurable_impact: strList(item.measurable_impact)
    };
  });
}

export function normalizeProjectList(records: unknown[]): ProjectRecord[] {
  return records.map((record) => {
    const item = (record ?? {}) as Record<string, unknown>;
    return {
      name: text(item.name),
      description: text(item.description),
      bullets: strList(item.bullets),
      technologies: strList(item.technologies),
      links: strList(item.links),
      start_date: normalizeDate(item.start_date),
      end_date: normalizeDate(item.end_date)
    };
  });
}

/**
 * Placeholder titles for records the user left unnamed.
 *
 * The server requires a value; substituting one here keeps a half-filled row
 * from failing the whole career save. It is the same substitution the wizard
 * has always made, so behaviour is unchanged.
 */
export function normalizeCertificationList(records: unknown[]): CertificationRecord[] {
  return records.map((record) => {
    const item = (record ?? {}) as Record<string, unknown>;
    return {
      name: text(item.name),
      issuer: text(item.issuer),
      issue_date: normalizeDate(item.issue_date),
      expiration_date: normalizeDate(item.expiration_date),
      credential_url: text(item.credential_url)
    };
  });
}

export function normalizeAwardList(records: unknown[]): AwardRecord[] {
  return records.map((record) => {
    const item = (record ?? {}) as Record<string, unknown>;
    return {
      name: text(item.name),
      issuer: text(item.issuer),
      date: normalizeDate(item.date),
      description: text(item.description)
    };
  });
}

export function normalizePublicationList(records: unknown[]): PublicationRecord[] {
  return records.map((record) => {
    const item = (record ?? {}) as Record<string, unknown>;
    return {
      title: text(item.title),
      venue: text(item.venue),
      authors: strList(item.authors),
      publication_date: normalizeDate(item.publication_date),
      url: text(item.url),
      doi: text(item.doi),
      description: text(item.description)
    };
  });
}

export function blankPublication(): PublicationRecord {
  return {
    title: "",
    venue: "",
    authors: [],
    publication_date: "",
    url: "",
    doi: "",
    description: ""
  };
}

export function cleanPublication(record: PublicationRecord) {
  return {
    ...record,
    title: record.title || "Untitled publication",
    publication_date: cleanDate(record.publication_date),
    // The API types these as optional; an empty string is not a URL or a DOI.
    url: record.url || null,
    doi: record.doi || null,
    venue: record.venue || null,
    description: record.description || null
  };
}

export function blankCertification(): CertificationRecord {
  return { name: "", issuer: "", issue_date: "", expiration_date: "", credential_url: "" };
}

export function blankAward(): AwardRecord {
  return { name: "", issuer: "", date: "", description: "" };
}

export function cleanCertification(record: CertificationRecord) {
  return {
    ...record,
    name: record.name || "Untitled certification",
    issue_date: cleanDate(record.issue_date),
    // An empty expiration date IS "does not expire" — the column is nullable
    // and that is precisely what null means here.
    expiration_date: cleanDate(record.expiration_date),
    credential_url: record.credential_url || null
  };
}

export function cleanAward(record: AwardRecord) {
  return {
    ...record,
    name: record.name || "Untitled award",
    date: cleanDate(record.date)
  };
}

export function cleanEducation(record: EducationRecord) {
  return {
    ...record,
    school: record.school || "Untitled school",
    start_date: cleanDate(record.start_date),
    end_date: cleanDate(record.end_date)
  };
}

export function cleanExperience(record: ExperienceRecord) {
  return {
    ...record,
    company: record.company || "Untitled company",
    title: record.title || "Untitled role",
    start_date: cleanDate(record.start_date),
    // "I work here now" is the source of truth for an open-ended role: an end
    // date left behind by unticking and re-ticking the box would otherwise be
    // saved alongside it and contradict it.
    end_date: record.currently_working ? null : cleanDate(record.end_date)
  };
}

export function cleanProject(record: ProjectRecord) {
  return {
    ...record,
    name: record.name || "Untitled project",
    start_date: cleanDate(record.start_date),
    end_date: cleanDate(record.end_date)
  };
}

export const blankEducation = (): EducationRecord => ({
  school: "",
  degree: "",
  major: "",
  minor: "",
  start_date: "",
  end_date: "",
  gpa: "",
  gpa_scale: "4.0",
  honors: [],
  coursework: []
});

export const blankExperience = (): ExperienceRecord => ({
  company: "",
  title: "",
  location: "",
  start_date: "",
  end_date: "",
  currently_working: false,
  bullets: [],
  technologies: [],
  measurable_impact: []
});

export const blankProject = (): ProjectRecord => ({
  name: "",
  description: "",
  bullets: [],
  technologies: [],
  links: [],
  start_date: "",
  end_date: ""
});

/** "2022 – Present" / "2022 – 2025" — year precision for collapsed summaries. */
export function yearRange(start: string, end: string, current = false): string {
  const from = start.slice(0, 4);
  const to = current ? "Present" : end.slice(0, 4);
  if (!from && !to) return "";
  if (!from) return to;
  if (!to) return from;
  return `${from} – ${to}`;
}

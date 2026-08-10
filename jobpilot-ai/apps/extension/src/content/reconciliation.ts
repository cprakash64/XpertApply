import type { ApplicationSessionData, DiscoveredField, FieldMapping, SessionAnswer } from "../types";

export type ReconciliationClass =
  | "ATS_POPULATED_MATCH"
  | "ATS_POPULATED_CONFLICT"
  | "ATS_POPULATED_UNVERIFIABLE"
  | "EMPTY_AND_RESOLVABLE"
  | "EMPTY_AND_MISSING_INFORMATION"
  | "UNSUPPORTED";

export interface ReconciledField {
  uid: string;
  canonicalKey: string | null;
  classification: ReconciliationClass;
  provenance: "ats" | "jobpilot_profile" | "none";
  mayFill: boolean;
}

export function reconcileAtsValues(
  fields: DiscoveredField[],
  mappings: FieldMapping[],
  session: ApplicationSessionData
): ReconciledField[] {
  const mappingByUid = new Map(mappings.map((mapping) => [mapping.uid, mapping]));
  const answers = new Map(session.answers.map((answer) => [answer.canonical_key, answer]));
  return fields.map((field) => reconcileField(field, mappingByUid.get(field.uid), answers));
}

function reconcileField(
  field: DiscoveredField,
  mapping: FieldMapping | undefined,
  answers: Map<string, SessionAnswer>
): ReconciledField {
  if (!mapping || mapping.canonicalKey === "unknown") {
    return record(field, null, field.existingValue ? "ATS_POPULATED_UNVERIFIABLE" : "UNSUPPORTED", "ats", false);
  }
  const answer = answers.get(mapping.canonicalKey);
  const existing = field.existingValue.trim();
  if (!existing) {
    return record(
      field,
      mapping.canonicalKey,
      answer?.value != null && String(answer.value).trim() !== ""
        ? "EMPTY_AND_RESOLVABLE"
        : "EMPTY_AND_MISSING_INFORMATION",
      answer ? "jobpilot_profile" : "none",
      Boolean(answer && mapping.safeToAutoFill)
    );
  }
  if (!answer?.value) {
    return record(field, mapping.canonicalKey, "ATS_POPULATED_UNVERIFIABLE", "ats", false);
  }
  const matches = equivalentValue(mapping.canonicalKey, existing, String(answer.value));
  return record(
    field,
    mapping.canonicalKey,
    matches ? "ATS_POPULATED_MATCH" : "ATS_POPULATED_CONFLICT",
    "ats",
    false
  );
}

function record(
  field: DiscoveredField,
  canonicalKey: string | null,
  classification: ReconciliationClass,
  provenance: ReconciledField["provenance"],
  mayFill: boolean
): ReconciledField {
  return { uid: field.uid, canonicalKey, classification, provenance, mayFill };
}

export function equivalentValue(canonicalKey: string, left: string, right: string): boolean {
  if (canonicalKey === "phone" || canonicalKey === "phone_national") {
    return digits(left) === digits(right);
  }
  if (/url|linkedin|github|portfolio|website/.test(canonicalKey)) {
    return normalizedUrl(left) === normalizedUrl(right);
  }
  if (/date|month|year/.test(canonicalKey)) {
    return normalizedDate(left) === normalizedDate(right);
  }
  if (canonicalKey === "country") {
    const aliases: Record<string, string> = {
      us: "united states", usa: "united states", "u s": "united states",
      uk: "united kingdom", "u k": "united kingdom"
    };
    const a = normalizedText(left); const b = normalizedText(right);
    return (aliases[a] ?? a) === (aliases[b] ?? b);
  }
  return normalizedText(left) === normalizedText(right);
}

function normalizedText(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}
function digits(value: string): string { return value.replace(/\D/g, "").replace(/^1(?=\d{10}$)/, ""); }
function normalizedDate(value: string): string {
  const numeric = value.trim().match(/(\d{4}).*?(\d{1,2})/);
  if (numeric) return `${numeric[1]}-${numeric[2].padStart(2, "0")}`;
  const named = value.trim().match(/([a-z]+).*?(\d{4})/i);
  return named ? `${named[2]}-${named[1].toLowerCase()}` : normalizedText(value);
}
function normalizedUrl(value: string): string {
  try {
    const url = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`);
    return `${url.hostname.toLowerCase().replace(/^www\./, "")}${url.pathname.replace(/\/+$/, "").toLowerCase()}`;
  } catch { return normalizedText(value); }
}

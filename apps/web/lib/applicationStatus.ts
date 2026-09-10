/**
 * Application status — the one place the product decides what a tracker status
 * *means*.
 *
 * The Dashboard and the Tracker both render the same application records, and
 * before this module each screen carried its own copy of the mapping: the
 * Dashboard in canonical design-system tones, the Tracker in hand-written
 * colour classes. They agreed by accident rather than by construction, which is
 * exactly the kind of pair that drifts the first time a status is added.
 *
 * What lives here is the domain semantic only — which status is a good outcome,
 * which is a bad one, which is still in flight. Display copy deliberately does
 * NOT live here: the Tracker calls an offer "Offer / selected" because that is
 * the name of the workflow stage the user moves an application into, while the
 * Dashboard's dense badge says "Offer". Both are correct for their context, so
 * each screen owns its own wording on top of the shared meaning.
 *
 * This module is pure by design — no React, no API client, no component
 * imports — so either screen can consume it without pulling the other's module
 * graph along, and so the mapping can be tested as data.
 */

/** Every status the backend currently persists for a tracked application. */
export type ApplicationStatus =
  | "saved"
  | "ready_to_apply"
  | "applying"
  | "applied"
  | "interview"
  | "offer"
  | "rejected"
  | "withdrawn";

/**
 * Semantic tone, not a colour.
 *
 * Structurally identical to the design system's `StatusTone`, but declared here
 * so `lib/` never depends on component internals — the same layering every
 * other module in this directory follows. A contract test asserts the two stay
 * assignable to each other, so the duplication cannot silently diverge.
 */
export type ApplicationStatusTone = "neutral" | "info" | "success" | "warning" | "danger";

/**
 * Status → meaning.
 *
 * `offer` is the one genuine success in the lifecycle and is the only status
 * that earns green. `rejected` is the one genuine failure. Everything a user is
 * actively working — applying, applied — is amber because it is in flight and
 * may need attention, and `interview` is informational: it is progress worth
 * noticing but not yet an outcome. Statuses that merely park a job — saved,
 * ready to apply, withdrawn — carry no judgement and stay neutral.
 */
const STATUS_TONES: Record<ApplicationStatus, ApplicationStatusTone> = {
  saved: "neutral",
  ready_to_apply: "neutral",
  applying: "warning",
  applied: "warning",
  interview: "info",
  offer: "success",
  rejected: "danger",
  withdrawn: "neutral"
};

/** True for a status this build knows about, narrowing an arbitrary string. */
export function isApplicationStatus(value: unknown): value is ApplicationStatus {
  return typeof value === "string" && Object.hasOwn(STATUS_TONES, value);
}

/**
 * The tone for a status.
 *
 * Accepts a bare string rather than the union because the Dashboard's payload
 * types `status` as a plain string, and because the backend can start returning
 * a status this build has never heard of. An unknown value is not an error
 * worth breaking a screen over — it renders neutral, which reads as "no
 * judgement" rather than mislabelling a rejection as a win.
 */
export function getApplicationStatusTone(
  status: string | null | undefined
): ApplicationStatusTone {
  return isApplicationStatus(status) ? STATUS_TONES[status] : "neutral";
}

/**
 * The compact, neutral label for a status.
 *
 * `ready_to_apply` reads as "Saved" because that is what the user did — the
 * underscored value is a backend detail. Anything unrecognised is humanised
 * rather than hidden, so a new backend status still shows something truthful
 * instead of a blank badge.
 */
export function formatApplicationStatus(status: string | null | undefined): string {
  if (!status) return "";
  if (status === "ready_to_apply") return "Saved";
  return status.replaceAll("_", " ").replace(/^\w/, (letter) => letter.toUpperCase());
}

import type { DiscoveredField } from "../types";

export interface FieldIdentityContext {
  applicationSessionId: number;
  domGeneration: number;
}

/**
 * Generation-scoped identity for diagnostics and final inventory joins.
 *
 * Values, geometry, and array position are deliberately absent. Two empty
 * custom comboboxes remain distinct through their accessible question,
 * section, structural path, role, and ARIA relationships. A post-parse node can
 * never collide with its detached pre-parse predecessor because generation is
 * part of the fingerprint.
 */
export function fieldFingerprint(
  field: DiscoveredField,
  context: FieldIdentityContext,
  root: ParentNode = document
): string {
  const element = field.element;
  const input = [
    context.applicationSessionId,
    context.domGeneration,
    field.frameId,
    normalize(field.sectionHeading),
    normalize(field.label || field.ariaLabel || field.nearbyText),
    field.control,
    element?.tagName.toLowerCase() ?? "detached",
    element?.getAttribute("role") ?? "",
    structuralPath(element, root),
    element?.getAttribute("aria-labelledby") ?? "",
    element?.getAttribute("aria-controls") ?? "",
    element?.getAttribute("aria-owns") ?? "",
    field.name,
    field.id
  ].join("\u001f");
  return `field_${hash(input)}`;
}

export function structuralPath(element: HTMLElement | undefined, root: ParentNode): string {
  if (!element?.isConnected) return "detached";
  const parts: string[] = [];
  let node: HTMLElement | null = element;
  for (let depth = 0; node && node !== root && depth < 8; depth += 1) {
    const role = node.getAttribute("role") ?? "";
    const tag = node.tagName.toLowerCase();
    const siblings = node.parentElement
      ? Array.from(node.parentElement.children).filter((candidate) =>
          candidate.tagName === node!.tagName && candidate.getAttribute("role") === role
        )
      : [];
    const ordinal = Math.max(0, siblings.indexOf(node));
    parts.push(`${tag}[${role || "none"}:${ordinal}]`);
    node = node.parentElement;
  }
  return parts.reverse().join(">");
}

function normalize(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function hash(value: string): string {
  let result = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    result ^= value.charCodeAt(index);
    result = Math.imul(result, 16777619);
  }
  return (result >>> 0).toString(16).padStart(8, "0");
}

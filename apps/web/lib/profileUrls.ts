/**
 * Small user-facing counterpart to the authoritative backend ProfileUrl type.
 * Browser URL parsing supplies canonical serialization; the backend still owns
 * final validation and is intentionally not reimplemented here.
 */
export function normalizeOptionalProfileUrl(value: string): string {
  const text = value.trim();
  if (!text) return "";

  // Preserve every explicit unsupported scheme as invalid input. Prefixing it
  // would turn e.g. javascript: into a misleading https-looking string.
  const scheme = text.match(/^([a-z][a-z0-9+.-]*):/i)?.[1]?.toLowerCase();
  if (scheme && scheme !== "http" && scheme !== "https") return text;
  if (text.startsWith("//")) return text;

  const candidate = scheme ? text : `https://${text}`;
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return text;
    // Match the backend's user-friendly bare-host boundary without inventing a
    // URL regex: dotted hosts, IP literals, and localhost are qualified.
    if (
      !scheme &&
      parsed.hostname !== "localhost" &&
      !parsed.hostname.includes(".") &&
      !parsed.hostname.includes(":")
    ) {
      return text;
    }
    return parsed.toString();
  } catch {
    return text;
  }
}

export function isValidOptionalUrl(value: string): boolean {
  const normalized = normalizeOptionalProfileUrl(value);
  if (!normalized) return true;
  try {
    const parsed = new URL(normalized);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

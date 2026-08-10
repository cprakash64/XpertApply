/**
 * URL validation for profile links.
 *
 * Deliberately the same rule the profile wizard has always applied — an empty
 * value is allowed (the field is optional), and anything present must be
 * http(s). Kept in a plain module so the wizard and the focused editors share
 * one definition rather than drifting into two slightly different rules.
 */
export function isValidOptionalUrl(value: string): boolean {
  return !value || value.startsWith("http://") || value.startsWith("https://");
}

/** Static-safe observation policy. Enforcement and inline-script resolution
 * remain separate production gates; no nonce, request state or reporting URL.
 *
 * Known, deliberate violation while Report-Only: Next.js prerenders an inline `self.__next_f.push(...)` flight
 * script into every page, and `script-src 'self'` reports it. Static HTML cannot carry a per-request nonce and
 * the payload differs per page, so this policy must not be enforced until that is resolved (see
 * docs/plans/edge-security-headers-csp.md). */
export const CSP_HEADER = "Content-Security-Policy-Report-Only";
export const ENFORCED_CSP_HEADER = "Content-Security-Policy";
export const CSP_PAGE_SOURCE = "/((?!_next(?:/|$)|api(?:/|$)|brand(?:/|$)|.*\\.[^/]+$).*)";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** The API origin the browser bundle talks to, resolved exactly as `lib/api.ts` does (same variable, same
 * local fallback) so the policy and the bundle cannot disagree. Evaluated when Next loads this config, i.e. at
 * build time, which is also when NEXT_PUBLIC_API_URL is inlined into the bundle.
 * @param {Record<string, string | undefined>} [env] */
export function apiOrigin(env = process.env) {
  const raw = (env.NEXT_PUBLIC_API_URL || "").trim() || "http://localhost:8000";
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("NEXT_PUBLIC_API_URL is not a valid URL");
  }
  const local = LOCAL_HOSTS.has(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
    throw new Error("NEXT_PUBLIC_API_URL must be https (plain http only for localhost)");
  }
  return url.origin;
}

/** @param {Array<[string, string[]]>} directives */
export function serializePolicy(directives) {
  const seen = new Set();
  return directives.map(([name, values]) => {
    if (!/^[a-z][a-z-]*$/.test(name) || seen.has(name)) {
      throw new Error("Invalid or duplicate CSP directive");
    }
    seen.add(name);
    if (values.some(value => !value || /[\s;]/.test(value))) {
      throw new Error("Invalid CSP source token");
    }
    return [name, ...values].join(" ");
  }).join("; ");
}

/** @param {Record<string, string | undefined>} [env] */
export function reportOnlyPolicy(env = process.env) {
  const api = apiOrigin(env);
  return serializePolicy([
    ["default-src", ["'self'"]],
    ["script-src", ["'self'"]],
    ["style-src", ["'self'"]],
    ["style-src-attr", ["'unsafe-inline'"]],
    ["img-src", ["'self'", api, "data:", "blob:"]],
    ["font-src", ["'self'"]],
    ["connect-src", ["'self'", api]],
    ["frame-src", ["'none'"]],
    ["frame-ancestors", ["'none'"]],
    ["object-src", ["'none'"]],
    ["base-uri", ["'self'"]],
    ["form-action", ["'self'"]],
    // Ignored by browsers in Report-Only mode (they log a console notice, not a violation). Dropped for a local
    // http API, where upgrading would break the request once the policy is ever enforced.
    ...(api.startsWith("https:") ? [["upgrade-insecure-requests", []]] : [])
  ]);
}

/** @param {Record<string, string | undefined>} [env] */
export function reportOnlyHeaders(env = process.env) {
  return [{ source: CSP_PAGE_SOURCE, headers: [{ key: CSP_HEADER, value: reportOnlyPolicy(env) }] }];
}

/** Minimal ENFORCED baseline, independent of the Report-Only policy above. It governs no script, style, image or
 * connection, so it cannot affect rendering or hydration, and it carries no per-environment origin.
 * `form-action` is deliberately absent until cross-browser auth/integration flows are verified. */
export function enforcedPolicy() {
  return serializePolicy([
    ["frame-ancestors", ["'none'"]],
    ["object-src", ["'none'"]],
    ["base-uri", ["'self'"]]
  ]);
}

export function enforcedHeaders() {
  return [{ source: CSP_PAGE_SOURCE, headers: [{ key: ENFORCED_CSP_HEADER, value: enforcedPolicy() }] }];
}

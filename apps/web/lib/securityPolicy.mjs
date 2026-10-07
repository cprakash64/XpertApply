/** Static-safe observation policy. Enforcement and inline-script resolution
 * remain separate production gates; no nonce, request state or reporting URL. */
export const CSP_HEADER = "Content-Security-Policy-Report-Only";
export const CSP_PAGE_SOURCE = "/((?!_next(?:/|$)|api(?:/|$)|brand(?:/|$)|.*\\.[^/]+$).*)";

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

export function reportOnlyPolicy() {
  return serializePolicy([
    ["default-src", ["'self'"]],
    ["script-src", ["'self'"]],
    ["style-src", ["'self'"]],
    ["style-src-attr", ["'unsafe-inline'"]],
    ["img-src", ["'self'", "https://api.xpertapply.com", "data:", "blob:"]],
    ["font-src", ["'self'"]],
    ["connect-src", ["'self'", "https://api.xpertapply.com"]],
    ["frame-src", ["'none'"]],
    ["frame-ancestors", ["'none'"]],
    ["object-src", ["'none'"]],
    ["base-uri", ["'self'"]],
    ["form-action", ["'self'"]],
    ["upgrade-insecure-requests", []]
  ]);
}

export function reportOnlyHeaders() {
  return [{ source: CSP_PAGE_SOURCE, headers: [{ key: CSP_HEADER, value: reportOnlyPolicy() }] }];
}

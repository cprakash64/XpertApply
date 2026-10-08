import { randomBytes } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { reportOnlyPolicy } from "./lib/securityPolicy.mjs";

// Reviewed constant for installed Next 16.3.5 builtin fatal fallback CSS only.
// Qualification experiment; future version/hash drift must fail closed until review.
const FRAMEWORK_FATAL_STYLE_HASH = "'sha256-Wwucq8eX2r0YFymkQhDXm5hN0+FfSvI3s4JSSaqa4iw='";

// Qualification experiment only: one server-generated authority per response.
export function proxy(request: NextRequest) {
  const nonce = randomBytes(16).toString("base64");
  const policy = reportOnlyPolicy()
    .replace("script-src 'self'", `script-src 'self' 'nonce-${nonce}'`)
    .replace("style-src 'self'", `style-src 'self' ${FRAMEWORK_FATAL_STYLE_HASH}`);
  const forwarded = new Headers(request.headers);
  forwarded.delete("content-security-policy-report-only");
  forwarded.set("content-security-policy", policy);
  forwarded.set("x-nonce", nonce);
  const response = NextResponse.next({ request: { headers: forwarded } });
  response.headers.set("Content-Security-Policy", policy);
  // Assets retain their native cache policy; any fallback HTML is dynamically no-store.
  const assetPath = request.nextUrl.pathname.startsWith("/_next/static/") ||
    request.nextUrl.pathname.startsWith("/brand/") || request.nextUrl.pathname === "/csp-error.css";
  if (!assetPath) response.headers.set("Cache-Control", "private, no-store");
  return response;
}
export const config = { matcher: ["/:path*"] };

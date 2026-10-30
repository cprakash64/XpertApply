#!/usr/bin/env bash
# Public, read-only check of S1 (edge headers) and S2 (per-environment CSP origin) on staging, plus production non-impact.
# Plain HTTPS GETs only; no cookies or credentials. Expect FAIL on the staging S1 rows before the nginx patch, all PASS after.
set -uo pipefail
W=https://staging.xpertapply.com; A=https://api-staging.xpertapply.com; PW=https://xpertapply.com; PA=https://api.xpertapply.com
hdr() { curl -sS -o /dev/null -D - --max-time 15 "$1" 2>/dev/null | tr -d '\r'; }
fail=0
one() { # label url header expected-substring   (header must occur exactly once and contain the substring)
  local out c v; out="$(hdr "$2")"; c="$(grep -ic "^$3:" <<<"$out")"; v="$(grep -i "^$3:" <<<"$out" | head -1)"
  if [[ "$c" == 1 && "$v" == *"$4"* ]]; then echo "PASS  $1"; else echo "FAIL  $1  (count=$c)"; fail=1; fi; }
none() { local out; out="$(hdr "$2")"; if grep -qi "^$3:" <<<"$out"; then echo "FAIL  $1  (present)"; fail=1; else echo "PASS  $1"; fi; }
echo "== staging web: edge headers (S1)"
for p in / /login /__no_such_page__ /robots.txt; do
  one "web $p HSTS"     "$W$p" strict-transport-security "max-age="
  one "web $p nosniff"  "$W$p" x-content-type-options nosniff
  one "web $p XFO"      "$W$p" x-frame-options DENY
  one "web $p Referrer" "$W$p" referrer-policy strict-origin-when-cross-origin
done
one "web /forgot-password keeps no-referrer (single header)" "$W/forgot-password" referrer-policy "no-referrer"
one "web /forgot-password single X-Robots-Tag" "$W/forgot-password" x-robots-tag noindex
echo "== staging api"
one "api HSTS"   "$A/health" strict-transport-security "max-age="
one "api nosniff" "$A/health" x-content-type-options nosniff
echo "== CSP (S2): staging must name the staging API, never the production API"
csp="$(hdr "$W/" | grep -i '^content-security-policy-report-only:')"
[[ "$csp" == *"connect-src 'self' $A"* && "$csp" != *"$PA"* ]] && echo "PASS  staging connect-src is $A only" || { echo "FAIL  staging CSP origin"; fail=1; }
hdr "$W/" | grep -qi '^content-security-policy:' && { echo "FAIL  staging CSP is enforced (must stay Report-Only)"; fail=1; } || echo "PASS  staging CSP still Report-Only"
echo "== production non-impact (read-only baseline; must not change)"
one "prod web HSTS (unchanged)" "$PW/" strict-transport-security "max-age=86400"
one "prod web XFO"              "$PW/" x-frame-options DENY
none "prod web has no X-Robots-Tag" "$PW/" x-robots-tag
csp="$(hdr "$PW/" | grep -i '^content-security-policy-report-only:')"
[[ "$csp" == *"connect-src 'self' $PA;"* ]] && echo "PASS  prod CSP connect-src is $PA" || { echo "FAIL  prod CSP origin"; fail=1; }
exit $fail

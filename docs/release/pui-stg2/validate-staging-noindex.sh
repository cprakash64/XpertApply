#!/usr/bin/env bash
# Public, read-only validation of staging indexing controls and production non-impact. Plain HTTPS requests only.
#   bash validate-staging-noindex.sh            # expect FAIL on the staging header checks BEFORE the nginx patch, all PASS after
set -uo pipefail
W=https://staging.xpertapply.com; A=https://api-staging.xpertapply.com; PW=https://xpertapply.com; PA=https://api.xpertapply.com
want="x-robots-tag: noindex, nofollow"; fail=0
hdr() { curl -sS -o /dev/null -D - --max-time 15 ${2:+-H "$2"} "$1" 2>/dev/null | tr -d '\r' | tr 'A-Z' 'a-z'; }
has() { hdr "$1" | grep -qx "$want"; }
chk() { # label url expect(has|none)
  if { [[ "$3" == has ]] && has "$2"; } || { [[ "$3" == none ]] && ! hdr "$2" | grep -q '^x-robots-tag'; }; then echo "PASS  $1"; else echo "FAIL  $1  ($3 expected)"; fail=1; fi; }
echo "== staging web (header must be present on every response, including errors and redirects)"
chk "web /"                    "$W/"            has
chk "web /login"               "$W/login"       has
chk "web 404 page"             "$W/__no_such_page__" has
chk "web /robots.txt (kept 404)" "$W/robots.txt" has
chk "web /sitemap.xml (kept 404)" "$W/sitemap.xml" has
chk "web http->https redirect" "http://staging.xpertapply.com/" has
echo "== staging api"
chk "api /healthz"             "$A/healthz"     has
chk "api 404"                  "$A/__no_such_route__" has
chk "api http->https redirect" "http://api-staging.xpertapply.com/healthz" has
echo "== staging behaviour that must NOT change"
[[ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 $W/sitemap.xml)" == 404 ]] && echo "PASS  staging sitemap.xml is not advertised (404)" || { echo "FAIL  staging sitemap.xml is served"; fail=1; }
[[ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 $W/robots.txt)" == 404 ]] && echo "PASS  staging robots.txt stays 404 (crawlers may fetch pages and see the noindex header)" || { echo "FAIL  staging robots.txt changed"; fail=1; }
cors="$(hdr "$A/healthz" "Origin: https://staging.xpertapply.com" | grep '^access-control-allow-origin' | head -1)"; echo "INFO  api CORS for staging origin: ${cors:-<none returned for this path>}"
echo "== production non-impact (must have NO x-robots-tag and keep its security headers)"
chk "prod web /"               "$PW/"           none
chk "prod api"                 "$PA/healthz"    none
for h in strict-transport-security x-content-type-options x-frame-options; do hdr "$PW/" | grep -q "^$h:" && echo "PASS  prod web still sends $h" || { echo "FAIL  prod web lost $h"; fail=1; }; done
exit $fail

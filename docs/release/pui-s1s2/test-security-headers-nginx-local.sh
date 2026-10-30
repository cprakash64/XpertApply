#!/usr/bin/env bash
# Proves the S1 staging header patch against a real nginx 1.24 in Docker with STUB upstreams. Local only: no TLS, no server, no production.
# Base = the live vhost with the (already applied) noindex patch. Usage: bash test-security-headers-nginx-local.sh
set -uo pipefail
D="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; T="$(mktemp -d)"; N=xa-s1-test; trap 'docker rm -f $N >/dev/null 2>&1; rm -rf "$T"' EXIT
cp "$D/xpertapply-staging.noindex-applied.conf" "$T/base.conf"; cp "$T/base.conf" "$T/patched.conf"
patch -s "$T/patched.conf" < "$D/xpertapply-staging-security-headers.patch" || { echo "FAIL patch does not apply"; exit 1; }
mk() { sed -E 's/listen 443 ssl;/listen 8443;/; /ssl_certificate/d' "$1" > "$2"; }
stub() { cat <<'S'
server { listen 127.0.0.1:3001;
  location = /forgot-password { add_header Referrer-Policy "no-referrer"; add_header X-Robots-Tag "noindex, nofollow"; add_header Cache-Control "no-store"; return 200 "r"; }
  location = /missing { return 404 "nf"; } location = /boom { return 500 "err"; } location / { return 200 "web"; } }
server { listen 127.0.0.1:8021; location = /nope { return 404 "nf"; } location / { return 200 "api"; } }
S
}
run() {
  mk "$T/$1.conf" "$T/vhost-$1.conf"
  { echo 'events {}'; echo 'http {'; cat "$T/vhost-$1.conf"; stub; echo '}'; } > "$T/nginx-$1.conf"
  docker rm -f $N >/dev/null 2>&1
  docker run -d --name $N -v "$T/nginx-$1.conf:/etc/nginx/nginx.conf:ro" -v "$D/snippets:/etc/nginx/snippets:ro" -p 127.0.0.1:18080:80 -p 127.0.0.1:18443:8443 nginx:1.24 >/dev/null || { echo "docker run failed"; exit 1; }
  sleep 2; docker exec $N nginx -t 2>&1 | tail -1
}
hdrs() { curl -s -o /dev/null -D - --max-time 5 -H "Host: $2" "$1" | tr -d '\r'; }
fail=0
# check LABEL URL HOST STATUS name=expected-value ...   (value "-" = header must be absent; every named header must occur exactly once)
check() { local l="$1" u="$2" h="$3" st="$4"; shift 4; local out; out="$(hdrs "$u" "$h")"; local ok=1 g
  [[ "$(head -1 <<<"$out" | awk '{print $2}')" == "$st" ]] || ok=0
  for kv in "$@"; do local n="${kv%%=*}" v="${kv#*=}"; local c; c="$(grep -ic "^$n:" <<<"$out")"
    if [[ "$v" == "-" ]]; then [[ "$c" == 0 ]] || ok=0
    else g="$(grep -i "^$n:" <<<"$out" | head -1 | cut -d' ' -f2- )"; [[ "$c" == 1 && "$g" == "$v" ]] || { ok=0; echo "      $n: count=$c got='$g' want='$v'"; }; fi; done
  [[ $ok == 1 ]] && echo "PASS  $l [$st]" || { echo "FAIL  $l [$st]"; fail=1; }; }
WEB=("Strict-Transport-Security=max-age=300" "X-Content-Type-Options=nosniff" "X-Frame-Options=DENY" "Referrer-Policy=strict-origin-when-cross-origin" "X-Robots-Tag=noindex, nofollow")
API=("Strict-Transport-Security=max-age=300" "X-Content-Type-Options=nosniff" "X-Frame-Options=-" "X-Robots-Tag=noindex, nofollow")
echo "== BEFORE the patch: the S1 headers are absent (the finding)"; run base
check "web / has no S1 headers" http://127.0.0.1:18443/ staging.xpertapply.com 200 "Strict-Transport-Security=-" "X-Frame-Options=-" "X-Content-Type-Options=-"
echo "== AFTER the patch"; run patched
check "web / (200)"            http://127.0.0.1:18443/            staging.xpertapply.com 200 "${WEB[@]}"
check "web upstream 404"       http://127.0.0.1:18443/missing     staging.xpertapply.com 404 "${WEB[@]}"
check "web upstream 500"       http://127.0.0.1:18443/boom        staging.xpertapply.com 500 "${WEB[@]}"
check "web /robots.txt (404)"  http://127.0.0.1:18443/robots.txt  staging.xpertapply.com 404 "${WEB[@]}"
check "web /sitemap.xml (404)" http://127.0.0.1:18443/sitemap.xml staging.xpertapply.com 404 "${WEB[@]}"
check "recovery page keeps the app's no-referrer, exactly once, no duplicate X-Robots-Tag" http://127.0.0.1:18443/forgot-password staging.xpertapply.com 200 "Referrer-Policy=no-referrer" "X-Robots-Tag=noindex, nofollow" "Strict-Transport-Security=max-age=300" "X-Frame-Options=DENY" "Cache-Control=no-store"
check "web Permissions-Policy present once" http://127.0.0.1:18443/ staging.xpertapply.com 200 "Permissions-Policy=camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), accelerometer=(), gyroscope=(), fullscreen=(), clipboard-read=(), clipboard-write=(self)"
check "api / (200)"            http://127.0.0.1:18443/            api-staging.xpertapply.com 200 "${API[@]}"
check "api upstream 404"       http://127.0.0.1:18443/nope        api-staging.xpertapply.com 404 "${API[@]}"
check "port 80 redirect carries noindex only (HSTS is ignored over http)" http://127.0.0.1:18080/x staging.xpertapply.com 301 "X-Robots-Tag=noindex, nofollow" "Strict-Transport-Security=-"
echo "== nginx-generated 502 (upstream down)"
docker rm -f $N >/dev/null 2>&1
sed -E 's#proxy_pass http://127.0.0.1:3001#proxy_pass http://127.0.0.1:3999#' "$T/vhost-patched.conf" > "$T/vhost-down.conf"
{ echo 'events {}'; echo 'http {'; cat "$T/vhost-down.conf"; echo '}'; } > "$T/nginx-down.conf"
docker run -d --name $N -v "$T/nginx-down.conf:/etc/nginx/nginx.conf:ro" -v "$D/snippets:/etc/nginx/snippets:ro" -p 127.0.0.1:18443:8443 nginx:1.24 >/dev/null; sleep 2
check "web upstream DOWN -> 502" http://127.0.0.1:18443/ staging.xpertapply.com 502 "${WEB[@]}"
exit $fail

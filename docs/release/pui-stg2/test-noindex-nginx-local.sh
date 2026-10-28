#!/usr/bin/env bash
# Proves the staging noindex patch against a real nginx 1.24 in Docker, with STUB upstreams. Local only; no server, no TLS, no production.
# Usage: bash test-noindex-nginx-local.sh   (needs Docker; pulls the official nginx:1.24 image if absent)
set -uo pipefail
D="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; T="$(mktemp -d)"; trap 'docker rm -f xa-noindex-test >/dev/null 2>&1; rm -rf "$T"' EXIT
cp "$D/xpertapply-staging.live-base.conf" "$T/base.conf"; cp "$T/base.conf" "$T/patched.conf"; patch -s "$T/patched.conf" < "$D/xpertapply-staging-noindex.patch" || { echo "FAIL patch does not apply"; exit 1; }
# Make a runnable copy: no TLS (8443 plain), stub upstreams on the same loopback ports the vhost proxies to.
mk() { sed -E 's/listen 443 ssl;/listen 8443;/; /ssl_certificate/d' "$1" > "$2"; }
stub() { cat <<'S'
server { listen 127.0.0.1:3001; location = /robots.txt { return 200 "User-agent: *\nAllow: /\nSitemap: https://staging.xpertapply.com/sitemap.xml\n"; } location = /sitemap.xml { return 200 "<urlset/>"; }
  location = /missing { return 404 "nf"; } location = /boom { return 500 "err"; } location / { return 200 "web"; } }
server { listen 127.0.0.1:8021; location = /nope { return 404 "nf"; } location / { return 200 "api"; } }
server { listen 127.0.0.1:3000; location / { return 200 "prod-web"; } }
server { listen 8444; server_name xpertapply.com www.xpertapply.com api.xpertapply.com; add_header Strict-Transport-Security "max-age=86400" always; add_header X-Frame-Options "DENY" always; location / { proxy_pass http://127.0.0.1:3000; } }
S
}
run() { # $1 = config file label
  mk "$T/$1.conf" "$T/vhost-$1.conf"
  { echo 'events {}'; echo 'http {'; echo '  include /etc/nginx/mime.types;'; cat "$T/vhost-$1.conf"; stub; echo '}'; } > "$T/nginx-$1.conf"
  docker rm -f xa-noindex-test >/dev/null 2>&1
  docker run -d --name xa-noindex-test -v "$T/nginx-$1.conf:/etc/nginx/nginx.conf:ro" -p 127.0.0.1:18080:80 -p 127.0.0.1:18443:8443 -p 127.0.0.1:18444:8444 nginx:1.24 >/dev/null || { echo "docker run failed"; exit 1; }
  sleep 2; docker exec xa-noindex-test nginx -t 2>&1 | tail -1
}
H() { curl -s -o /dev/null -D - --max-time 5 -H "Host: $2" "$1" | tr -d '\r' | grep -i '^x-robots-tag' | head -1 | tr 'A-Z' 'a-z'; }
S() { curl -s -o /dev/null -w '%{http_code}' --max-time 5 -H "Host: $2" "$1"; }
fail=0
check() { # label url host expect(has|none) expected_status
  local got st; got="$(H "$2" "$3")"; st="$(S "$2" "$3")"
  if [[ "$4" == has && "$got" == "x-robots-tag: noindex, nofollow" || "$4" == none && -z "$got" ]] && [[ -z "${5:-}" || "$st" == "$5" ]]; then echo "PASS  $1 [$st] header=${got:-<absent>}"; else echo "FAIL  $1 [$st] header=${got:-<absent>} (want $4 ${5:-})"; fail=1; fi
}
echo "== BEFORE the patch (live base): header must be absent everywhere"; run base
check "web /"                       http://127.0.0.1:18443/            staging.xpertapply.com none 200
check "api /nope"                   http://127.0.0.1:18443/nope        api-staging.xpertapply.com none 404
echo "== AFTER the patch"; run patched
check "web / (proxied 200)"         http://127.0.0.1:18443/            staging.xpertapply.com has 200
check "web /login (nested path)"    http://127.0.0.1:18443/login       staging.xpertapply.com has 200
check "web upstream 404"            http://127.0.0.1:18443/missing     staging.xpertapply.com has 404
check "web upstream 500"            http://127.0.0.1:18443/boom        staging.xpertapply.com has 500
check "web /robots.txt hidden (404)" http://127.0.0.1:18443/robots.txt  staging.xpertapply.com has 404
check "web /sitemap.xml hidden (404)" http://127.0.0.1:18443/sitemap.xml staging.xpertapply.com has 404
check "api / (proxied 200)"         http://127.0.0.1:18443/            api-staging.xpertapply.com has 200
check "api upstream 404"            http://127.0.0.1:18443/nope        api-staging.xpertapply.com has 404
check "port 80 -> 301 redirect"     http://127.0.0.1:18080/anything    staging.xpertapply.com has 301
check "ACME path (404 when absent)" http://127.0.0.1:18080/.well-known/acme-challenge/x staging.xpertapply.com has 404
check "PRODUCTION host unchanged"   http://127.0.0.1:18444/            xpertapply.com none 200
check "PRODUCTION api host unchanged" http://127.0.0.1:18444/          api.xpertapply.com none 200
echo "== nginx-generated 502 (upstream down)"
docker rm -f xa-noindex-test >/dev/null 2>&1
sed -E 's#proxy_pass http://127.0.0.1:3001#proxy_pass http://127.0.0.1:3999#' "$T/vhost-patched.conf" > "$T/vhost-down.conf"
{ echo 'events {}'; echo 'http {'; cat "$T/vhost-down.conf"; echo '}'; } > "$T/nginx-down.conf"
docker run -d --name xa-noindex-test -v "$T/nginx-down.conf:/etc/nginx/nginx.conf:ro" -p 127.0.0.1:18443:8443 nginx:1.24 >/dev/null; sleep 2
check "web upstream DOWN -> nginx 502" http://127.0.0.1:18443/ staging.xpertapply.com has 502
exit $fail

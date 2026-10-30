#!/usr/bin/env bash
# Exercises staging-nginx-s1.sh end to end against a REAL nginx 1.24 in a throw-away Docker container: real TLS,
# the reviewed baseline as the staging vhost behind a symlink, a production-style vhost, an unrelated vhost that
# already produces an nginx -t warning (stand-in for the VeoTrex TLS warning), and stub upstreams. Local only.
#   bash test-s1-nginx-local.sh        (needs Docker and network access for `apt-get install patch` inside the container)
set -uo pipefail
D="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; N=xa-s1-script-test; fail=0
trap 'docker rm -f $N >/dev/null 2>&1' EXIT
pass() { echo "PASS  $1"; }; bad() { echo "FAIL  $1"; fail=1; }
T() { docker exec -e XA_S1_SELFTEST=1 -e XA_S1_FAKE_HOSTNAME="${HOSTNAME_OVERRIDE:-srv738314}" -e XA_S1_NGINX_DIR=/etc/nginx -e XA_S1_STATE_DIR=/var/backups/xa-s1 \
  -e XA_S1_RELOAD_CMD="nginx -s reload" \
  -e XA_S1_CURL_ARGS="-k --resolve staging.xpertapply.com:443:127.0.0.1 --resolve api-staging.xpertapply.com:443:127.0.0.1 --resolve xpertapply.com:443:127.0.0.1 --resolve api.xpertapply.com:443:127.0.0.1 --resolve veotrex.test:443:127.0.0.1" \
  -e XA_S1_CURL_HTTP_ARGS="--resolve staging.xpertapply.com:80:127.0.0.1 --resolve api-staging.xpertapply.com:80:127.0.0.1" \
  -e XA_S1_EXPECT_BASE_SHA="$BASE_SHA" -e XA_S1_EXTRA_URLS="https://veotrex.test/health" "$@"; }
X() { docker exec "$N" bash -c "$1"; }
use() { X "cp /root/stubs.$1 /etc/nginx/sites-available/stubs && nginx -s reload 2>/dev/null; sleep 1"; }
S1() { T "$N" bash /rel/staging-nginx-s1.sh "$@"; }

echo "== build the throw-away host"
docker rm -f $N >/dev/null 2>&1
docker run -d --name $N -v "$D:/rel:ro" nginx:1.24 sleep infinity >/dev/null || { echo "docker run failed"; exit 1; }
X 'apt-get update -qq >/dev/null 2>&1 && apt-get install -y -qq patch >/dev/null 2>&1; command -v patch >/dev/null' || { echo "cannot install patch in the container (network?)"; exit 1; }
X 'set -e; mkdir -p /etc/letsencrypt/live/xpertapply-staging /etc/nginx/sites-available /etc/nginx/sites-enabled /var/www
openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj "/CN=test" -keyout /etc/letsencrypt/live/xpertapply-staging/privkey.pem -out /etc/letsencrypt/live/xpertapply-staging/fullchain.pem 2>/dev/null
cat > /etc/nginx/nginx.conf <<C
events {}
http { include /etc/nginx/mime.types; include /etc/nginx/sites-enabled/*; }
C
sed "s#<KEYPATH>#/etc/letsencrypt/live/xpertapply-staging/privkey.pem#" /rel/xpertapply-staging.reviewed-baseline.conf > /etc/nginx/sites-available/xpertapply-staging
ln -s /etc/nginx/sites-available/xpertapply-staging /etc/nginx/sites-enabled/xpertapply-staging
cat > /etc/nginx/sites-available/xpertapply <<C
server { listen 443 ssl; server_name xpertapply.com api.xpertapply.com dup.test; ssl_certificate /etc/letsencrypt/live/xpertapply-staging/fullchain.pem; ssl_certificate_key /etc/letsencrypt/live/xpertapply-staging/privkey.pem;
  add_header Strict-Transport-Security "max-age=86400" always; add_header X-Frame-Options "DENY" always; location / { proxy_pass http://127.0.0.1:3000; } }
C
cat > /etc/nginx/sites-available/veotrex <<C
server { listen 443 ssl; server_name veotrex.test dup.test; ssl_certificate /etc/letsencrypt/live/xpertapply-staging/fullchain.pem; ssl_certificate_key /etc/letsencrypt/live/xpertapply-staging/privkey.pem; location /health { return 200 ok; } }
C
cat > /etc/nginx/sites-available/stubs <<C
server { listen 127.0.0.1:3000; location / { return 200 prod; } }
server { listen 127.0.0.1:3001; add_header Content-Security-Policy-Report-Only "default-src self" always;
  location ~ ^/(forgot-password|reset-password)\$ { add_header Referrer-Policy "no-referrer" always; add_header X-Robots-Tag "noindex, nofollow" always; add_header Cache-Control no-store always; add_header Content-Security-Policy-Report-Only "default-src self" always; return 200 r; }
  location = /__s1_no_such_page__ { return 404 nf; } location / { return 200 web; } }
server { listen 127.0.0.1:8021; location = /jobs { return 401 "{}"; } location / { if (\$http_origin = "https://staging.xpertapply.com") { add_header Access-Control-Allow-Origin \$http_origin always; } return 200 ok; } }
C
cp /etc/nginx/sites-available/stubs /root/stubs.good
sed "s#listen 127.0.0.1:3001; add_header#listen 127.0.0.1:3001; add_header X-Frame-Options SAMEORIGIN always; add_header#" /root/stubs.good > /root/stubs.dupxfo
sed "s#listen 127.0.0.1:3001;#listen 127.0.0.1:3999;#" /root/stubs.good > /root/stubs.down
grep -q SAMEORIGIN /root/stubs.dupxfo
for f in xpertapply veotrex stubs; do ln -s /etc/nginx/sites-available/$f /etc/nginx/sites-enabled/$f; done
nginx -t 2>&1 | tail -3; (nginx; sleep 1)' || { echo "host setup failed"; exit 1; }
BASE_SHA="$(X 'sha256sum /etc/nginx/sites-available/xpertapply-staging' | cut -d' ' -f1)"
OWNER0="$(X 'stat -c "%U:%G %a" /etc/nginx/sites-available/xpertapply-staging')"
echo "   (nginx -t of this host already prints a conflicting-server-name warning, like the real host's VeoTrex warning)"

echo "== preflight"
S1 preflight >/tmp/s1pre.out 2>&1 && pass "preflight passes on the reviewed baseline" || { bad "preflight failed"; sed 's/^/      /' /tmp/s1pre.out | tail -12; }
grep -q "xa_staging_referrer_policy" /tmp/s1pre.out && pass "preflight shows the exact diff" || bad "preflight does not show the diff"
[[ "$(X 'sha256sum /etc/nginx/sites-available/xpertapply-staging' | cut -d' ' -f1)" == "$BASE_SHA" ]] && pass "preflight changed nothing" || bad "preflight changed the file"
o="$(HOSTNAME_OVERRIDE=other-host S1 preflight 2>&1 || true)"; grep -q "STOP  wrong host" <<<"$o" && pass "refuses a wrong host" || bad "wrong host not refused for the right reason"
X 'echo "# drift" >> /etc/nginx/sites-available/xpertapply-staging'
o="$(S1 preflight 2>&1 || true)"; grep -q "not the verified baseline" <<<"$o" && pass "refuses a source whose SHA-256 is not the verified baseline" || bad "drift not refused for the right reason"
X 'cp /rel/xpertapply-staging.reviewed-baseline.conf /tmp/x; sed "s#<KEYPATH>#/etc/letsencrypt/live/xpertapply-staging/privkey.pem#" /tmp/x > /etc/nginx/sites-available/xpertapply-staging'
X 'rm /etc/nginx/sites-enabled/xpertapply-staging; cp /etc/nginx/sites-available/xpertapply-staging /etc/nginx/sites-enabled/xpertapply-staging'
o="$(S1 preflight 2>&1 || true)"; grep -q "is not a symlink" <<<"$o" && pass "refuses when the enabled path is not a symlink" || bad "symlink guard not triggered"
X 'rm /etc/nginx/sites-enabled/xpertapply-staging; ln -s /etc/nginx/sites-available/xpertapply-staging /etc/nginx/sites-enabled/xpertapply-staging'

echo "== apply: approval gate"
OTHERS0="$(X 'cd /etc/nginx && find . -type f ! -path ./sites-available/xpertapply-staging | sort | xargs sha256sum | sha256sum')"
XA_S1_APPROVE="" S1 apply >/dev/null 2>&1 < /dev/null && bad "apply ran without approval" || pass "apply refuses without explicit approval"
XA_S1_APPROVE="APPLY wrong" T -e XA_S1_APPROVE="APPLY wrong" "$N" bash /rel/staging-nginx-s1.sh apply >/dev/null 2>&1 && bad "apply accepted wrong approval" || pass "apply refuses a wrong approval phrase"
[[ "$(X 'sha256sum /etc/nginx/sites-available/xpertapply-staging' | cut -d' ' -f1)" == "$BASE_SHA" ]] && pass "no mutation without approval" || bad "file changed without approval"

echo "== apply: nginx -t fails after the change -> automatic restore, no reload"
X 'printf "#!/bin/sh\nif [ \"\$1\" = -t ] && grep -q xa_staging_referrer_policy /etc/nginx/sites-available/xpertapply-staging; then echo \"nginx: [emerg] simulated failure\" >&2; exit 1; fi\nexec /usr/sbin/nginx \"\$@\"\n" > /usr/local/bin/nginx-failing; chmod +x /usr/local/bin/nginx-failing'
T -e XA_S1_NGINX_BIN=/usr/local/bin/nginx-failing -e XA_S1_APPROVE="APPLY 6506cb579307" "$N" bash /rel/staging-nginx-s1.sh apply >/tmp/s1f.out 2>&1 && bad "apply succeeded despite nginx -t failure" || pass "apply stops when nginx -t fails"
[[ "$(X 'sha256sum /etc/nginx/sites-available/xpertapply-staging' | cut -d' ' -f1)" == "$BASE_SHA" ]] && pass "original restored automatically after nginx -t failure" || bad "file not restored"

echo "== apply: post-reload verification fails (upstream also sends X-Frame-Options -> duplicate) -> automatic revert"
use dupxfo
S0="$(X 'cd /etc/nginx && find . -type f ! -path ./sites-available/xpertapply-staging | sort | xargs sha256sum | sha256sum')"
XA_S1_APPROVE="APPLY 6506cb579307" T -e XA_S1_APPROVE="APPLY 6506cb579307" "$N" bash /rel/staging-nginx-s1.sh apply >/tmp/s1d.out 2>&1; rc=$?
[[ $rc == 2 ]] && pass "apply exits 2 when live verification fails" || { bad "expected exit 2, got $rc"; tail -15 /tmp/s1d.out; }
grep -q "FAIL  web /login X-Frame-Options exactly once" /tmp/s1d.out && pass "duplicate header detected" || bad "duplicate not detected"
[[ "$(X 'sha256sum /etc/nginx/sites-available/xpertapply-staging' | cut -d' ' -f1)" == "$BASE_SHA" ]] && pass "automatically reverted to the verified baseline" || bad "not reverted"
use good

echo "== apply: success path"
T -e XA_S1_APPROVE="APPLY 6506cb579307" "$N" bash /rel/staging-nginx-s1.sh apply >/tmp/s1a.out 2>&1 && pass "apply succeeds with the approval phrase" || { bad "apply failed"; tail -25 /tmp/s1a.out; }
grep -q "APPLIED AND VERIFIED" /tmp/s1a.out && pass "script verified its own result" || bad "no verification verdict"
[[ "$(X 'readlink /etc/nginx/sites-enabled/xpertapply-staging')" == "/etc/nginx/sites-available/xpertapply-staging" ]] && pass "enabled symlink preserved" || bad "symlink changed"
[[ "$(X 'stat -c "%U:%G %a" /etc/nginx/sites-available/xpertapply-staging')" == "$OWNER0" ]] && pass "owner and mode preserved" || bad "owner/mode changed"
[[ "$(X 'cd /etc/nginx && find . -type f ! -path ./sites-available/xpertapply-staging ! -path "./sites-available/xpertapply-staging.bak-s1-*" | sort | xargs sha256sum | sha256sum')" == "$OTHERS0" ]] && pass "no other nginx file changed" || bad "another nginx file changed"
X 'ls /etc/nginx/sites-available/ | grep -E "bak-s1-.*Z$" | head -1 | xargs -I{} sh -c "test -f /etc/nginx/sites-available/{}.meta && grep -q owner_mode /etc/nginx/sites-available/{}.meta"' && pass "timestamped backups with .meta (owner/mode, source hash) exist" || bad "backup missing"
echo "-- independent header assertions (not using the script)"
C='curl -sk -o /dev/null -D - --max-time 10 --resolve staging.xpertapply.com:443:127.0.0.1 --resolve api-staging.xpertapply.com:443:127.0.0.1'
for r in /login /signup /forgot-password /reset-password /jobs /robots.txt /sitemap.xml /__s1_no_such_page__; do
  h="$(X "$C https://staging.xpertapply.com$r" | tr -d '\r' | tr 'A-Z' 'a-z')"
  for n in strict-transport-security x-frame-options x-content-type-options referrer-policy x-robots-tag; do [[ "$(grep -c "^$n:" <<<"$h")" == 1 ]] || { bad "web $r $n count"; }; done
  [[ "$(grep '^strict-transport-security:' <<<"$h")" == "strict-transport-security: max-age=300" ]] || bad "web $r HSTS value"
  case $r in /forgot-password|/reset-password) grep -q '^referrer-policy: no-referrer$' <<<"$h" || bad "web $r referrer";; *) grep -q '^referrer-policy: strict-origin-when-cross-origin$' <<<"$h" || bad "web $r referrer";; esac
done; pass "web: each security header exactly once on 8 routes; recovery pages keep no-referrer; robots/sitemap 404s carry noindex plus S1"
for r in /healthz /jobs; do h="$(X "$C https://api-staging.xpertapply.com$r" | tr -d '\r' | tr 'A-Z' 'a-z')"; [[ "$(grep -c '^strict-transport-security:' <<<"$h")" == 1 && "$(grep -c '^x-content-type-options:' <<<"$h")" == 1 && "$(grep -c '^x-robots-tag:' <<<"$h")" == 1 && "$(grep -c '^x-frame-options:' <<<"$h")" == 0 ]] || bad "api $r headers"; done; pass "api: HSTS, nosniff, noindex once; unauthorized endpoint included"
grep -q "includesubdomains\|preload" <(X "$C https://staging.xpertapply.com/login" | tr 'A-Z' 'a-z') && bad "HSTS has includeSubDomains/preload" || pass "no includeSubDomains / preload"
X "curl -sk -o /dev/null -D - --resolve staging.xpertapply.com:80:127.0.0.1 http://staging.xpertapply.com/x" | tr -d '\r' | grep -qi '^location: https://staging.xpertapply.com/x' && pass "port-80 redirect intact" || bad "redirect broken"
X 'curl -sk -D - -o /dev/null --resolve xpertapply.com:443:127.0.0.1 https://xpertapply.com/ | tr -d "\r" | grep -i "^strict-transport-security: max-age=86400"' >/dev/null && pass "production-style vhost still answers with its own HSTS" || bad "production vhost changed"

echo "== verify (read-only mode)"
T "$N" bash /rel/staging-nginx-s1.sh verify >/tmp/s1v.out 2>&1 && pass "verify passes" || { bad "verify failed"; grep FAIL /tmp/s1v.out | head; }
use down
T "$N" bash /rel/staging-nginx-s1.sh verify >/tmp/s1v2.out 2>&1 && bad "verify passed with the web upstream down" || pass "verify fails closed when the web upstream is down (502)"
use good

echo "== rollback"
T "$N" bash /rel/staging-nginx-s1.sh rollback >/tmp/s1r.out 2>&1 && pass "rollback succeeds" || { bad "rollback failed"; tail -20 /tmp/s1r.out; }
grep -q "ROLLED BACK AND VERIFIED" /tmp/s1r.out && pass "rollback verified independently (hash, symlink, headers absent, noindex kept)" || bad "no rollback verdict"
[[ "$(X 'sha256sum /etc/nginx/sites-available/xpertapply-staging' | cut -d' ' -f1)" == "$BASE_SHA" ]] && pass "baseline SHA-256 restored" || bad "baseline not restored"
h="$(X "$C https://staging.xpertapply.com/login" | tr -d '\r' | tr 'A-Z' 'a-z')"; grep -q '^strict-transport-security' <<<"$h" && bad "HSTS still present" || pass "S1 headers gone after rollback"
grep -q '^x-robots-tag: noindex, nofollow' <<<"$h" && pass "noindex still present after rollback" || bad "noindex lost"
T "$N" bash /rel/staging-nginx-s1.sh rollback /etc/nginx/sites-available/xpertapply >/dev/null 2>&1 && bad "rollback accepted a non-backup path" || pass "rollback refuses a path that is not a backup"
exit $fail

#!/usr/bin/env bash
# Served-production-image smoke test + coexistence with the S1 nginx headers. Local only; nothing leaves the machine.
#   bash test-s2-image-smoke.sh [image]       default image: xpertapply-staging-web:s2-95de977-amd64
# It runs the real image (linux/amd64, under emulation on Apple silicon) behind a real nginx 1.24 that uses the REVIEWED S1 candidate vhost
# (proxy target swapped to the container), then runs the release script's own live header contract against it from inside the nginx
# container, so the application's CSP headers and nginx's S1 headers are checked together for duplicates and contradictions.
set -uo pipefail
D="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; I="${1:-xpertapply-staging-web:s2-95de977-amd64}"; NET=xa-s2net; W=xa-s2-web; NG=xa-s2-nginx; fail=0
trap 'docker rm -f $W $NG >/dev/null 2>&1; docker network rm $NET >/dev/null 2>&1' EXIT
docker rm -f $W $NG >/dev/null 2>&1; docker network rm $NET >/dev/null 2>&1; docker network create $NET >/dev/null
docker run -d --name $W --network $NET --platform linux/amd64 "$I" >/dev/null || { echo "cannot start image"; exit 1; }
for _ in $(seq 1 60); do docker exec $W node -e 'fetch("http://127.0.0.1:3000/login").then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))' 2>/dev/null && break; sleep 2; done
docker run -d --name $NG --network $NET -v "$D/../pui-s1s2:/s1:ro" nginx:1.24 sleep infinity >/dev/null
docker exec $NG bash -c '
set -e
mkdir -p /etc/letsencrypt/live/xpertapply-staging /etc/nginx/sites-enabled
openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj "/CN=t" -keyout /etc/letsencrypt/live/xpertapply-staging/privkey.pem -out /etc/letsencrypt/live/xpertapply-staging/fullchain.pem 2>/dev/null
printf "events {}\nhttp { include /etc/nginx/mime.types; include /etc/nginx/sites-enabled/*; }\n" > /etc/nginx/nginx.conf
sed -e "s#<KEYPATH>#/etc/letsencrypt/live/xpertapply-staging/privkey.pem#" -e "s#http://127.0.0.1:3001#http://'$W':3000#" /s1/xpertapply-staging.candidate.conf > /etc/nginx/sites-enabled/staging
cat > /etc/nginx/sites-enabled/stub-api <<C
server { listen 127.0.0.1:8021; location = /jobs { return 401 "{}"; } location = /dashboard/summary { return 401 "{}"; } location / { if (\$http_origin = "https://staging.xpertapply.com") { add_header Access-Control-Allow-Origin \$http_origin always; } return 200 ok; } }
C
nginx -t 2>&1 | tail -1; nginx; sleep 1' || { echo "nginx setup failed"; exit 1; }
# the release script'"'"'s own contract code, extracted verbatim
{ echo 'ENFORCED_CSP="frame-ancestors '"'"'none'"'"'; object-src '"'"'none'"'"'; base-uri '"'"'self'"'"'"; STG_API="https://api-staging.xpertapply.com"; STG_WEB="https://staging.xpertapply.com"'
  echo 'ok(){ printf "PASS  %s\n" "$*"; }'
  echo 'CURL=/tmp/curlw'
  sed -n '/^# ---- live header contract/,/^case "\$mode" in/p' "$D/staging-s2-web-release.sh" | sed '$d'
  echo 'FAILS=0; live_headers https://staging.xpertapply.com'
  echo 'getf https://api-staging.xpertapply.com/healthz; chk "$(b "$(hn strict-transport-security)$(hn x-content-type-options)$(hn x-robots-tag)" 111)" "api S1 headers and noindex once"'
  echo 'echo "FAILS=$FAILS"; exit $FAILS'; } > /tmp/contract.sh
docker cp /tmp/contract.sh $NG:/tmp/contract.sh
docker exec $NG bash -c 'printf "#!/bin/sh\nexec curl -k --resolve staging.xpertapply.com:443:127.0.0.1 --resolve api-staging.xpertapply.com:443:127.0.0.1 \"\$@\"\n" > /tmp/curlw; chmod +x /tmp/curlw; bash /tmp/contract.sh' > /tmp/s2contract.out 2>&1; rc=$?
grep -E "^(FAIL |FAILS)" /tmp/s2contract.out; echo "contract checks passed: $(grep -c '^PASS' /tmp/s2contract.out), failed: $(grep -c '^FAIL ' /tmp/s2contract.out)"
[[ $rc == 0 ]] && echo "PASS  live header contract (CSP + S1 coexistence) against the served production image" || { echo "FAIL  header contract"; fail=1; }
echo "-- raw headers for the record (/login and /forgot-password, values only)"
docker exec $NG bash -c 'for p in /login /forgot-password; do echo "## $p"; /tmp/curlw -sS -o /dev/null -D - https://staging.xpertapply.com$p | tr -d "\r" | grep -iE "^(content-security-policy|strict-transport|x-frame|x-content|referrer|x-robots|cache-control|permissions)" | sort -f; done'
echo "-- feature strings in the served bundle (F2 scoring notice, match score, search, Apply dialog Escape handling)"
docker exec $NG bash -c 'P=$(/tmp/curlw -sS https://staging.xpertapply.com/jobs | grep -oE "/_next/static/chunks/[^\"]*\.js" | sort -u); for c in $P; do /tmp/curlw -sS https://staging.xpertapply.com$c; done' > /tmp/jobs-bundle.txt
for s in "Scoring your matches" "Match score" "Role, company or skill"; do grep -q "$s" /tmp/jobs-bundle.txt && echo "PASS  bundle contains '$s'" || { echo "FAIL  bundle lacks '$s'"; fail=1; }; done
echo "-- static pages that must load: $(docker exec $NG bash -c 'for p in / /login /signup /forgot-password /reset-password /dashboard /jobs /tracker /settings /profile /extension/connect /pricing /privacy; do printf "%s=%s " $p $(/tmp/curlw -s -o /dev/null -w "%{http_code}" https://staging.xpertapply.com$p); done')"
exit $fail

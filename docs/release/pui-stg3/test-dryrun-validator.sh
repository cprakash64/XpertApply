#!/usr/bin/env bash
# Regression tests for validate_dry_run() in staging-release-dryrun.sh. Synthetic Compose output only: no Docker, no host.
#   bash test-dryrun-validator.sh        # exit 0 only if every positive case is accepted and every negative case rejected
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
XA_DRYRUN_SOURCE_ONLY=1 source "$HERE/staging-release-dryrun.sh"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
API_ID=a9c4fee1b979; WEB_ID=25e1a88c5e01
pass=0; fail=0
L() { printf ' DRY-RUN MODE -  Container %s  %s\n' "$1" "$2"; }       # one Compose line
api_ok()  { L xpertapply-staging-api Recreate; L xpertapply-staging-api Recreated; L ${API_ID}_xpertapply-staging-api Starting; L ${API_ID}_xpertapply-staging-api Started; }
web_ok()  { L xpertapply-staging-web Recreate; L xpertapply-staging-web Recreated; L ${WEB_ID}_xpertapply-staging-web Starting; L ${WEB_ID}_xpertapply-staging-web Started; }
# accept <label> <service> <id> <rc> <generator...>   /   reject <label> ...
run() { # expect label service id rc gen...
  local expect="$1" label="$2" svc="$3" id="$4" rc="$5"; shift 5
  "$@" > "$T/out" 2>/dev/null
  local reason; if reason="$(validate_dry_run "$svc" "$T/out" "$rc" "$id")"; then got=accept; else got=reject; fi
  if [[ "$got" == "$expect" ]]; then pass=$((pass+1)); printf 'PASS  %-6s %s%s\n' "$expect" "$label" "${reason:+   [$reason]}"
  else fail=$((fail+1)); printf 'FAIL  expected %s, got %s: %s\n' "$expect" "$got" "$label"; fi
}
cat_() { cat; }
empty() { :; }
rawtext() { printf '%s' "$RAW"; }

echo "== positive"
run accept "exact observed API output (plain + prefixed, recreate + start)" api $API_ID 0 api_ok
run accept "exact observed web output (plain + prefixed, recreate + start)" web $WEB_ID 0 web_ok
run accept "plain API names only (Recreate/Recreated)"  api $API_ID 0 bash -c 'printf " DRY-RUN MODE -  Container xpertapply-staging-api  Recreate\n DRY-RUN MODE -  Container xpertapply-staging-api  Recreated\n"'
run accept "plain web names only (Recreate/Recreated)"  web $WEB_ID 0 bash -c 'printf " DRY-RUN MODE -  Container xpertapply-staging-web  Recreate\n DRY-RUN MODE -  Container xpertapply-staging-web  Recreated\n"'
run accept "blank lines and CRLF are tolerated"          api $API_ID 0 bash -c 'api() { printf " DRY-RUN MODE -  Container xpertapply-staging-api  Recreate\r\n\n DRY-RUN MODE -  Container xpertapply-staging-api  Recreated\r\n"; }; api'

echo "== negative: other containers"
for bad in xpertapply-api-1 xpertapply-web-1 xpertapply-staging-postgres xpertapply-staging-redis xpertapply-staging-worker \
           xpertapply-staging-scheduler veotrex-daycare-api-1 veotrex-cp-staging-postgres-1 totally-unknown xpertapply-worker-1 xpertapply-scheduler-1; do
  g() { api_ok; L "$bad" Recreate; }; run reject "API output also names $bad" api $API_ID 0 g
  g() { web_ok; L "$bad" Recreate; }; run reject "web output also names $bad" web $WEB_ID 0 g
  g() { L "$bad" Recreate; L "$bad" Recreated; }; run reject "output names ONLY $bad (no expected name)" api $API_ID 0 g
done
echo "== negative: prefixes, suffixes, lookalikes"
for bad in "${API_ID}_xpertapply-api-1" "${API_ID}_xpertapply-staging-postgres" "${WEB_ID}_xpertapply-web-1" "${API_ID}_veotrex-daycare-api-1" \
           "xpertapply-staging-api-2" "xpertapply-staging-api_old" "xpertapply-staging-apix" "x-xpertapply-staging-api" "foo_xpertapply-staging-api" \
           "A9C4FEE1B979_xpertapply-staging-api" "a9c4fee1b97_xpertapply-staging-api" "a9c4fee1b9790_xpertapply-staging-api" \
           "b9c4fee1b979_xpertapply-staging-api" "${API_ID}__xpertapply-staging-api" "${API_ID}_${API_ID}_xpertapply-staging-api" \
           "xpertapply-staging-api.bak" "XPERTAPPLY-STAGING-API"; do
  g() { api_ok; L "$bad" Starting; }; run reject "API output also names '$bad'" api $API_ID 0 g
done
g() { L ${WEB_ID}_xpertapply-staging-api Starting; L xpertapply-staging-api Recreate; }; run reject "API name prefixed with the WEB container id" api $API_ID 0 g
echo "== negative: cross-service"
run reject "API names appear in the web-only dry run" web $WEB_ID 0 api_ok
run reject "web names appear in the API-only dry run" api $API_ID 0 web_ok
g() { api_ok; web_ok; }; run reject "API output also contains the web service" api $API_ID 0 g
g() { api_ok; web_ok; }; run reject "web output also contains the API service" web $WEB_ID 0 g
echo "== negative: exit status, empty and malformed output"
run reject "compose exited 1"        api $API_ID 1 api_ok
run reject "compose exited 125"      web $WEB_ID 125 web_ok
run reject "exit code missing"       api $API_ID "" api_ok
run reject "empty output"            api $API_ID 0 empty
g() { printf '\n\n  \n'; }; run reject "whitespace-only output" api $API_ID 0 g
g() { printf 'Error response from daemon: No such image\n'; }; run reject "compose error text" api $API_ID 0 g
g() { api_ok; printf 'WARN[0000] The "X" variable is not set\n'; }; run reject "expected output plus a warning line" api $API_ID 0 g
g() { api_ok; printf ' DRY-RUN MODE -  Network xpertapply-staging_edge  Recreate\n'; }; run reject "network recreate line" api $API_ID 0 g
g() { api_ok; printf ' DRY-RUN MODE -  Volume xpertapply-staging-uploaded-files  Removed\n'; }; run reject "volume removal line" api $API_ID 0 g
g() { api_ok; L xpertapply-staging-api Removed; }; run reject "unknown verb Removed" api $API_ID 0 g
g() { api_ok; L xpertapply-staging-api Stopped; }; run reject "unknown verb Stopped" api $API_ID 0 g
g() { L xpertapply-staging-api Starting; L xpertapply-staging-api Started; }; run reject "start without any recreate" api $API_ID 0 g
g() { L ${API_ID}_xpertapply-staging-api Recreate; }; run reject "recreate shown only for the prefixed name" api $API_ID 0 g
g() { printf 'Container xpertapply-staging-api Recreate\n'; }; run reject "missing DRY-RUN MODE marker (a real run!)" api $API_ID 0 g
g() { printf ' DRY-RUN MODE -  Container xpertapply-staging-api  Recreate extra\n'; }; run reject "trailing garbage after the verb" api $API_ID 0 g
g() { printf ' DRY-RUN MODE -  Container xpertapply-staging-api;rm -rf /  Recreate\n'; }; run reject "shell metacharacters in a name" api $API_ID 0 g
g() { printf ' DRY-RUN MODE -  Container  Recreate\n'; }; run reject "name missing" api $API_ID 0 g
echo "== negative: bad arguments"
run reject "unknown service name"            postgres $API_ID 0 api_ok
run reject "service name empty"              ""       $API_ID 0 api_ok
run reject "container id not 12 hex (short)" api      a9c4fee 0 api_ok
run reject "container id uppercase"          api      A9C4FEE1B979 0 api_ok
run reject "container id empty"              api      "" 0 api_ok
plain_api() { L xpertapply-staging-api Recreate; L xpertapply-staging-api Recreated; }
for badid in a9c4fee A9C4FEE1B979 zzzzzzzzzzzz a9c4fee1b9790 "a9c4fee1b97 " ""; do
  run reject "plain-only output but current id is invalid ('$badid')" api "$badid" 0 plain_api
done
if validate_dry_run api "$T/does-not-exist" 0 $API_ID >/dev/null; then fail=$((fail+1)); echo "FAIL  missing file accepted"; else pass=$((pass+1)); echo "PASS  reject  missing output file"; fi

echo; echo "RESULT: $pass passed, $fail failed"; exit $(( fail > 0 ))

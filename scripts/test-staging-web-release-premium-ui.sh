#!/usr/bin/env bash
# Exercises the guard logic of staging-web-release-premium-ui.sh against a STUB docker/id/curl in a temp dir.
# It never touches a real Docker daemon, compose project or server, and needs no root.
# Only the PATH used inside the script's dc() is repointed at the stubs in the test copy.
#   bash scripts/test-staging-web-release-premium-ui.sh
set -uo pipefail
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/staging-web-release-premium-ui.sh"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
mkdir -p "$T/bin" "$T/run" "$T/infra"; : > "$T/infra/compose.staging.yml"; : > "$T/infra/.env.staging"; : > "$T/infra/api.yml"; : > "$T/knobs"
cat > "$T/bin/id" <<'S'
#!/usr/bin/env bash
[[ "$1" == "-u" ]] && { cat "$(dirname "$0")/../uid" 2>/dev/null || echo 0; exit 0; }; exec /usr/bin/id "$@"
S
printf '#!/usr/bin/env bash\necho "web http=200"\n' > "$T/bin/curl"
cat > "$T/bin/docker" <<'S'
#!/usr/bin/env bash
args="$*"; K="$(dirname "$0")/../knobs"; kn() { grep -s "^$1=" "$K" | tail -1 | cut -d= -f2-; }
if [[ "$1" == "image" && "$2" == "inspect" ]]; then fmt="$4"; img="$5"
  case "$fmt" in
    *Labels*) [[ -n "$(kn rev)" ]] && kn rev || echo 1111111111111111111111111111111111111111;;
    *Os*) [[ "$img" == "new:tag" && -n "$(kn newplatform)" ]] && kn newplatform || echo linux/amd64;;
    *) if [[ "$img" == "new:tag" ]]; then [[ -n "$(kn newid)" ]] && kn newid || echo sha256:new; else echo sha256:old; fi;;
  esac; exit 0; fi
if [[ "$1" == "inspect" ]]; then
  c=$(cat "$(dirname "$0")/../count" 2>/dev/null || echo 0); echo $((c+1)) > "$(dirname "$0")/../count"
  tag=same; [[ -n "$(kn snapdiff)" && $c -ge 1 ]] && tag=changed
  for n in "${@:4}"; do echo "/$n id-$n img-$tag"; done | sed "s#id-xpertapply-staging-web#id-web-$RANDOM#"; exit 0; fi
if [[ "$1" == "compose" ]]; then
  if [[ "$args" == *" config --format json"* ]]; then img=old:tag; extra=""
    [[ "$args" == *staging-web.release.yml* ]] && img=new:tag
    [[ "$args" == *staging-web.release.yml* && -n "$(kn cfgdiff)" ]] && extra=',"ports":["8080:3000"]'
    cn=xpertapply-staging-web; [[ -n "$(kn cname)" ]] && cn="$(kn cname)"
    echo "{\"services\":{\"web\":{\"container_name\":\"$cn\",\"image\":\"$img\",\"environment\":{\"DB_PASSWORD\":\"SECRET_SENTINEL\"}$extra},\"api\":{\"image\":\"api\"}}}"; exit 0; fi
  [[ "$args" == *"up --dry-run"* ]] && { echo " Container xpertapply-staging-web  Recreate"; exit 0; }
  [[ "$args" == *" up -d"* ]] && { echo " Container xpertapply-staging-web  Started"; exit 0; }
fi
exit 0
S
chmod +x "$T"/bin/*
sed "s#PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin#PATH=$T/bin:/usr/bin:/bin#" "$SRC" > "$T/run/script.sh"
export PATH="$T/bin:$PATH" INFRA="$T/infra" API_OVR="$T/infra/api.yml" NEW_IMG=new:tag NEW_ID=sha256:new OLD_IMG=old:tag OLD_ID=sha256:old NEW_REV=1111111111111111111111111111111111111111
fail=0
t() { # name mode expected_rc expected_substring [knob=value] [ENV=value]
  local name="$1" mode="$2" erc="$3" sub="$4" knob="${5:-}" envv="${6:-X=1}"
  : > "$T/knobs"; [[ -n "$knob" ]] && echo "$knob" > "$T/knobs"; rm -f "$T/count"; echo "${UID_STUB:-0}" > "$T/uid"
  out=$(env "$envv" bash "$T/run/script.sh" "$mode" 2>&1); rc=$?
  if [[ "$rc" == "$erc" && "$out" == *"$sub"* && "$out" != *SECRET_SENTINEL* ]]; then echo "PASS  $name"; else echo "FAIL  $name (rc=$rc, want $erc, want text: $sub)"; fail=1; fi
}
t "plan: happy path"                          plan     0 "Recreate"
t "plan: image id mismatch refused"           plan     1 "new image id mismatch"            newid=sha256:other
t "plan: source revision mismatch refused"    plan     1 "not built from NEW_REV"           rev=2222222222222222222222222222222222222222
t "plan: platform mismatch refused"           plan     1 "platform differs"                 newplatform=linux/arm64
t "plan: compose web is not staging refused"  plan     1 "not xpertapply-staging-web"       cname=xpertapply-web
t "plan: config differs beyond image refused" plan     1 "UNEXPECTED effective-config"      cfgdiff=1
t "plan: missing API override refused"        plan     1 "API override file missing"        "" API_OVR="$T/infra/missing.yml"
t "plan: malformed NEW_REV refused"           plan     1 "full 40-char sha"                 "" NEW_REV=abc
UID_STUB=1000 t "plan: non-root refused"      plan     1 "run with sudo"
t "apply: other containers unchanged"         apply    0 "web http=200"
t "apply: other container changed aborts"     apply    2 "OTHER CONTAINERS CHANGED"         snapdiff=1
t "rollback: other containers unchanged"      rollback 0 "web http=200"
t "rollback: other container changed aborts"  rollback 2 "OTHER CONTAINERS CHANGED"         snapdiff=1
[[ -z "$(ls "$T/run" | grep -E 'cfg\.')" ]] && echo "PASS  no resolved-config JSON left beside the script" || { echo "FAIL  config JSON left on disk"; fail=1; }
[[ "$(stat -f %Lp "$T/run/staging-web.release.yml" 2>/dev/null || stat -c %a "$T/run/staging-web.release.yml")" == "600" ]] && echo "PASS  generated override files are 0600" || { echo "FAIL  override file mode"; fail=1; }
exit $fail

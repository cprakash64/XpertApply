#!/usr/bin/env python3
"""EXT-FINAL-03 rendered-configuration delta gate. Reads two `docker compose config --format json` documents (current, target) from stdin,
one per line. Prints only key NAMES, never values. Exit 0 = the delta is exactly the intended one.

    extfinal03_delta.py web|api CONTAINER STORE_ID NEW_WEB_TAG [--no-drift]
"""
import json
import subprocess
import sys


def check(cur, tgt, target, store_id, new_web_tag, running_env=None):
    problems = []
    svc = "web" if target == "web" else "api"
    ec = {k: str(v) for k, v in cur["services"][svc].get("environment", {}).items()}
    et = {k: str(v) for k, v in tgt["services"][svc].get("environment", {}).items()}
    if running_env is not None:
        drift = sorted(k for k in ec if running_env.get(k) != ec[k])
        if drift:
            problems.append("current render differs from the running container: " + ", ".join(drift))
    delta = sorted(k for k in set(ec) | set(et) if ec.get(k) != et.get(k))

    def rest(service, drop):
        d = dict(service)
        for key in drop:
            d.pop(key, None)
        return d

    if target == "web":
        if delta:
            problems.append("web environment delta keys: " + ", ".join(delta))
        if tgt["services"]["web"].get("image") != new_web_tag:
            problems.append("target web image reference")
        if rest(cur["services"]["web"], ["image"]) != rest(tgt["services"]["web"], ["image"]):
            problems.append("web settings other than the image differ")
        others = [n for n in cur["services"] if n != "web"]
    else:
        if delta != ["EXTENSION_ALLOWED_IDS"]:
            problems.append("api environment delta keys: " + (", ".join(delta) or "none"))
        if et.get("EXTENSION_ALLOWED_IDS") != json.dumps([store_id]):
            problems.append("allowlist value is not exactly the Store id")
        if tgt["services"]["api"].get("image") != cur["services"]["api"].get("image"):
            problems.append("api image reference changed")
        if rest(cur["services"]["api"], ["environment"]) != rest(tgt["services"]["api"], ["environment"]):
            problems.append("api settings other than environment differ")
        others = [n for n in cur["services"] if n != "api"]
    if not all(cur["services"].get(n) == tgt["services"].get(n) for n in others):
        problems.append("another service differs")
    return delta, problems


def main(argv):
    target, container, store_id, new_web_tag = argv[1:5]
    cur = json.loads(sys.stdin.readline())
    tgt = json.loads(sys.stdin.readline())
    running = None
    if "--no-drift" not in argv:
        running = dict(
            line.split("=", 1)
            for line in subprocess.check_output(["docker", "inspect", "-f", "{{range .Config.Env}}{{println .}}{{end}}", container], text=True).splitlines()
            if "=" in line
        )
    delta, problems = check(cur, tgt, target, store_id, new_web_tag, running)
    print("   " + ("; ".join(problems) if problems else "delta keys = [" + ",".join(delta) + "]; only the intended service/setting differs; every other service identical"))
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))

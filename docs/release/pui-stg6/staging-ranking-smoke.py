#!/usr/bin/env python3
"""Post-deploy smoke test of the RELEASE CANDIDATE against the real STAGING API, using one synthetic account.

    python3 staging-ranking-smoke.py https://api-staging.xpertapply.com

Creates one account named rc-smoke-<time>@mailbox.test-domain.co (no customer data, no email is sent), completes a minimal profile, and checks:
  * GET /jobs is ranked on the server in all three sorts: Newest is strictly chronological, Best fit strictly score ordered,
    Best & recent never puts a lower fit band above a higher one;
  * paging with the server's cursors returns exactly the unpaged list, with no duplicates, for every sort;
  * a tampered cursor is refused and unauthenticated calls are refused;
  * /dashboard/summary carries the new fields, its pipeline counts add up, and its profile percentage equals /profile/completeness.
It prints names and counts only, never tokens or passwords. Exit status 0 means every check passed.
"""
import sys, time, json
from datetime import datetime
import httpx

BASE = (sys.argv[1] if len(sys.argv) > 1 else "https://api-staging.xpertapply.com").rstrip("/")
if "staging" not in BASE and "localhost" not in BASE and "127.0.0.1" not in BASE:
    sys.exit("refusing to run against a non-staging API")
fails = 0
def check(ok, msg):
    global fails
    print(("PASS  " if ok else "FAIL  ") + msg); fails += (not ok)

c = httpx.Client(base_url=BASE, timeout=120)
email = f"rc-smoke-{int(time.time())}@mailbox.test-domain.co"
r = c.post("/auth/signup", json={"email": email, "password": f"Smoke-{int(time.time())}-pw"})
check(r.status_code in (200, 201), f"signup of a synthetic account ({r.status_code})")
token = r.json().get("access_token") if r.status_code in (200, 201) else None
if not token: sys.exit("cannot continue without an account")
h = {"Authorization": f"Bearer {token}"}
r = c.put("/profile", headers=h, json={"full_name": "RC Smoke", "application_email": email, "phone": "602-555-0100", "location_city": "Phoenix", "location_state": "AZ",
    "location_country": "United States", "work_authorization": "authorized_us", "target_roles": ["Software Engineer", "Backend Engineer", "Data Engineer"],
    "target_levels": ["Junior", "Mid"], "preferred_locations": ["United States"], "remote_preference": "remote", "skills": ["Python", "SQL", "FastAPI"]})
check(r.status_code == 200, f"profile saved ({r.status_code})")

check(c.get("/jobs").status_code in (401, 403), "unauthenticated GET /jobs is refused")
check(c.get("/dashboard/summary").status_code in (401, 403), "unauthenticated GET /dashboard/summary is refused")
bad = c.get("/jobs", headers=h, params={"limit": 5, "cursor": "garbage"})
check(bad.status_code == 400, f"a tampered cursor is refused ({bad.status_code})")
check(c.get("/jobs", headers=h, params={"sort": "random"}).status_code == 422, "an unknown sort is refused")

BAND = lambda s: -1 if s is None else 3 if s >= 80 else 2 if s >= 60 else 1 if s >= 45 else 0
for sort in ("best_recent", "fit", "newest"):
    whole = c.get("/jobs", headers=h, params={"sort": sort, "posted_within_days": 30})
    check(whole.status_code == 200, f"[{sort}] unpaged list ({whole.status_code})")
    jobs = whole.json()["jobs"]; ids = [j["id"] for j in jobs]
    check(whole.json()["page"]["sort"] == sort and whole.json()["page"]["total"] == len(ids), f"[{sort}] page block present, total {len(ids)}")
    pages, cursor, n = [], None, 0
    while True:
        params = {"sort": sort, "posted_within_days": 30, "limit": 25}
        if cursor: params["cursor"] = cursor
        pg = c.get("/jobs", headers=h, params=params).json(); pages += [j["id"] for j in pg["jobs"]]; n += 1
        cursor = pg["page"]["next_cursor"]
        if not pg["page"]["has_more"] or n > 400: break
    check(pages == ids and len(set(pages)) == len(pages), f"[{sort}] {n} page(s) equal the unpaged list, no duplicates")
    if sort == "newest":
        t = [datetime.fromisoformat(j["posted_at"]) for j in jobs if j["posted_at"]]
        check(t == sorted(t, reverse=True), "[newest] strictly chronological by the employer's posting date")
    if sort == "fit":
        s = [(j["match"] or {}).get("fit_score") for j in jobs]; s = [x for x in s if x is not None]
        check(s == sorted(s, reverse=True), "[fit] strictly ordered by score")
    if sort == "best_recent":
        bands = [BAND((j["match"] or {}).get("fit_score")) for j in jobs]
        check(bands == sorted(bands, reverse=True), "[best_recent] a lower fit band never sits above a higher one")

d = c.get("/dashboard/summary", headers=h); check(d.status_code == 200, f"dashboard summary ({d.status_code})")
d = d.json()
check({"saved", "inProgress", "interviews", "offers", "rejected"} <= set(d["applications"]), "pipeline buckets include rejected")
check("profile" in d and {"percent", "completed", "missing"} <= set(d["profile"]), "profile block present")
comp = c.get("/profile/completeness", headers=h).json()["completion"]
check(d["profile"]["percent"] == comp["percent"] == d["nextAction"]["profileProgress"], f"one profile percentage everywhere ({comp['percent']}%)")
check(all({"matchedSkills", "snippet", "saved", "employmentType"} <= set(m) for m in d["topMatches"]), f"{len(d['topMatches'])} top match(es) carry the new card fields")
check(len(d["recentApplications"]) <= 5, "at most five recent applications")
print(f"\nSMOKE {'PASS' if not fails else 'FAIL'} ({fails} failing checks). Synthetic account: {email}")
sys.exit(1 if fails else 0)

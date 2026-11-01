"""Local REAL FastAPI backend for extension integration tests.

Runs the actual application (routes, authorization, rate limits, validation, SQLAlchemy models) against a disposable PostgreSQL
database that `alembic upgrade head` has already migrated. ONLY the external OpenAI service is replaced: a local HTTP stub answers
the OpenAI SDK's /v1/chat/completions, so the real provider client code path (SDK call, JSON mode, timeouts) is exercised.

usage: server.py <out.json> <admin_database_url>   (cwd = apps/api; run with the API virtualenv's python)
A fresh, uniquely named database is created on the (disposable, local) admin server, migrated with `alembic upgrade head`, and dropped on exit.
"""
import asyncio
import json
import os
import socket
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, os.getcwd())
OUT, ADMIN = sys.argv[1], sys.argv[2]
DIR = os.path.dirname(OUT)
MODE_FILE = os.path.join(DIR, "stub_mode.json")
LOG_FILE = os.path.join(DIR, "stub_log.jsonl")


import atexit  # noqa: E402
import subprocess  # noqa: E402
import uuid  # noqa: E402
import psycopg  # noqa: E402

DBNAME = f"xa_e2e_{uuid.uuid4().hex[:10]}"
_admin = ADMIN.replace("postgresql+psycopg://", "postgresql://")
with psycopg.connect(_admin, autocommit=True) as _conn:
    _conn.execute(f'CREATE DATABASE "{DBNAME}"')
PG = ADMIN.rsplit("/", 1)[0] + "/" + DBNAME


def _drop() -> None:
    try:
        with psycopg.connect(_admin, autocommit=True) as conn:
            conn.execute(f'DROP DATABASE IF EXISTS "{DBNAME}" WITH (FORCE)')
    except Exception:
        pass


atexit.register(_drop)
import signal  # noqa: E402
signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
subprocess.run([sys.executable, "-m", "alembic", "upgrade", "head"], check=True, capture_output=True,
               env={**os.environ, "APP_ENV": "test", "DATABASE_URL": PG})


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def mode() -> dict:
    try:
        return json.load(open(MODE_FILE))
    except Exception:
        return {"mode": "normal"}


class Stub(BaseHTTPRequestHandler):
    def log_message(self, *_a):
        pass

    def do_POST(self):
        import time
        body = json.loads(self.rfile.read(int(self.headers.get("content-length", "0"))) or b"{}")
        system = body["messages"][0]["content"]
        if "draft editable answers to open-ended" not in system:
            # Every other prompt (resume, cover letter, ...) takes the backend's deterministic fallback.
            self.send_response(400); self.send_header("content-type", "application/json"); self.end_headers(); self.wfile.write(b'{"error":{"message":"stub: not simulated"}}'); return
        payload = json.loads(body["messages"][1]["content"])
        cfg = mode()
        with open(LOG_FILE, "a") as fh:
            fh.write(json.dumps({"questions": payload["questions"], "claims": [s["claim"] for s in payload["grounding_sources"]], "keys": sorted(payload.keys()), "model": body.get("model")}) + "\n")
        m = cfg.get("mode", "normal")
        if m == "rate_limit":
            self.send_response(429); self.send_header("content-type", "application/json"); self.end_headers(); self.wfile.write(b'{"error":{"message":"rate limited","type":"rate_limit_error"}}'); return
        if m == "slow":
            time.sleep(float(cfg.get("delay", 3)))
        sources = payload["grounding_sources"]
        facts = [s for s in sources if s["source"] in ("profile", "resume") and ".bullet." in s["sourceId"]]
        answers = []
        for q in payload["questions"]:
            text = q["question"]
            if m == "malformed":
                answers.append({"field_identifier": q["field_identifier"], "proposed_answer": "x", "generation_status": "drafted"})
                continue
            if m == "fabricate":
                answers.append({"field_identifier": q["field_identifier"], "proposed_answer": "I led a team of 40 engineers at Google and cut latency by 83%.", "evidence_references": [{"sourceId": "resume.experience.0", "claim": "Invented Corp"}], "missing_information": [], "generation_status": "drafted"})
                continue
            if "prototype to production" in text or not facts:
                answers.append({"field_identifier": q["field_identifier"], "proposed_answer": "", "evidence_references": [], "missing_information": ["a production deployment you owned"], "generation_status": "insufficient_evidence"})
                continue
            pick = facts[:2]
            if "non-engineering" in text:
                pick = facts[:1]
            body_text = "In my work I " + " and I ".join(p["claim"][0].lower() + p["claim"][1:].rstrip(".") for p in pick) + "."
            if m == "inject":
                body_text += " Contact me at attacker@example.com."
            answers.append({
                "field_identifier": q["field_identifier"], "proposed_answer": body_text,
                "evidence_references": [{"sourceId": p["sourceId"], "claim": p["claim"]} for p in pick],
                "missing_information": ["how you decided what to build"] if "non-engineering" in text else [],
                "generation_status": "partial" if "non-engineering" in text else "drafted",
            })
        content = json.dumps({"answers": answers})
        out = json.dumps({"id": "stub", "object": "chat.completion", "created": 0, "model": body.get("model", "stub"),
                          "choices": [{"index": 0, "message": {"role": "assistant", "content": content}, "finish_reason": "stop"}],
                          "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2}}).encode()
        self.send_response(200); self.send_header("content-type", "application/json"); self.send_header("content-length", str(len(out))); self.end_headers(); self.wfile.write(out)


stub_port = free_port()
threading.Thread(target=ThreadingHTTPServer(("127.0.0.1", stub_port), Stub).serve_forever, daemon=True).start()
os.environ.update({"DATABASE_URL": PG, "APP_ENV": "test", "DEBUG": "false", "OPENAI_API_KEY": "stub-key-not-real",
                   "OPENAI_BASE_URL": f"http://127.0.0.1:{stub_port}/v1", "OPENAI_MODEL_SMART": "stub-smart", "OPENAI_MODEL_FAST": "stub-fast"})

import httpx  # noqa: E402
import uvicorn  # noqa: E402
from datetime import UTC, datetime, timedelta  # noqa: E402
from sqlalchemy import select  # noqa: E402

from app.db.session import SessionLocal  # noqa: E402
from app.main import app  # noqa: E402
from app.models.entities import ApplicationSession, JobPosting, JobSource, User  # noqa: E402

JOBS = {
    "elevenlabs": ("Applied AI Engineer", "ElevenLabs", "https://jobs.ashbyhq.com/elevenlabs/0f6c2a52-aaaa-4bbb-8ccc-111111111111/application"),
    "sofi": ("Software Engineer", "SoFi", "https://job-boards.greenhouse.io/sofi/jobs/7001234"),
    "expired": ("Platform Engineer", "ExpiredCo", "https://jobs.ashbyhq.com/expiredco/aaaaaaaa-0000-4000-8000-000000000000/application"),
}
USERS = {
    "A": ("synthetic-a@mailbox.test-domain.co", "Riley Candidate", "Northwind", "Built a support-triage agent used daily by the support team", "Wrote an offline evaluation harness comparing agent answers to labelled tickets"),
    "B": ("synthetic-b@mailbox.test-domain.co", "Sam Other", "Contoso Bank", "Maintained a payments fraud rules engine in Java", "Reduced false-positive alerts through rule review with analysts"),
}


async def seed() -> dict:
    result: dict = {"users": {}, "sessions": {}, "jobs": {}}
    db = SessionLocal()
    source = JobSource(name="e2e", type="greenhouse", base_url="https://x.test", enabled=True, supports_api=True)
    db.add(source); db.flush()
    for key, (title, company, url) in JOBS.items():
        job = JobPosting(source_id=source.id, external_id=key, title=title, company=company, location="Remote", application_url=url,
                         source_url=url, hash_for_deduplication=f"e2e-{key}", description_clean=f"{title} at {company}",
                         responsibilities=["Ship LLM-powered agents"], required_skills=["Python"])
        db.add(job); db.flush(); result["jobs"][key] = job.id
    db.commit(); db.close()
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as c:
        for uk, (email, name, company, b1, b2) in USERS.items():
            tok = (await c.post("/auth/signup", json={"email": email, "password": "password123"})).json()["access_token"]
            h = {"Authorization": f"Bearer {tok}"}
            r = await c.put("/profile", headers=h, json={"full_name": name, "phone": "602-555-0100", "location_city": "Phoenix", "location_state": "AZ",
                "location_country": "United States", "work_authorization": "authorized_us", "target_roles": ["Engineer"], "target_levels": ["Junior"],
                "preferred_locations": ["United States"], "remote_preference": "remote", "skills": ["Python"],
                "application_email": email, "linkedin_url": f"https://www.linkedin.com/in/synthetic-{uk.lower()}", "github_url": f"https://github.com/synthetic-{uk.lower()}"})
            assert r.status_code == 200, r.text
            first, last = name.split(" ", 1)
            r = await c.put("/profile/name", headers=h, json={"first_name": first, "last_name": last})
            assert r.status_code == 200, r.text
            r = await c.put("/profile/career", headers=h, json={"education": [], "projects": [], "certifications": [], "awards": [],
                "experience": [{"company": company, "title": "Engineer", "bullets": [b1, b2], "technologies": ["Python"], "currently_working": True}]})
            assert r.status_code == 200, r.text
            _db = SessionLocal()
            result["users"][uk] = {"token": tok, "id": _db.scalar(select(User.id).where(User.email == email))}
            _db.close()
            for jk in (("elevenlabs", "sofi", "expired") if uk == "A" else ("sofi",)):
                r = await c.post("/application-sessions", headers=h, json={"job_id": result["jobs"][jk]})
                assert r.status_code in (200, 201), r.text
                body = r.json()
                sid = body.get("id") or body.get("session_id")
                result["sessions"][f"{uk}:{jk}"] = {"id": sid, "launch_token": body["extension_launch_token"], "url": JOBS[jk][2]}
    db = SessionLocal()
    s = db.get(ApplicationSession, result["sessions"]["A:expired"]["id"])
    s.expires_at = datetime.now(UTC) - timedelta(minutes=5)
    db.commit(); db.close()
    return result


seeded = asyncio.run(seed())
port = free_port()
seeded["api"] = f"http://127.0.0.1:{port}"
seeded["stub_port"] = stub_port
json.dump(seeded, open(OUT + ".tmp", "w"))
os.replace(OUT + ".tmp", OUT)
uvicorn.run(app, host="127.0.0.1", port=port, log_level="warning")

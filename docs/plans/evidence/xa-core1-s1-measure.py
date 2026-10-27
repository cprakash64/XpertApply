import asyncio, threading, time, uuid, statistics
import httpx, uvicorn
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from app.main import app
from app.applications import direct_sessions
from app.models import entities as E
from app.tests.test_extension_auth import REDIRECT, VERIFIER, challenge_for
from app.tests.test_extension_auth_postgres import PROFILE, CAREER

SIM = 8.0  # simulated provider latency per document (seconds)
calls = {"n": 0}
async def slow(db, user, job, doc_type):
    calls["n"] += 1
    await asyncio.sleep(SIM)
    doc = E.GeneratedDocument(user_id=user.id, job_id=job.id, type=doc_type, format=E.DocumentFormat.json, title="t", content={}, content_markdown="m", plain_text="p", quality={}, model_used="sim")
    db.add(doc); db.commit(); db.refresh(doc); return doc, None
direct_sessions._safe_generate = slow
server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=8765, log_level="warning"))
threading.Thread(target=server.run, daemon=True).start()
time.sleep(2)
c = httpx.Client(base_url="http://127.0.0.1:8765", timeout=60)
h = {"Authorization": "Bearer " + c.post("/auth/signup", json={"email": f"m-{uuid.uuid4().hex[:8]}@mailbox.test-domain.co", "password": "password123"}).json()["access_token"]}
c.put("/profile", headers=h, json=PROFILE); c.put("/profile/career", headers=h, json=CAREER)
code = c.post("/extension/auth/code", headers=h, json={"code_challenge": challenge_for(VERIFIER), "redirect_uri": REDIRECT}).json()["code"]
tok = c.post("/extension/auth/token", json={"grant_type":"authorization_code","code":code,"code_verifier":VERIFIER,"redirect_uri":REDIRECT}).json()
a = {"Authorization": "Bearer " + tok["access_token"]}
url = "https://careers.withwaymo.com/jobs/" + uuid.uuid4().hex[:8]
t=time.perf_counter(); r=c.post("/extension/direct-sessions", headers=a, json={"url": url}); first=time.perf_counter()-t
sid=r.json()["session_id"]; st=r.json()["session_token"]
print("first create status", r.status_code, "latency_ms", round(first*1000), "resume_status_at_response", r.json()["resume"]["status"])
reps=[]
for _ in range(5):
    t=time.perf_counter(); c.post("/extension/direct-sessions", headers=a, json={"url": url+"?utm=1"}); reps.append((time.perf_counter()-t)*1000)
print("repeat latency_ms median", round(statistics.median(reps)), "max", round(max(reps)))
t0=time.perf_counter()
while time.perf_counter()-t0 < 60:
    s=c.get(f"/application-sessions/{sid}", headers={"Authorization":"Bearer "+st}).json()
    if s["resume"]["status"]=="ready" and s["cover_letter"]["status"]=="ready": break
    time.sleep(0.5)
print("documents ready after_s", round(time.perf_counter()-t0+first,1), "resume", s["resume"]["status"], "cover", s["cover_letter"]["status"])
print("AI calls total (2 expected)", calls["n"])
# concurrent burst on a NEW page
url2="https://careers.withwaymo.com/jobs/"+uuid.uuid4().hex[:8]; calls["n"]=0
async def burst():
    async with httpx.AsyncClient(base_url="http://127.0.0.1:8765", timeout=60) as ac:
        t=time.perf_counter(); rs=await asyncio.gather(*[ac.post("/extension/direct-sessions", headers=a, json={"url": url2}) for _ in range(10)]); return rs, time.perf_counter()-t
rs, dt = asyncio.run(burst())
print("burst 10x status", sorted({x.status_code for x in rs}), "distinct sessions", len({x.json()["session_id"] for x in rs}), "wall_ms", round(dt*1000))
time.sleep(SIM*2+3); print("AI calls after burst (2 expected)", calls["n"])
server.should_exit=True

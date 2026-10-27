"""Stage 50C disposable fixture. Runs inside the staging API container. Touches ONLY users whose email starts with xa-50c-."""
import json, sys, copy
from datetime import UTC, datetime
from sqlalchemy import select, delete
from app.db.session import SessionLocal
from app.models import entities as E
from app.services.documents import build_truthful_resume, profile_payload
from app.applications.document_association import freeze_application_documents

mode = sys.argv[1]
A_ID, B_ID = int(sys.argv[2]), int(sys.argv[3])
JOBS = dict(frozen=1892, historical=1909, ambiguous=1928, none=443, resume_only=393)
with SessionLocal() as db:
    for uid in (A_ID, B_ID):
        u = db.get(E.User, uid); assert u and u.email.startswith("xa-50c-"), "refusing: not a 50C test user"
    if mode == "cleanup":
        out = {}
        out["trackers"] = db.execute(delete(E.ApplicationTracker).where(E.ApplicationTracker.user_id.in_([A_ID, B_ID]))).rowcount
        out["sessions"] = db.execute(delete(E.ApplicationSession).where(E.ApplicationSession.user_id.in_([A_ID, B_ID]))).rowcount
        out["docs"] = db.execute(delete(E.GeneratedDocument).where(E.GeneratedDocument.user_id.in_([A_ID, B_ID]))).rowcount
        db.commit(); print(json.dumps(out)); sys.exit()
    def mkdoc(job, kind, tag):
        payload = profile_payload(db, A_ID); payload["job"] = {"company": job.company, "title": job.title}
        if kind == "resume":
            content = build_truthful_resume(payload, job)
        else:
            content = {"date": "October 27, 2026", "recipient": "Hiring Team", "company": job.company, "role": job.title, "greeting": "Dear Hiring Team,",
                       "paragraphs": [f"{tag.upper()}-COVER-P1 interest in the {job.title} role at {job.company}.", "Second paragraph: Python and FastAPI at Marker Corp.", "Third paragraph: next steps."],
                       "closing": "Best regards,", "signature": "Xa Fifty Cee"}  # deterministic fixture; no provider call
        d = E.GeneratedDocument(user_id=A_ID, job_id=job.id, type=E.DocumentType(kind), format=E.DocumentFormat.json,
                                content=content, model_used="deterministic-local", title=f"50C {tag} {kind}",
                                job_snapshot={"company": job.company, "title": job.title})
        db.add(d); db.flush(); return d
    def mksession(job, resume, cover, tracker=None):
        s = E.ApplicationSession(user_id=A_ID, job_id=job.id, status=E.ApplicationSessionStatus.ready, source_url="https://example.invalid/xa-50c",
                                 tailored_resume_id=resume.id if resume else None, tailored_cover_letter_id=cover.id if cover else None,
                                 tracker_id=tracker.id if tracker else None)
        db.add(s); db.flush(); return s
    def mktracker(job):
        t = E.ApplicationTracker(user_id=A_ID, job_id=job.id, status=E.ApplicationStatus.applied, applied_at=datetime.now(UTC), applied_source="user_confirmed")
        db.add(t); db.flush(); return t
    res = {}
    for name, jid in JOBS.items():
        job = db.get(E.JobPosting, jid); assert job
        t = mktracker(job); info = {"tracker": t.id, "job": jid, "company": job.company}
        if name in ("frozen", "historical"):
            r, c = mkdoc(job, "resume", name), mkdoc(job, "cover_letter", name); s = mksession(job, r, c)
            info.update(resume_doc=r.id, cover_doc=c.id, session=s.id)
            if name == "frozen":
                info["frozen_rows"] = freeze_application_documents(db, t, s.id)
                # change the live source AFTER freezing: a snapshot must not follow it
                r.content = json.loads(json.dumps(r.content).replace("ORIGINAL-RESUME-MARKER", "EDITED-AFTER-FREEZE"))
                c.content = json.loads(json.dumps(c.content).replace("FROZEN-COVER", "EDITED-AFTER-FREEZE-COVER"))
        elif name == "ambiguous":
            r1, c1 = mkdoc(job, "resume", "amb1"), mkdoc(job, "cover_letter", "amb1")
            r2, c2 = mkdoc(job, "resume", "amb2"), mkdoc(job, "cover_letter", "amb2")
            mksession(job, r1, c1); mksession(job, r2, c2); info.update(docs=[r1.id, c1.id, r2.id, c2.id])
        elif name == "resume_only":
            r = mkdoc(job, "resume", name); mksession(job, r, None); info.update(resume_doc=r.id)
        res[name] = info
    db.commit(); print(json.dumps(res))

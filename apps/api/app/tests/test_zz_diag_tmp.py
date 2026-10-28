"""TEMPORARY diagnostic — deleted after root-causing the dashboard failures."""

from sqlalchemy import select

from app.dashboard.summary_service import _job_view
from app.jobs.job_eligibility_service import evaluate_eligibility
from app.jobs.scoring_service import build_profile_view
from app.main import app
from app.models import entities as E
from app.tests.test_dashboard_summary import auth, client, complete_profile, seed_job  # noqa: F401
from app.api.deps import get_db


def test_diag(client):
    email = "diag@mailbox.test-domain.co"
    headers = auth(client, email)
    complete_profile(client, headers)
    job_id = seed_job(company="DiagCo")

    db = next(app.dependency_overrides[get_db]())
    user = db.scalar(select(E.User).where(E.User.email == email))
    built = build_profile_view(db, user.id)
    pv = built[0] if built else None
    print("\nPROFILE VIEW:", pv)
    row = db.execute(
        select(
            E.JobPosting.id, E.JobPosting.title, E.JobPosting.company, E.JobPosting.location,
            E.JobPosting.remote_type, E.JobPosting.seniority_level,
            E.JobPosting.work_authorization_notes, E.JobPosting.application_url,
            E.JobPosting.source_url, E.JobPosting.source_id,
        ).where(E.JobPosting.id == job_id)
    ).first()
    jv = _job_view(row, description="")
    print("JOB VIEW:", jv)
    for label, kw in (("default(dashboard)", {}), ("include_unknown_location=True", {"include_unknown_location": True})):
        res = evaluate_eligibility(pv, jv, **kw)
        print(f"  {label}: eligible={res.eligible} codes={res.reason_codes} reasons={res.reasons}")
    db.close()

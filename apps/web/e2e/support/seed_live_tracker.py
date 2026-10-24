"""Insert one job posting into the database named by DATABASE_URL and print its id.

Only for the live tracker browser spec, which runs the real API on a DISPOSABLE PostgreSQL database. Refuses to run unless the database
name starts with "xa_live", so it can never write to a developer, staging or production database by accident.
"""
import os
import sys
from datetime import UTC, datetime, timedelta

from sqlalchemy import select
from sqlalchemy.engine import make_url

url = os.environ["DATABASE_URL"]
if not (make_url(url).database or "").startswith("xa_live"):
    sys.exit("refusing to seed a database that is not a disposable xa_live* database")

from app.db.session import SessionLocal  # noqa: E402
from app.models import entities as E  # noqa: E402

company = os.environ.get("SEED_COMPANY", "Plaid")
external = os.environ.get("SEED_EXTERNAL", "live-1")
with SessionLocal() as db:
    source = db.scalar(select(E.JobSource).where(E.JobSource.name == company))
    if source is None:
        source = E.JobSource(name=company, type="greenhouse", base_url="x", enabled=True, supports_api=True)
        db.add(source)
        db.flush()
    link = f"https://boards.greenhouse.io/{company.lower()}/{external}"
    job = E.JobPosting(
        source_id=source.id, external_id=external, title="Senior Machine Learning Engineer", company=company,
        location="Remote, United States", remote_type="remote", posted_at=datetime.now(UTC) - timedelta(days=1),
        discovered_at=datetime.now(UTC), application_url=link, source_url=link, description_raw="",
        description_clean="Senior ML Engineer. Requirements: Python, FastAPI.", required_skills=["Python", "FastAPI"],
        hash_for_deduplication=f"h-{company}-{external}",
    )
    db.add(job)
    db.commit()
    print(job.id)

"""Delete the disposable 50C/50D staging test users (and, by cascade, their rows). Runs inside the staging API container:
   docker exec -i xpertapply-staging-api python - <user_id> [<user_id>...] < remove_users.py
Refuses any user whose email does not start with xa-50c-."""
import sys

from sqlalchemy import delete, func, select

from app.db.session import SessionLocal
from app.models import entities as E

IDS = [int(a) for a in sys.argv[1:]]
with SessionLocal() as db:
    users = db.scalars(select(E.User).where(E.User.id.in_(IDS), E.User.email.like("xa-50c-%"))).all()
    print("deleting", [u.id for u in users])
    # User.profile has no ORM delete cascade, so db.delete(user) would null user_profiles.user_id
    # and leave an orphan profile. Delete the profiles explicitly first.
    ids = [u.id for u in users]
    print("profiles deleted:", db.execute(delete(E.UserProfile).where(E.UserProfile.user_id.in_(ids))).rowcount)
    for user in users:
        db.delete(user)
    db.commit()
    print("remaining xa-50c users:", db.scalar(select(func.count()).select_from(E.User).where(E.User.email.like("xa-50c-%"))))
    print("orphan fixture profiles:", db.scalar(select(func.count()).select_from(E.UserProfile).where(
        E.UserProfile.user_id.is_(None), E.UserProfile.full_name == "Xa Fifty Cee")))
    for model in (E.ApplicationTracker, E.GeneratedDocument, E.ApplicationSession, E.ApplicationDocumentSnapshot):
        print(model.__tablename__, "rows for those users:", db.scalar(select(func.count()).select_from(model).where(model.user_id.in_(IDS))))

# ruff: noqa: F811
from __future__ import annotations

from sqlalchemy import select

from app.applications.snapshots import canonical_document_hash
from app.models import entities as E
from app.tests.test_application_applied_lifecycle import (
    auth,
    client,  # noqa: F401
    complete_profile,
    confirm_via_session,
    db_session,
    seed_job,
    user_id_for,
)


def _prepare(client, headers, job_id: int) -> dict:
    response = client.post("/application-sessions", headers=headers, json={"job_id": job_id})
    assert response.status_code in (200, 201), response.text
    return response.json()


def _record_use(client, headers, session_id: int, artifact: str, mode: str,
                text: str | None = None) -> None:
    response = client.post(
        f"/application-sessions/{session_id}/artifact-use",
        headers=headers,
        json={"artifact": artifact, "mode": mode, "text": text},
    )
    assert response.status_code == 200, response.text


def test_confirmation_creates_exact_frozen_artifact_snapshot_and_is_idempotent(client) -> None:
    headers = auth(client)
    complete_profile(client, headers)
    job_id = seed_job()
    session = _prepare(client, headers, job_id)
    resume_id = session["resume"]["document_id"]
    cover_id = session["cover_letter"]["document_id"]
    _record_use(client, headers, session["session_id"], "resume", "uploaded")
    _record_use(client, headers, session["session_id"], "cover_letter", "uploaded")

    first = confirm_via_session(
        client,
        headers,
        session["session_id"],
        resume_used=True,
        cover_letter_mode="file",
    )
    assert first.status_code == 200, first.text
    second = confirm_via_session(
        client,
        headers,
        session["session_id"],
        resume_used=True,
        cover_letter_mode="file",
    )
    assert second.status_code == 200, second.text
    assert second.json()["snapshot_id"] == first.json()["snapshot_id"]

    tracker_id = first.json()["application"]["id"]
    listed = client.get(f"/jobs/tracker/{tracker_id}/snapshots", headers=headers)
    assert listed.status_code == 200
    assert len(listed.json()["snapshots"]) == 1
    snapshot = listed.json()["snapshots"][0]
    assert snapshot["resume"]["document_id"] == resume_id
    assert snapshot["resume_used"] is True
    assert snapshot["resume"]["content_hash"]
    assert snapshot["cover_letter"]["document_id"] == cover_id
    assert snapshot["cover_letter_mode"] == "file"

    db = db_session()
    try:
        resume = db.get(E.GeneratedDocument, resume_id)
        cover = db.get(E.GeneratedDocument, cover_id)
        assert resume.immutable_at is not None and resume.content_hash == canonical_document_hash(resume)
        assert cover.immutable_at is not None and cover.content_hash == canonical_document_hash(cover)
    finally:
        db.close()


def test_frozen_document_update_is_copy_on_write_and_snapshot_does_not_drift(client) -> None:
    headers = auth(client)
    complete_profile(client, headers)
    job_id = seed_job()
    session = _prepare(client, headers, job_id)
    old_id = session["resume"]["document_id"]
    _record_use(client, headers, session["session_id"], "resume", "uploaded")
    confirmed = confirm_via_session(client, headers, session["session_id"], resume_used=True).json()
    snapshot_id = confirmed["snapshot_id"]
    tracker_id = confirmed["application"]["id"]

    db = db_session()
    try:
        old_markdown = db.get(E.GeneratedDocument, old_id).content_markdown
    finally:
        db.close()
    update = client.put(
        f"/jobs/documents/{old_id}", headers=headers, json={"markdown": "Tuesday revision"}
    )
    assert update.status_code == 200, update.text
    new_id = update.json()["document_id"]
    assert new_id != old_id
    assert update.json()["source_document_id"] == old_id

    db = db_session()
    try:
        assert db.get(E.GeneratedDocument, old_id).content_markdown == old_markdown
        assert db.get(E.GeneratedDocument, new_id).content_markdown == "Tuesday revision"
    finally:
        db.close()
    detail = client.get(
        f"/jobs/tracker/{tracker_id}/snapshots/{snapshot_id}", headers=headers
    ).json()["snapshot"]
    assert detail["resume"]["document_id"] == old_id


def test_available_cover_letter_is_not_reported_used_and_pasted_text_is_bounded(client) -> None:
    headers = auth(client)
    complete_profile(client, headers)
    first_job = seed_job()
    first_session = _prepare(client, headers, first_job)
    first = confirm_via_session(client, headers, first_session["session_id"])
    tracker_id = first.json()["application"]["id"]
    snapshot = client.get(f"/jobs/tracker/{tracker_id}/snapshots", headers=headers).json()["snapshots"][0]
    assert first_session["cover_letter"]["document_id"] is not None
    assert snapshot["cover_letter_used"] is False
    assert snapshot["cover_letter_mode"] == "unused"
    assert snapshot["cover_letter"]["document_id"] is None

    second_job = seed_job(company="Globex", external="stage-2b-text")
    second_session = _prepare(client, headers, second_job)
    text = "Dear team,\r\n\r\nI am applying.\r\n"
    _record_use(
        client, headers, second_session["session_id"], "cover_letter", "pasted_text", text
    )
    second = confirm_via_session(
        client,
        headers,
        second_session["session_id"],
        cover_letter_mode="pasted_text",
        cover_letter_text=text,
    ).json()
    detail = client.get(
        f"/jobs/tracker/{second['application']['id']}/snapshots/{second['snapshot_id']}",
        headers=headers,
    ).json()["snapshot"]
    assert detail["cover_letter_text_snapshot"] == "Dear team,\n\nI am applying."
    assert detail["cover_letter"]["document_id"] is None
    assert len(detail["cover_letter"]["content_hash"]) == 64


def test_snapshot_routes_and_document_update_are_owner_scoped(client) -> None:
    owner = auth(client)
    complete_profile(client, owner)
    job_id = seed_job()
    session = _prepare(client, owner, job_id)
    _record_use(client, owner, session["session_id"], "resume", "uploaded")
    result = confirm_via_session(client, owner, session["session_id"], resume_used=True).json()
    tracker_id, snapshot_id = result["application"]["id"], result["snapshot_id"]

    intruder = auth(client, email="stage2b-intruder@mailbox.test-domain.co")
    assert client.get(f"/jobs/tracker/{tracker_id}/snapshots", headers=intruder).status_code == 404
    assert client.get(
        f"/jobs/tracker/{tracker_id}/snapshots/{snapshot_id}", headers=intruder
    ).status_code == 404
    assert client.put(
        f"/jobs/documents/{session['resume']['document_id']}",
        headers=intruder,
        json={"markdown": "attack"},
    ).status_code == 404


def test_distinct_sessions_allocate_distinct_attempts(client) -> None:
    headers = auth(client)
    complete_profile(client, headers)
    job_id = seed_job()
    first_session = _prepare(client, headers, job_id)
    first = confirm_via_session(client, headers, first_session["session_id"]).json()
    second_session = _prepare(client, headers, job_id)
    assert second_session["session_id"] != first_session["session_id"]
    second = confirm_via_session(client, headers, second_session["session_id"]).json()
    rows = client.get(
        f"/jobs/tracker/{first['application']['id']}/snapshots", headers=headers
    ).json()["snapshots"]
    assert [row["attempt_number"] for row in rows] == [1, 2]
    assert first["snapshot_id"] != second["snapshot_id"]


def test_foreign_session_document_rolls_back_tracker_and_freeze(client) -> None:
    owner = auth(client)
    complete_profile(client, owner)
    owner_job = seed_job()
    owner_session = _prepare(client, owner, owner_job)

    other = auth(client, email="stage2b-other@mailbox.test-domain.co")
    complete_profile(client, other)
    other_job = seed_job(company="Other", external="stage-2b-other")
    other_session = _prepare(client, other, other_job)

    db = db_session()
    try:
        session_row = db.get(E.ApplicationSession, owner_session["session_id"])
        session_row.tailored_resume_id = other_session["resume"]["document_id"]
        db.add(E.ApplicationTracker(
            user_id=session_row.user_id,
            job_id=session_row.job_id,
            status=E.ApplicationStatus.saved,
        ))
        db.commit()
    finally:
        db.close()

    _record_use(client, owner, owner_session["session_id"], "resume", "uploaded")
    response = confirm_via_session(client, owner, owner_session["session_id"], resume_used=True)
    assert response.status_code == 422
    db = db_session()
    try:
        tracker = db.scalar(select(E.ApplicationTracker).where(
            E.ApplicationTracker.user_id == user_id_for(client, owner),
            E.ApplicationTracker.job_id == owner_job,
        ))
        assert tracker.status == E.ApplicationStatus.saved
        assert tracker.applied_at is None
        foreign_doc = db.get(E.GeneratedDocument, other_session["resume"]["document_id"])
        assert foreign_doc.immutable_at is None
    finally:
        db.close()


def test_client_usage_claim_without_durable_evidence_is_rejected(client) -> None:
    headers = auth(client)
    complete_profile(client, headers)
    job_id = seed_job()
    session = _prepare(client, headers, job_id)
    response = confirm_via_session(client, headers, session["session_id"], resume_used=True)
    assert response.status_code == 422
    db = db_session()
    try:
        assert db.scalar(select(E.ApplicationSnapshot)) is None
        document = db.get(E.GeneratedDocument, session["resume"]["document_id"])
        assert document.immutable_at is None
    finally:
        db.close()


def test_frozen_cover_letter_is_copy_on_write_and_unfrozen_edit_stays_in_place(client) -> None:
    headers = auth(client)
    complete_profile(client, headers)
    job_id = seed_job()
    session = _prepare(client, headers, job_id)
    cover_id = session["cover_letter"]["document_id"]
    _record_use(client, headers, session["session_id"], "cover_letter", "uploaded")
    result = confirm_via_session(
        client, headers, session["session_id"], cover_letter_mode="file"
    ).json()
    changed = client.put(
        f"/jobs/documents/{cover_id}", headers=headers, json={"markdown": "new cover"}
    ).json()
    assert changed["document_id"] != cover_id
    assert changed["source_document_id"] == cover_id
    detail = client.get(
        f"/jobs/tracker/{result['application']['id']}/snapshots/{result['snapshot_id']}",
        headers=headers,
    ).json()["snapshot"]
    assert detail["cover_letter"]["document_id"] == cover_id

    other_job = seed_job(company="Unfrozen", external="stage-2b-unfrozen")
    unfrozen = _prepare(client, headers, other_job)["resume"]["document_id"]
    response = client.put(
        f"/jobs/documents/{unfrozen}", headers=headers, json={"markdown": "editable"}
    ).json()
    assert response["document_id"] == unfrozen
    assert response["source_document_id"] is None


def test_hash_is_independent_of_identity_paths_and_changes_with_content() -> None:
    common = dict(
        user_id=1,
        job_id=1,
        type=E.DocumentType.resume,
        format=E.DocumentFormat.json,
        format_version="v2",
        content={"b": 2, "a": 1},
        content_markdown="line 1\r\nline 2",
        plain_text="same\rtext",
    )
    first = E.GeneratedDocument(id=1, file_path="/one", **common)
    second = E.GeneratedDocument(id=999, file_path="/two", **common)
    assert canonical_document_hash(first) == canonical_document_hash(second)
    second.content = {"a": 1, "b": 3}
    assert canonical_document_hash(first) != canonical_document_hash(second)


def test_snapshot_detail_requires_parent_child_association(client) -> None:
    headers = auth(client)
    complete_profile(client, headers)
    first_job = seed_job()
    first_session = _prepare(client, headers, first_job)
    first = confirm_via_session(client, headers, first_session["session_id"]).json()
    second_job = seed_job(company="Second", external="stage-2b-association")
    second_session = _prepare(client, headers, second_job)
    second = confirm_via_session(client, headers, second_session["session_id"]).json()
    assert client.get(
        f"/jobs/tracker/{first['application']['id']}/snapshots/{second['snapshot_id']}",
        headers=headers,
    ).status_code == 404
    assert client.get(
        f"/jobs/tracker/{second['application']['id']}/snapshots/{first['snapshot_id']}",
        headers=headers,
    ).status_code == 404


def test_artifact_modes_are_strictly_validated(client) -> None:
    headers = auth(client)
    complete_profile(client, headers)
    session = _prepare(client, headers, seed_job())
    assert client.post(
        f"/application-sessions/{session['session_id']}/artifact-use",
        headers=headers,
        json={"artifact": "resume", "mode": "available"},
    ).status_code == 422

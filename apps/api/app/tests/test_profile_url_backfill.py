from __future__ import annotations

import json
import stat
from collections.abc import Callable, Iterator
from copy import deepcopy
from pathlib import Path

import pytest
from sqlalchemy import create_engine, delete, update
from sqlalchemy.orm import Session, sessionmaker

from app.db.base import Base
from app.maintenance import profile_url_backfill as backfill
from app.maintenance.profile_url_backfill import BackfillExecutionError
from app.models.entities import User, UserProfile


@pytest.fixture
def sessions(tmp_path: Path) -> Iterator[sessionmaker[Session]]:
    engine = create_engine(f"sqlite:///{tmp_path / 'backfill.db'}")
    Base.metadata.create_all(engine)
    factory = sessionmaker(bind=engine, autoflush=False, autocommit=False)
    try:
        yield factory
    finally:
        Base.metadata.drop_all(engine)
        engine.dispose()


def add_profile(factory: Callable[[], Session], **values: object) -> int:
    db = factory()
    try:
        user = User(
            email=f"profile-{values.get('portfolio_url', 'none')}-{id(values)}@test.invalid",
            hashed_password="not-used",
        )
        db.add(user)
        db.flush()
        profile = UserProfile(user_id=user.id, full_name="Backfill Test", **values)
        db.add(profile)
        db.commit()
        return profile.id
    finally:
        db.close()


def stored_profile(factory: Callable[[], Session], profile_id: int) -> UserProfile:
    db = factory()
    try:
        profile = db.get(UserProfile, profile_id)
        assert profile is not None
        db.expunge(profile)
        return profile
    finally:
        db.close()


def load_manifest(path: Path) -> dict[str, object]:
    return json.loads(path.read_text(encoding="utf-8"))


def test_default_cli_mode_is_dry_run_and_never_writes(
    sessions: sessionmaker[Session], monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    profile_id = add_profile(sessions, portfolio_url="cpandey.com")
    monkeypatch.setattr(backfill, "SessionLocal", sessions)

    assert backfill.main([]) == 0

    assert stored_profile(sessions, profile_id).portfolio_url == "cpandey.com"
    output = capsys.readouterr().out
    assert '"operation": "DRY RUN"' in output
    assert '"safely_normalizable": 1' in output


def test_dry_run_classifies_legacy_value_without_writing(
    sessions: sessionmaker[Session], tmp_path: Path
) -> None:
    profile_id = add_profile(
        sessions,
        portfolio_url="cpandey.com",
        requires_sponsorship=None,
    )
    manifest = tmp_path / "must-not-exist.json"

    summary = backfill.run_backfill(sessions, manifest_path=manifest)

    assert summary.mode == "dry_run"
    assert summary.safely_normalizable == 1
    assert summary.applied_mutations == 0
    assert stored_profile(sessions, profile_id).portfolio_url == "cpandey.com"
    assert stored_profile(sessions, profile_id).requires_sponsorship is None
    assert not manifest.exists()


def test_apply_normalizes_and_writes_private_exact_manifest(
    sessions: sessionmaker[Session], tmp_path: Path
) -> None:
    profile_id = add_profile(sessions, portfolio_url="cpandey.com")
    manifest_path = tmp_path / "rollback.json"

    summary = backfill.run_backfill(
        sessions, apply=True, manifest_path=manifest_path, batch_size=1
    )

    assert stored_profile(sessions, profile_id).portfolio_url == "https://cpandey.com/"
    assert summary.applied_mutations == 1
    assert summary.manifest_path == str(manifest_path)
    manifest = load_manifest(manifest_path)
    assert manifest["status"] == "complete"
    assert manifest["mutations"] == [
        {
            "profile_id": profile_id,
            "state": "committed",
            "changes": [
                {
                    "field": "portfolio_url",
                    "paths": ["portfolio_url"],
                    "old_value": "cpandey.com",
                    "new_value": "https://cpandey.com/",
                    "url_mutation_count": 1,
                }
            ],
        }
    ]
    assert stat.S_IMODE(manifest_path.stat().st_mode) == 0o600


def test_canonical_values_are_not_manifest_mutations(
    sessions: sessionmaker[Session], tmp_path: Path
) -> None:
    profile_id = add_profile(sessions, portfolio_url="https://cpandey.com/")
    manifest_path = tmp_path / "canonical.json"

    summary = backfill.run_backfill(sessions, apply=True, manifest_path=manifest_path)

    assert summary.safely_normalizable == 0
    assert summary.applied_mutations == 0
    assert load_manifest(manifest_path)["mutations"] == []
    assert stored_profile(sessions, profile_id).portfolio_url == "https://cpandey.com/"


def test_empty_named_url_becomes_null(sessions: sessionmaker[Session], tmp_path: Path) -> None:
    profile_id = add_profile(sessions, portfolio_url="   ")
    manifest_path = tmp_path / "empty.json"

    summary = backfill.run_backfill(sessions, apply=True, manifest_path=manifest_path)

    assert summary.empty_to_null == 1
    assert stored_profile(sessions, profile_id).portfolio_url is None
    change = load_manifest(manifest_path)["mutations"][0]["changes"][0]
    assert change["old_value"] == "   "
    assert change["new_value"] is None


@pytest.mark.parametrize(
    "unsafe",
    [
        "javascript:alert(1)",
        "data:text/html,hello",
        "file:///tmp/example",
        "ftp://example.com",
        "://broken",
        "not a url",
    ],
)
def test_unsafe_values_require_manual_review_and_remain_unchanged(
    sessions: sessionmaker[Session], tmp_path: Path, unsafe: str
) -> None:
    profile_id = add_profile(sessions, portfolio_url=unsafe)
    manifest_path = tmp_path / f"unsafe-{abs(hash(unsafe))}.json"

    summary = backfill.run_backfill(sessions, apply=True, manifest_path=manifest_path)

    assert summary.invalid_manual_review == 1
    assert summary.applied_mutations == 0
    assert stored_profile(sessions, profile_id).portfolio_url == unsafe
    assert load_manifest(manifest_path)["mutations"] == []
    assert summary.review_items == [
        {
            "profile_id": profile_id,
            "path": "portfolio_url",
            "classification": "invalid_manual_review",
        }
    ]


def test_multiple_fields_change_without_touching_unrelated_data(
    sessions: sessionmaker[Session], tmp_path: Path
) -> None:
    profile_id = add_profile(
        sessions,
        linkedin_url="linkedin.com/in/test",
        github_url="github.com/test",
        portfolio_url="https://already.example/",
        x_url="   ",
        requires_sponsorship=None,
        target_roles=["Staff Engineer"],
        phone="+1 212 555 0100",
    )

    summary = backfill.run_backfill(
        sessions, apply=True, manifest_path=tmp_path / "multiple.json"
    )

    profile = stored_profile(sessions, profile_id)
    assert profile.linkedin_url == "https://linkedin.com/in/test"
    assert profile.github_url == "https://github.com/test"
    assert profile.portfolio_url == "https://already.example/"
    assert profile.x_url is None
    assert profile.requires_sponsorship is None
    assert profile.target_roles == ["Staff Engineer"]
    assert profile.phone == "+1 212 555 0100"
    assert summary.applied_mutations == 3


def test_additional_links_preserve_order_metadata_and_manual_review_values(
    sessions: sessionmaker[Session], tmp_path: Path
) -> None:
    links = [
        {"label": "Canonical", "url": "https://example.com/", "id": "first"},
        {"label": "Blog", "url": "cpandey.com/blog", "metadata": {"featured": True}},
        {"label": "Blank", "url": "   ", "id": "third"},
        {"label": "Unsafe", "url": "javascript:alert(1)", "id": "fourth"},
    ]
    profile_id = add_profile(sessions, additional_links=links)
    manifest_path = tmp_path / "additional.json"

    summary = backfill.run_backfill(sessions, apply=True, manifest_path=manifest_path)

    expected = deepcopy(links)
    expected[1]["url"] = "https://cpandey.com/blog"
    assert stored_profile(sessions, profile_id).additional_links == expected
    assert summary.applied_mutations == 1
    assert summary.invalid_manual_review == 2
    change = load_manifest(manifest_path)["mutations"][0]["changes"][0]
    assert change["field"] == "additional_links"
    assert change["paths"] == ["additional_links.1.url"]
    assert change["old_value"] == links
    assert change["new_value"] == expected


@pytest.mark.parametrize(
    "malformed",
    [
        {"label": "not-a-list", "url": "cpandey.com"},
        ["not-an-object"],
        [{"label": "Missing URL"}],
        [{"url": "cpandey.com"}],
        [{"label": "Wrong URL type", "url": 7}],
    ],
)
def test_malformed_additional_links_are_reported_and_untouched(
    sessions: sessionmaker[Session], tmp_path: Path, malformed: object
) -> None:
    profile_id = add_profile(sessions, additional_links=malformed)

    summary = backfill.run_backfill(
        sessions,
        apply=True,
        manifest_path=tmp_path / f"malformed-{abs(hash(repr(malformed)))}.json",
    )

    assert summary.unexpected_storage_shape == 1
    assert summary.applied_mutations == 0
    assert stored_profile(sessions, profile_id).additional_links == malformed


def test_apply_is_idempotent(sessions: sessionmaker[Session], tmp_path: Path) -> None:
    profile_id = add_profile(sessions, portfolio_url="cpandey.com")
    first = backfill.run_backfill(
        sessions, apply=True, manifest_path=tmp_path / "first.json"
    )
    second = backfill.run_backfill(sessions)

    assert first.applied_mutations == 1
    assert second.safely_normalizable == 0
    assert second.empty_to_null == 0
    assert stored_profile(sessions, profile_id).portfolio_url == "https://cpandey.com/"


def test_compare_and_set_preserves_a_concurrent_user_edit(
    sessions: sessionmaker[Session], tmp_path: Path
) -> None:
    profile_id = add_profile(sessions, portfolio_url="cpandey.com")
    edited = False

    def concurrent_edit(_plan: backfill.ProfilePlan) -> None:
        nonlocal edited
        if edited:
            return
        edited = True
        db = sessions()
        try:
            db.execute(
                update(UserProfile)
                .where(UserProfile.id == profile_id)
                .values(portfolio_url="https://newsite.com/")
            )
            db.commit()
        finally:
            db.close()

    summary = backfill.run_backfill(
        sessions,
        apply=True,
        manifest_path=tmp_path / "conflict.json",
        before_compare_and_set=concurrent_edit,
    )

    assert summary.concurrent_conflicts == 1
    assert summary.applied_mutations == 0
    assert stored_profile(sessions, profile_id).portfolio_url == "https://newsite.com/"
    assert load_manifest(tmp_path / "conflict.json")["mutations"] == []


def test_rollback_restores_exact_old_value_and_dry_run_is_read_only(
    sessions: sessionmaker[Session], tmp_path: Path
) -> None:
    profile_id = add_profile(sessions, portfolio_url=" cpandey.com ")
    manifest = tmp_path / "rollback.json"
    backfill.run_backfill(sessions, apply=True, manifest_path=manifest)

    audit = backfill.run_rollback(sessions, manifest)
    assert audit.mode == "rollback_dry_run"
    assert audit.restored_mutations == 1
    assert stored_profile(sessions, profile_id).portfolio_url == "https://cpandey.com/"

    applied = backfill.run_rollback(sessions, manifest, apply=True)
    assert applied.restored_mutations == 1
    assert stored_profile(sessions, profile_id).portfolio_url == " cpandey.com "


def test_rollback_restores_exact_additional_links_structure(
    sessions: sessionmaker[Session], tmp_path: Path
) -> None:
    original = [
        {
            "label": "Blog",
            "url": "cpandey.com/blog",
            "id": "legacy-id",
            "metadata": {"rank": 1},
        }
    ]
    profile_id = add_profile(sessions, additional_links=original)
    manifest = tmp_path / "additional-rollback.json"
    backfill.run_backfill(sessions, apply=True, manifest_path=manifest)

    assert stored_profile(sessions, profile_id).additional_links[0]["url"] == (
        "https://cpandey.com/blog"
    )
    summary = backfill.run_rollback(sessions, manifest, apply=True)

    assert summary.restored_mutations == 1
    assert stored_profile(sessions, profile_id).additional_links == original


def test_rollback_conflict_preserves_newer_user_value(
    sessions: sessionmaker[Session], tmp_path: Path
) -> None:
    profile_id = add_profile(sessions, portfolio_url="cpandey.com")
    manifest = tmp_path / "rollback-conflict.json"
    backfill.run_backfill(sessions, apply=True, manifest_path=manifest)
    db = sessions()
    try:
        db.execute(
            update(UserProfile)
            .where(UserProfile.id == profile_id)
            .values(portfolio_url="https://newsite.com/")
        )
        db.commit()
    finally:
        db.close()

    summary = backfill.run_rollback(sessions, manifest, apply=True)

    assert summary.concurrent_conflicts == 1
    assert summary.restored_mutations == 0
    assert stored_profile(sessions, profile_id).portfolio_url == "https://newsite.com/"


def test_rollback_reports_missing_profile(sessions: sessionmaker[Session], tmp_path: Path) -> None:
    profile_id = add_profile(sessions, portfolio_url="cpandey.com")
    manifest = tmp_path / "rollback-missing.json"
    backfill.run_backfill(sessions, apply=True, manifest_path=manifest)
    db = sessions()
    try:
        db.execute(delete(UserProfile).where(UserProfile.id == profile_id))
        db.commit()
    finally:
        db.close()

    summary = backfill.run_rollback(sessions, manifest, apply=True)

    assert summary.missing_profiles == 1
    assert summary.restored_mutations == 0


def test_failed_manifest_prepare_cannot_claim_or_commit_mutations(
    sessions: sessionmaker[Session], tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    profile_id = add_profile(sessions, portfolio_url="cpandey.com")
    manifest = tmp_path / "failed.json"
    real_write = backfill._atomic_private_json_write
    calls = 0

    def fail_once(path: Path, payload: dict[str, object]) -> None:
        nonlocal calls
        calls += 1
        if calls == 2:
            raise OSError("simulated artifact failure")
        real_write(path, payload)

    monkeypatch.setattr(backfill, "_atomic_private_json_write", fail_once)

    with pytest.raises(BackfillExecutionError, match="backfill execution failed"):
        backfill.run_backfill(sessions, apply=True, manifest_path=manifest)

    assert stored_profile(sessions, profile_id).portfolio_url == "cpandey.com"
    payload = load_manifest(manifest)
    assert payload["status"] == "failed"
    assert payload["mutations"] == []


def test_post_commit_manifest_failure_retains_recoverable_committed_record(
    sessions: sessionmaker[Session], tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    profile_id = add_profile(sessions, portfolio_url="cpandey.com")
    manifest = tmp_path / "post-commit-failed.json"
    real_write = backfill._atomic_private_json_write
    calls = 0

    def fail_after_commit(path: Path, payload: dict[str, object]) -> None:
        nonlocal calls
        calls += 1
        if calls == 3:
            raise OSError("simulated post-commit artifact failure")
        real_write(path, payload)

    monkeypatch.setattr(backfill, "_atomic_private_json_write", fail_after_commit)

    with pytest.raises(BackfillExecutionError, match="backfill execution failed"):
        backfill.run_backfill(sessions, apply=True, manifest_path=manifest)

    assert stored_profile(sessions, profile_id).portfolio_url == "https://cpandey.com/"
    payload = load_manifest(manifest)
    assert payload["status"] == "failed"
    assert payload["mutations"][0]["state"] == "committed"
    assert payload["mutations"][0]["changes"][0]["old_value"] == "cpandey.com"


def test_manifest_path_must_not_already_exist(
    sessions: sessionmaker[Session], tmp_path: Path
) -> None:
    add_profile(sessions, portfolio_url="cpandey.com")
    manifest = tmp_path / "existing.json"
    manifest.write_text("do not overwrite", encoding="utf-8")

    with pytest.raises(BackfillExecutionError, match="already exists"):
        backfill.run_backfill(sessions, apply=True, manifest_path=manifest)

    assert manifest.read_text(encoding="utf-8") == "do not overwrite"

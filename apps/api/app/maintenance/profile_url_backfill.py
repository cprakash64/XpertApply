"""Audit, repair, and roll back legacy user-profile URL values.

Dry run is the default. Mutation requires ``--apply`` and writes a restrictive
rollback manifest before each database commit is finalized in the artifact::

    python -m app.maintenance.profile_url_backfill
    python -m app.maintenance.profile_url_backfill --apply \
        --manifest generated/maintenance/profile-url-backfill.json
    python -m app.maintenance.profile_url_backfill \
        --rollback generated/maintenance/profile-url-backfill.json
    python -m app.maintenance.profile_url_backfill \
        --rollback generated/maintenance/profile-url-backfill.json --apply

The command never runs from application startup or migrations. Normal output
contains counts and row/field references only, never stored URL values.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from collections.abc import Callable
from copy import deepcopy
from dataclasses import asdict, dataclass, field
from datetime import UTC, datetime
from enum import StrEnum
from pathlib import Path
from typing import Any

from pydantic import TypeAdapter, ValidationError
from sqlalchemy import Select, and_, select, update
from sqlalchemy.engine import make_url
from sqlalchemy.orm import Session

from app.core.config import settings
from app.db.session import SessionLocal
from app.models.entities import UserProfile
from app.profile.urls import OptionalProfileUrl, ProfileUrl

TOOL_NAME = "xpertapply-profile-url-backfill"
MANIFEST_VERSION = 1
DEFAULT_BATCH_SIZE = 100
NAMED_URL_FIELDS = ("linkedin_url", "github_url", "portfolio_url", "x_url")
MAX_REPORT_ITEMS = 50

_OPTIONAL_URL = TypeAdapter(OptionalProfileUrl)
_REQUIRED_URL = TypeAdapter(ProfileUrl)


class Classification(StrEnum):
    ALREADY_CANONICAL = "already_canonical"
    SAFELY_NORMALIZABLE = "safely_normalizable"
    EMPTY_TO_NULL = "empty_to_null"
    INVALID_MANUAL_REVIEW = "invalid_manual_review"
    UNEXPECTED_STORAGE_SHAPE = "unexpected_storage_shape"


@dataclass(frozen=True)
class ValueDecision:
    classification: Classification
    canonical: str | None = None


@dataclass(frozen=True)
class ColumnChange:
    field: str
    old_value: Any
    new_value: Any
    paths: tuple[str, ...]

    @property
    def url_mutation_count(self) -> int:
        return len(self.paths)

    def to_manifest(self) -> dict[str, Any]:
        return {
            "field": self.field,
            "paths": list(self.paths),
            "old_value": self.old_value,
            "new_value": self.new_value,
            "url_mutation_count": self.url_mutation_count,
        }


@dataclass(frozen=True)
class ProfilePlan:
    profile_id: int
    changes: tuple[ColumnChange, ...]

    @property
    def url_mutation_count(self) -> int:
        return sum(change.url_mutation_count for change in self.changes)

    def to_manifest(self, *, state: str = "prepared") -> dict[str, Any]:
        return {
            "profile_id": self.profile_id,
            "state": state,
            "changes": [change.to_manifest() for change in self.changes],
        }


@dataclass
class BackfillSummary:
    mode: str
    profiles_scanned: int = 0
    url_values_inspected: int = 0
    already_canonical: int = 0
    safely_normalizable: int = 0
    empty_to_null: int = 0
    invalid_manual_review: int = 0
    unexpected_storage_shape: int = 0
    applied_mutations: int = 0
    concurrent_conflicts: int = 0
    database_update_failures: int = 0
    by_field: dict[str, dict[str, int]] = field(default_factory=dict)
    review_items: list[dict[str, Any]] = field(default_factory=list)
    conflict_items: list[dict[str, Any]] = field(default_factory=list)
    manifest_path: str | None = None

    def record(
        self,
        classification: Classification,
        *,
        profile_id: int,
        path: str,
    ) -> None:
        self.url_values_inspected += 1
        setattr(self, classification.value, getattr(self, classification.value) + 1)
        field_name = path.split(".", 1)[0]
        counts = self.by_field.setdefault(field_name, {})
        counts[classification.value] = counts.get(classification.value, 0) + 1
        if classification in {
            Classification.INVALID_MANUAL_REVIEW,
            Classification.UNEXPECTED_STORAGE_SHAPE,
        }:
            _append_capped(
                self.review_items,
                {
                    "profile_id": profile_id,
                    "path": path,
                    "classification": classification.value,
                },
            )

    def as_safe_dict(self) -> dict[str, Any]:
        result = asdict(self)
        result["review_items_truncated"] = (
            self.invalid_manual_review + self.unexpected_storage_shape
        ) > len(self.review_items)
        result["conflict_items_truncated"] = self.concurrent_conflicts > len(self.conflict_items)
        result["by_field"] = {
            name: dict(sorted(counts.items())) for name, counts in sorted(self.by_field.items())
        }
        return result


@dataclass
class RollbackSummary:
    mode: str
    manifest_records: int = 0
    restored_mutations: int = 0
    already_restored: int = 0
    missing_profiles: int = 0
    concurrent_conflicts: int = 0
    database_update_failures: int = 0
    items: list[dict[str, Any]] = field(default_factory=list)

    def as_safe_dict(self) -> dict[str, Any]:
        result = asdict(self)
        result["items_truncated"] = (
            self.already_restored + self.missing_profiles + self.concurrent_conflicts
        ) > len(self.items)
        return result


class BackfillExecutionError(RuntimeError):
    """A database or artifact failure that should make the command exit 1."""


def classify_profile_url(value: Any, *, optional: bool) -> ValueDecision:
    """Classify one stored value through the authoritative Stage 2 type."""

    if value is None:
        if optional:
            return ValueDecision(Classification.ALREADY_CANONICAL, None)
        return ValueDecision(Classification.UNEXPECTED_STORAGE_SHAPE)
    if not isinstance(value, str):
        return ValueDecision(Classification.UNEXPECTED_STORAGE_SHAPE)
    if not value.strip():
        if optional:
            return ValueDecision(Classification.EMPTY_TO_NULL, None)
        # AdditionalLinkIn.url is required; NULL would remain outside the live
        # API contract, so a blank nested URL needs manual review.
        return ValueDecision(Classification.INVALID_MANUAL_REVIEW)
    try:
        parsed = (_OPTIONAL_URL if optional else _REQUIRED_URL).validate_python(value)
    except (ValidationError, ValueError, TypeError):
        return ValueDecision(Classification.INVALID_MANUAL_REVIEW)
    canonical = None if parsed is None else str(parsed)
    if canonical == value:
        return ValueDecision(Classification.ALREADY_CANONICAL, canonical)
    return ValueDecision(Classification.SAFELY_NORMALIZABLE, canonical)


def _append_capped(items: list[dict[str, Any]], item: dict[str, Any]) -> None:
    if len(items) < MAX_REPORT_ITEMS:
        items.append(item)


def _record_decision(
    summary: BackfillSummary,
    decision: ValueDecision,
    *,
    profile_id: int,
    path: str,
) -> None:
    summary.record(decision.classification, profile_id=profile_id, path=path)


def _additional_links_change(
    value: Any,
    *,
    profile_id: int,
    summary: BackfillSummary,
) -> ColumnChange | None:
    if value is None:
        return None  # Legacy NULL contains no URL value and is deliberately preserved.
    if not isinstance(value, list) or len(value) > 20:
        summary.record(
            Classification.UNEXPECTED_STORAGE_SHAPE,
            profile_id=profile_id,
            path="additional_links",
        )
        return None

    # Fail closed for structural problems: preserve the entire JSON column and
    # do not partially rewrite a structure the live schema cannot represent.
    for index, entry in enumerate(value):
        if (
            not isinstance(entry, dict)
            or not isinstance(entry.get("label"), str)
            or not entry["label"].strip()
            or "url" not in entry
            or not isinstance(entry["url"], str)
        ):
            summary.record(
                Classification.UNEXPECTED_STORAGE_SHAPE,
                profile_id=profile_id,
                path=f"additional_links.{index}",
            )
            return None

    normalized = deepcopy(value)
    changed_paths: list[str] = []
    for index, entry in enumerate(value):
        path = f"additional_links.{index}.url"
        decision = classify_profile_url(entry["url"], optional=False)
        _record_decision(summary, decision, profile_id=profile_id, path=path)
        if decision.classification is Classification.SAFELY_NORMALIZABLE:
            normalized[index]["url"] = decision.canonical
            changed_paths.append(path)

    if not changed_paths:
        return None
    return ColumnChange(
        field="additional_links",
        old_value=deepcopy(value),
        new_value=normalized,
        paths=tuple(changed_paths),
    )


def plan_profile(row: Any, summary: BackfillSummary) -> ProfilePlan:
    """Audit one raw profile row without validating unrelated profile fields."""

    profile_id = int(row["id"])
    changes: list[ColumnChange] = []
    for field_name in NAMED_URL_FIELDS:
        raw = row[field_name]
        decision = classify_profile_url(raw, optional=True)
        _record_decision(summary, decision, profile_id=profile_id, path=field_name)
        if decision.classification in {
            Classification.SAFELY_NORMALIZABLE,
            Classification.EMPTY_TO_NULL,
        }:
            changes.append(
                ColumnChange(
                    field=field_name,
                    old_value=raw,
                    new_value=decision.canonical,
                    paths=(field_name,),
                )
            )

    additional_change = _additional_links_change(
        row["additional_links"], profile_id=profile_id, summary=summary
    )
    if additional_change:
        changes.append(additional_change)
    return ProfilePlan(profile_id=profile_id, changes=tuple(changes))


def _profile_page(after_id: int, batch_size: int) -> Select[Any]:
    return (
        select(
            UserProfile.id,
            UserProfile.linkedin_url,
            UserProfile.github_url,
            UserProfile.portfolio_url,
            UserProfile.x_url,
            UserProfile.additional_links,
        )
        .where(UserProfile.id > after_id)
        .order_by(UserProfile.id)
        .limit(batch_size)
    )


def _compare(column: Any, value: Any) -> Any:
    return column.is_(None) if value is None else column == value


def _cas_statement(plan: ProfilePlan, *, reverse: bool = False) -> Any:
    conditions = [UserProfile.id == plan.profile_id]
    values: dict[str, Any] = {}
    for change in plan.changes:
        expected = change.new_value if reverse else change.old_value
        replacement = change.old_value if reverse else change.new_value
        conditions.append(_compare(getattr(UserProfile, change.field), expected))
        values[change.field] = replacement
    return (
        update(UserProfile)
        .where(and_(*conditions))
        .values(**values)
        .execution_options(synchronize_session=False)
    )


def _default_manifest_path() -> Path:
    stamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
    return Path("generated/maintenance") / f"profile-url-backfill-{stamp}-{os.getpid()}.json"


def _database_identity(database_url: str) -> dict[str, Any]:
    url = make_url(database_url)
    database = Path(url.database).name if url.database and url.get_backend_name() == "sqlite" else url.database
    return {
        "backend": url.get_backend_name(),
        "host": url.host or "local",
        "port": url.port,
        "database": database or "default",
    }


def _atomic_private_json_write(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    try:
        os.chmod(path.parent, 0o700)
    except OSError:
        pass
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    try:
        descriptor = os.open(temporary, flags, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, indent=2, ensure_ascii=False)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
        os.chmod(path, 0o600)
    finally:
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass


def _new_manifest(path: Path) -> dict[str, Any]:
    return {
        "schema_version": MANIFEST_VERSION,
        "tool": TOOL_NAME,
        "status": "in_progress",
        "created_at": datetime.now(UTC).isoformat(),
        "completed_at": None,
        "application_environment": settings.app_env,
        "database": _database_identity(settings.database_url),
        "mutations": [],
        "notes": "Contains sensitive prior URL values; keep private and never commit.",
        "manifest_path": str(path),
    }


def run_backfill(
    session_factory: Callable[[], Session],
    *,
    apply: bool = False,
    batch_size: int = DEFAULT_BATCH_SIZE,
    manifest_path: str | Path | None = None,
    before_compare_and_set: Callable[[ProfilePlan], None] | None = None,
) -> BackfillSummary:
    """Audit or apply the legacy URL repair in bounded, atomic profile batches.

    ``before_compare_and_set`` is a test seam used to simulate an online edit
    after planning. Production callers leave it unset.
    """

    if batch_size < 1:
        raise ValueError("batch_size must be positive")
    path = Path(manifest_path) if manifest_path else _default_manifest_path()
    summary = BackfillSummary(mode="apply" if apply else "dry_run")
    manifest: dict[str, Any] | None = None
    if apply:
        if path.exists():
            raise BackfillExecutionError("manifest path already exists")
        manifest = _new_manifest(path)
        try:
            _atomic_private_json_write(path, manifest)
        except OSError as cause:
            raise BackfillExecutionError("manifest could not be created") from cause
        summary.manifest_path = str(path)

    after_id = 0
    try:
        while True:
            db = session_factory()
            prepared: list[dict[str, Any]] = []
            committed = False
            try:
                rows = list(db.execute(_profile_page(after_id, batch_size)).mappings())
                if not rows:
                    break
                after_id = int(rows[-1]["id"])
                plans: list[ProfilePlan] = []
                for row in rows:
                    summary.profiles_scanned += 1
                    plan = plan_profile(row, summary)
                    if plan.changes:
                        plans.append(plan)

                if not apply:
                    db.rollback()
                    continue

                for plan in plans:
                    if before_compare_and_set:
                        before_compare_and_set(plan)
                    result = db.execute(_cas_statement(plan))
                    if result.rowcount == 1:
                        prepared.append(plan.to_manifest())
                    else:
                        summary.concurrent_conflicts += plan.url_mutation_count
                        _append_capped(
                            summary.conflict_items,
                            {
                                "profile_id": plan.profile_id,
                                "paths": [path for change in plan.changes for path in change.paths],
                            },
                        )

                if prepared:
                    assert manifest is not None
                    manifest["mutations"].extend(prepared)
                    _atomic_private_json_write(path, manifest)
                db.commit()
                committed = True
                for record in prepared:
                    record["state"] = "committed"
                    summary.applied_mutations += sum(
                        int(change["url_mutation_count"]) for change in record["changes"]
                    )
                if prepared:
                    _atomic_private_json_write(path, manifest)
            except BaseException:
                db.rollback()
                if manifest is not None and prepared and not committed:
                    manifest["mutations"] = [
                        record for record in manifest["mutations"] if record not in prepared
                    ]
                raise
            finally:
                db.close()
    except BaseException as cause:
        summary.database_update_failures += 1
        if manifest is not None:
            manifest["status"] = "interrupted" if isinstance(cause, KeyboardInterrupt) else "failed"
            manifest["completed_at"] = datetime.now(UTC).isoformat()
            manifest["summary"] = summary.as_safe_dict()
            _atomic_private_json_write(path, manifest)
        if isinstance(cause, KeyboardInterrupt):
            raise
        if isinstance(cause, BackfillExecutionError):
            raise
        raise BackfillExecutionError("backfill execution failed") from cause

    if manifest is not None:
        manifest["status"] = "complete"
        manifest["completed_at"] = datetime.now(UTC).isoformat()
        manifest["summary"] = summary.as_safe_dict()
        try:
            _atomic_private_json_write(path, manifest)
        except OSError as cause:
            raise BackfillExecutionError("final manifest could not be written") from cause
    return summary


def _read_manifest(path: Path) -> dict[str, Any]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as cause:
        raise BackfillExecutionError("manifest could not be read") from cause
    if (
        not isinstance(payload, dict)
        or payload.get("tool") != TOOL_NAME
        or payload.get("schema_version") != MANIFEST_VERSION
        or not isinstance(payload.get("mutations"), list)
    ):
        raise BackfillExecutionError("manifest has an unsupported format")
    return payload


def _plan_from_manifest(record: dict[str, Any]) -> ProfilePlan:
    try:
        changes = tuple(
            ColumnChange(
                field=str(change["field"]),
                old_value=change["old_value"],
                new_value=change["new_value"],
                paths=tuple(str(path) for path in change["paths"]),
            )
            for change in record["changes"]
        )
        profile_id = int(record["profile_id"])
    except (KeyError, TypeError, ValueError) as cause:
        raise BackfillExecutionError("manifest mutation is malformed") from cause
    if not changes or any(change.field not in {*NAMED_URL_FIELDS, "additional_links"} for change in changes):
        raise BackfillExecutionError("manifest mutation names an unsupported field")
    return ProfilePlan(profile_id=profile_id, changes=changes)


def _current_matches(db: Session, plan: ProfilePlan, *, old: bool) -> bool:
    conditions = [UserProfile.id == plan.profile_id]
    for change in plan.changes:
        value = change.old_value if old else change.new_value
        conditions.append(_compare(getattr(UserProfile, change.field), value))
    return db.scalar(select(UserProfile.id).where(and_(*conditions))) is not None


def run_rollback(
    session_factory: Callable[[], Session],
    manifest_path: str | Path,
    *,
    apply: bool = False,
    batch_size: int = DEFAULT_BATCH_SIZE,
) -> RollbackSummary:
    """Audit or safely restore prior values from an apply manifest."""

    if batch_size < 1:
        raise ValueError("batch_size must be positive")
    manifest = _read_manifest(Path(manifest_path))
    records = [
        record
        for record in manifest["mutations"]
        if isinstance(record, dict) and record.get("state") in {"committed", "prepared"}
    ]
    summary = RollbackSummary(mode="rollback_apply" if apply else "rollback_dry_run")
    summary.manifest_records = len(records)

    for start in range(0, len(records), batch_size):
        db = session_factory()
        try:
            for record in records[start : start + batch_size]:
                plan = _plan_from_manifest(record)
                mutation_count = plan.url_mutation_count
                if _current_matches(db, plan, old=True):
                    summary.already_restored += mutation_count
                    _append_capped(
                        summary.items,
                        {"profile_id": plan.profile_id, "result": "already_restored"},
                    )
                    continue
                exists = db.scalar(select(UserProfile.id).where(UserProfile.id == plan.profile_id))
                if exists is None:
                    summary.missing_profiles += 1
                    _append_capped(
                        summary.items,
                        {"profile_id": plan.profile_id, "result": "missing_profile"},
                    )
                    continue
                if not _current_matches(db, plan, old=False):
                    summary.concurrent_conflicts += mutation_count
                    _append_capped(
                        summary.items,
                        {
                            "profile_id": plan.profile_id,
                            "result": "conflict",
                            "paths": [path for change in plan.changes for path in change.paths],
                        },
                    )
                    continue
                if not apply:
                    summary.restored_mutations += mutation_count
                    continue
                result = db.execute(_cas_statement(plan, reverse=True))
                if result.rowcount == 1:
                    summary.restored_mutations += mutation_count
                else:
                    summary.concurrent_conflicts += mutation_count
            if apply:
                db.commit()
            else:
                db.rollback()
        except BaseException as cause:
            db.rollback()
            summary.database_update_failures += 1
            if isinstance(cause, KeyboardInterrupt):
                raise
            if isinstance(cause, BackfillExecutionError):
                raise
            raise BackfillExecutionError("rollback execution failed") from cause
        finally:
            db.close()
    return summary


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="profile-url-backfill", description=__doc__)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--dry-run", action="store_true", help="Audit only (the default).")
    mode.add_argument("--apply", action="store_true", help="Perform compare-and-set mutations.")
    parser.add_argument("--rollback", metavar="MANIFEST", help="Audit or apply a rollback manifest.")
    parser.add_argument("--manifest", help="Private rollback-manifest path for an APPLY run.")
    parser.add_argument("--batch-size", type=int, default=DEFAULT_BATCH_SIZE)
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = _parser()
    args = parser.parse_args(argv)
    if args.batch_size < 1:
        parser.error("--batch-size must be positive")
    if args.rollback and args.manifest:
        parser.error("--manifest cannot be combined with --rollback")
    if not args.apply:
        args.dry_run = True

    operation = "ROLLBACK APPLY" if args.rollback and args.apply else (
        "ROLLBACK DRY RUN" if args.rollback else ("APPLY" if args.apply else "DRY RUN")
    )
    print(
        json.dumps(
            {
                "operation": operation,
                "application_environment": settings.app_env,
                "database": _database_identity(settings.database_url),
            },
            indent=2,
        )
    )
    try:
        if args.rollback:
            result = run_rollback(
                SessionLocal,
                args.rollback,
                apply=args.apply,
                batch_size=args.batch_size,
            )
        else:
            result = run_backfill(
                SessionLocal,
                apply=args.apply,
                batch_size=args.batch_size,
                manifest_path=args.manifest,
            )
    except BackfillExecutionError as cause:
        print(
            json.dumps(
                {"error": "execution_failed", "reason": str(cause)},
                indent=2,
            ),
            file=sys.stderr,
        )
        return 1
    print(json.dumps(result.as_safe_dict(), indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())

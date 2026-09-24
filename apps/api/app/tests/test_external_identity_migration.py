from __future__ import annotations

from pathlib import Path

import pytest
from sqlalchemy import create_engine, inspect, text

from alembic import command
from alembic.config import Config


def _config(database_url: str) -> Config:
    api_root = Path(__file__).resolve().parents[2]
    config = Config()
    config.set_main_option("script_location", str(api_root / "alembic"))
    config.set_main_option("sqlalchemy.url", database_url)
    return config


def test_external_identity_migration_upgrade_and_safe_downgrade(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    database_url = f"sqlite:///{tmp_path / 'auth2a.sqlite'}"
    monkeypatch.delenv("DATABASE_URL", raising=False)
    config = _config(database_url)
    engine = create_engine(database_url)

    with engine.begin() as connection:
        connection.execute(text(
            "CREATE TABLE users ("
            "id INTEGER NOT NULL PRIMARY KEY, "
            "email VARCHAR(320) NOT NULL UNIQUE, "
            "hashed_password VARCHAR(255) NOT NULL, "
            "created_at DATETIME DEFAULT CURRENT_TIMESTAMP, "
            "updated_at DATETIME DEFAULT CURRENT_TIMESTAMP)"
        ))
        connection.execute(text(
            "INSERT INTO users (id, email, hashed_password) VALUES "
            "(1, 'first@example.com', 'hash-one'), (2, 'second@example.com', 'hash-two')"
        ))
    command.stamp(config, "0033_snapshot_provenance")

    command.upgrade(config, "0034_external_identities")
    inspector = inspect(engine)
    hashed_password = next(
        column for column in inspector.get_columns("users") if column["name"] == "hashed_password"
    )
    assert hashed_password["nullable"] is True
    assert "external_identities" in inspector.get_table_names()
    with engine.begin() as connection:
        users = connection.execute(text(
            "SELECT id, email, hashed_password FROM users ORDER BY id"
        )).all()
        assert users == [
            (1, "first@example.com", "hash-one"),
            (2, "second@example.com", "hash-two"),
        ]
        assert connection.scalar(text("SELECT count(*) FROM external_identities")) == 0
        connection.execute(text(
            "INSERT INTO users (id, email, hashed_password) "
            "VALUES (3, 'provider@example.com', NULL)"
        ))

    with pytest.raises(RuntimeError, match="provider-only users"):
        command.downgrade(config, "0033_snapshot_provenance")
    assert "external_identities" in inspect(engine).get_table_names()

    with engine.begin() as connection:
        connection.execute(text("DELETE FROM users WHERE id = 3"))
    command.downgrade(config, "0033_snapshot_provenance")
    inspector = inspect(engine)
    assert "external_identities" not in inspector.get_table_names()
    hashed_password = next(
        column for column in inspector.get_columns("users") if column["name"] == "hashed_password"
    )
    assert hashed_password["nullable"] is False
    with engine.begin() as connection:
        assert connection.execute(text(
            "SELECT id, email, hashed_password FROM users ORDER BY id"
        )).all() == [
            (1, "first@example.com", "hash-one"),
            (2, "second@example.com", "hash-two"),
        ]
    engine.dispose()

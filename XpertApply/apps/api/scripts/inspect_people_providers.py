"""Why is each People provider running, or not? Answered without calling any.

    python -m scripts.inspect_people_providers
    python -m scripts.inspect_people_providers --provider brightdata
    python -m scripts.inspect_people_providers --user someone@example.com

Every question an operator asked during the live incident — "is Apollo even
enabled?", "did Bright Data ever get a dataset id?", "is that circuit open?",
"is the budget spent or was it never set?" — is answerable from this output.

It makes **no external calls** and prints **no secrets**: a credential is
reported as ``[set]`` or ``[missing]`` and never echoed.
"""

from __future__ import annotations

import argparse
import json
import sys
from typing import Any

from sqlalchemy import select

from app.core.config import settings
from app.core.config_validation import collect_people_provider_findings
from app.db.session import SessionLocal
from app.models.entities import User
from app.people.actionable import (
    ACTIONABLE_CONTACT_POLICY_VERSION,
    PEOPLE_DISPLAY_POLICY_VERSION,
)
from app.people.brightdata import (
    BRIGHTDATA_PROFILE_STRATEGY_VERSION,
    verification_configuration_gap,
)
from app.people.circuit import circuit_state
from app.people.provider_registry import KNOWN_PROVIDERS
from app.people.providers import account_fingerprint
from app.people.service import (
    PEOPLE_SEARCH_CONTRACT_VERSION,
    _provider_budget_state,
    configured_provider_order,
)

_INSPECTABLE = ("brightdata", "openai_web", "pdl", "apollo")


def _credential(value: str | None) -> str:
    return "[set]" if (value or "").strip() else "[missing]"


def _budget(db: Any, *, provider: str, user_id: int | None) -> dict[str, Any]:
    global_budget, per_user = {
        "brightdata": (
            settings.people_brightdata_daily_record_budget,
            settings.people_brightdata_per_user_daily_limit,
        ),
        "openai_web": (
            settings.people_openai_web_daily_call_budget,
            settings.people_openai_web_per_user_daily_limit,
        ),
        "pdl": (
            settings.people_pdl_daily_credit_budget,
            settings.people_pdl_per_user_daily_limit,
        ),
        "apollo": (
            settings.people_apollo_daily_credit_budget,
            settings.people_apollo_per_user_daily_limit,
        ),
    }[provider]
    state: str | None = None
    if db is not None and user_id is not None:
        blocked = _provider_budget_state(
            db,
            provider=provider,
            user_id=user_id,
            global_budget=int(global_budget),
            per_user_budget=int(per_user),
        )
        state = blocked.value if blocked else "available"
    return {
        "daily_budget": int(global_budget),
        "per_user_daily_limit": int(per_user),
        # "invalid_configuration" here means enabled-but-unfunded, which is the
        # state that silently skipped Apollo on every discovery for weeks.
        "state": state or "not_evaluated",
    }


def _enabled(provider: str) -> bool:
    return {
        "brightdata": settings.people_brightdata_verification_enabled,
        "openai_web": settings.people_openai_web_discovery_enabled,
        "pdl": settings.people_pdl_discovery_enabled,
        "apollo": settings.people_apollo_discovery_enabled,
    }[provider]


def _api_key(provider: str) -> str | None:
    return {
        "brightdata": settings.brightdata_api_token,
        "openai_web": settings.openai_api_key,
        "pdl": settings.pdl_api_key,
        "apollo": settings.apollo_api_key,
    }[provider]


def _skip_reason(provider: str, order: list[str], budget: dict[str, Any]) -> str | None:
    """The typed reason this provider would be skipped on the next discovery."""

    if provider not in order:
        return "not_in_provider_order"
    if not _enabled(provider):
        return "disabled"
    if not (_api_key(provider) or "").strip():
        return "missing_credentials"
    if provider == "brightdata":
        if verification_configuration_gap():
            return "invalid_configuration"
    if budget["daily_budget"] <= 0 and budget["per_user_daily_limit"] <= 0:
        return "invalid_configuration"
    if budget["state"] not in {"available", "not_evaluated"}:
        return budget["state"]
    return None


def inspect(provider_filter: str | None, user_ref: str | None) -> dict[str, Any]:
    order = configured_provider_order()
    db = None
    user_id: int | None = None
    try:
        if user_ref:
            db = SessionLocal()
            user = db.scalar(
                select(User).where(
                    User.email == user_ref
                    if not user_ref.isdigit()
                    else User.id == int(user_ref)
                )
            )
            user_id = user.id if user else None
    except Exception:  # noqa: BLE001 - diagnostics must never fail the operator
        db = None

    providers: dict[str, Any] = {}
    for name in _INSPECTABLE:
        if provider_filter and name != provider_filter:
            continue
        budget = _budget(db, provider=name, user_id=user_id)
        snapshot = circuit_state(
            provider=name,
            account_fingerprint=account_fingerprint(_api_key(name)),
            operation="people_search",
        )
        entry: dict[str, Any] = {
            "in_provider_order": name in order,
            "order_position": order.index(name) if name in order else None,
            "enabled": _enabled(name),
            "credentials": _credential(_api_key(name)),
            "budget": budget,
            "circuit": snapshot.as_label(),
            "eligible": False,
            "skip_reason": None,
        }
        entry["skip_reason"] = _skip_reason(name, order, budget)
        entry["eligible"] = entry["skip_reason"] is None
        if name == "brightdata":
            entry["role"] = "profile_verification_only"
            entry["dataset_id"] = _credential(settings.people_brightdata_dataset_id)
            entry["verification_configuration_gap"] = verification_configuration_gap()
            entry["strategy_version"] = BRIGHTDATA_PROFILE_STRATEGY_VERSION
            entry["note"] = (
                "Verifies profiles other providers discovered. Company/title "
                "discovery is unavailable until an official contract or an "
                "Employee Data API integration exists."
            )
        if name == "apollo":
            entry["note"] = (
                "Retained for internal evaluation only. Requires confirmed "
                "commercial entitlement before customer-facing use."
            )
        providers[name] = entry

    if db is not None:
        db.close()

    return {
        "provider_order": order,
        "primary_provider": settings.people_primary_provider,
        "providers": providers,
        "actionable_contact_policy": {
            "version": ACTIONABLE_CONTACT_POLICY_VERSION,
            "display_policy_version": PEOPLE_DISPLAY_POLICY_VERSION,
            "require_linkedin_for_display": bool(
                settings.people_require_linkedin_for_display
            ),
            "min_data_confidence": float(settings.people_min_data_confidence),
        },
        "cache_contract_version": PEOPLE_SEARCH_CONTRACT_VERSION,
        "configuration_findings": [
            f"{finding.setting}: {finding.problem}"
            for finding in collect_people_provider_findings(settings)
        ],
        "user_reference_resolved": user_id is not None if user_ref else None,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Inspect People provider configuration. Makes no external calls."
    )
    parser.add_argument("--provider", choices=sorted(KNOWN_PROVIDERS - {"mock"}))
    parser.add_argument("--user", help="email or user id, for budget evaluation")
    args = parser.parse_args(argv)
    print(json.dumps(inspect(args.provider, args.user), indent=2, default=str))
    return 0


if __name__ == "__main__":  # pragma: no cover - CLI entry point
    sys.exit(main())

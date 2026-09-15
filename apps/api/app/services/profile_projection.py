"""The trust boundary between stored profile data and AI / snapshot payloads.

Why this module exists (NEW-07)
-------------------------------
``profile_payload`` built its profile section with ``public_dict``, which copies
**every** column of ``UserProfile`` and subtracts only ``hashed_password``. When
``UserProfile`` gained ``workday_password_ciphertext`` — the encrypted
employer-portal password — that column silently joined every AI prompt and every
``GeneratedDocument.source_profile_snapshot``. The ciphertext was transmitted to
OpenAI on four routes and persisted locally, with no feature reading it.

The defect was not the field. It was the *direction* of the filter: a deny-list
over a generic serializer is fail-OPEN, so every future column is exposed by
default and the next credential-shaped column repeats the incident.

The design
----------
1. :data:`AI_PROFILE_FIELDS` is an explicit **allow-list**. A column absent from
   it never reaches a prompt or a snapshot, so adding a column to
   ``UserProfile`` is fail-CLOSED — inert until someone deliberately lists it.
   ``test_new07_credential_minimization.py`` fails if a new column appears in
   neither the allow-list nor the reviewed-and-excluded set, which forces the
   decision to be made rather than defaulted.
2. :func:`scrub_credential_keys` is defense in depth at the provider boundary,
   not the primary control. It catches credential-shaped keys arriving from
   anywhere else in a payload — a nested model, a future helper — and is
   deliberately secondary: the allow-list is what makes the profile safe.

Not in scope: the credential's authoritative store. ``UserProfile.workday
_password_ciphertext`` keeps holding it and ``app.profile.credentials`` keeps
encrypting and decrypting it for the Workday flow that legitimately needs it.
Minimization removes it from payloads that never needed it, not from the column
that owns it.
"""

from __future__ import annotations

from typing import Any

#: ``UserProfile`` columns that may travel to an AI provider and into a
#: generated-document snapshot.
#:
#: Every entry is consumed by document generation, the application-answer
#: pipeline, or a prompt template — verified against the source rather than
#: assumed. Internal identifiers and timestamps are retained because snapshot
#: provenance uses them and they carry no secret; they are listed explicitly
#: like everything else.
AI_PROFILE_FIELDS: frozenset[str] = frozenset(
    {
        # identity / provenance
        "id",
        "user_id",
        "created_at",
        "updated_at",
        # name
        "full_name",
        "first_name",
        "middle_name",
        "last_name",
        "preferred_first_name",
        "preferred_last_name",
        "preferred_name",
        "name_confirmed",
        # contact
        "application_email",
        "application_email_confirmed",
        "application_email_updated_at",
        "phone",
        "phone_country_code",
        "phone_country_iso2",
        "phone_national_number",
        "phone_e164",
        # location
        "location_city",
        "location_state",
        "location_postal_code",
        "location_country",
        # links
        "linkedin_url",
        "github_url",
        "portfolio_url",
        "x_url",
        "additional_links",
        # eligibility / preferences
        "work_authorization",
        "requires_sponsorship",
        "open_to_relocation",
        "target_roles",
        "target_levels",
        "preferred_locations",
        "remote_preference",
        "skills",
    }
)

#: ``UserProfile`` columns deliberately withheld, with the reason recorded so the
#: omission reads as a decision. The fail-closed test requires every column to be
#: in exactly one of this set or :data:`AI_PROFILE_FIELDS`.
AI_PROFILE_EXCLUDED_FIELDS: dict[str, str] = {
    "workday_password_ciphertext": (
        "Encrypted employer-portal credential (NEW-07). No prompt or snapshot "
        "consumes it. Served only by app.profile.credentials for the Workday "
        "flow, which reads the column directly."
    ),
}

#: Key names that must never appear in a payload leaving for an AI provider or
#: landing in a snapshot. Secondary to the allow-list: this catches credential
#: material arriving from some other model or helper.
#:
#: Matching is on the exact key name, lowercased. Substring matching is
#: deliberately avoided — it would strike legitimate user data such as
#: ``Certification.credential_url`` or ``JobMatch.job_content_hash``.
CREDENTIAL_KEY_NAMES: frozenset[str] = frozenset(
    {
        "workday_password_ciphertext",
        "workday_password",
        "hashed_password",
        "password",
        "password_hash",
        "secret",
        "secret_key",
        "encryption_key",
        "api_key",
        "access_token",
        "refresh_token",
        "id_token",
        "oauth_token",
        "session_secret",
        "private_key",
        "client_secret",
        "credentials_encryption_key",
    }
)


def safe_profile_dict(profile: Any) -> dict[str, Any]:
    """Project a ``UserProfile`` row onto :data:`AI_PROFILE_FIELDS`.

    Allow-list, not deny-list: an attribute the profile happens to carry but
    this set does not name is simply never read.
    """
    if profile is None:
        return {}
    return {
        name: getattr(profile, name)
        for name in sorted(AI_PROFILE_FIELDS)
        if hasattr(profile, name)
    }


def _is_credential_key(key: Any) -> bool:
    return isinstance(key, str) and key.strip().lower() in CREDENTIAL_KEY_NAMES


def scrub_credential_keys(value: Any) -> tuple[Any, int]:
    """Return ``(copy without credential-shaped keys, number removed)``.

    Recurses through dicts and lists. Values are never inspected or logged —
    only key names are examined — so calling this can never surface a secret.
    """
    removed = 0
    if isinstance(value, dict):
        cleaned: dict[Any, Any] = {}
        for key, item in value.items():
            if _is_credential_key(key):
                removed += 1
                continue
            sub, sub_removed = scrub_credential_keys(item)
            removed += sub_removed
            cleaned[key] = sub
        return cleaned, removed
    if isinstance(value, list):
        out = []
        for item in value:
            sub, sub_removed = scrub_credential_keys(item)
            removed += sub_removed
            out.append(sub)
        return out, removed
    if isinstance(value, tuple):
        items = [scrub_credential_keys(item) for item in value]
        return tuple(item for item, _ in items), sum(count for _, count in items)
    return value, 0


def find_credential_key_paths(value: Any, prefix: str = "") -> list[str]:
    """Dotted paths of credential-shaped keys inside ``value``.

    Used by the historical-snapshot audit to report *where* the problem is
    without ever reading, printing or returning the stored value.
    """
    found: list[str] = []
    if isinstance(value, dict):
        for key, item in value.items():
            path = f"{prefix}.{key}" if prefix else str(key)
            if _is_credential_key(key):
                found.append(path)
            else:
                found.extend(find_credential_key_paths(item, path))
    elif isinstance(value, list):
        for index, item in enumerate(value):
            found.extend(find_credential_key_paths(item, f"{prefix}[{index}]"))
    return found

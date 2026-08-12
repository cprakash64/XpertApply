"""The provider registry and the one parser for PEOPLE_PROVIDER_ORDER.

A leaf module on purpose: the settings model validates the order at load time,
and the waterfall reads it at request time. Both need the same definition of a
valid order, and neither may import the other — this module imports nothing from
the application, so it can sit under both.
"""

from __future__ import annotations

# Every provider the waterfall knows how to run. "mock" exists for tests and is
# rejected outside test/development by the settings validator.
#
# Adding a name here is not the same as enabling it: each provider still has its
# own enable flag, credential and budget, and startup validation refuses an
# order that names a provider the deployment cannot actually run. That is what
# keeps this list open to a future public-web adapter (SearXNG or similar)
# without any of them becoming reachable by accident.
KNOWN_PROVIDERS: frozenset[str] = frozenset(
    {"brightdata", "pdl", "apollo", "openai_web", "mock"}
)


def normalize_provider_order(value: object) -> list[str]:
    """Parse a provider order from JSON, CSV, or an already-parsed list.

    One entry point so the settings validator, the startup checks, and the
    runtime chain can never disagree about what the configured order is. The
    documented form is a JSON array; a comma-separated string is accepted
    because that is what an operator naturally types into a .env file, and
    silently crashing on it (``SettingsError: error parsing value``) taught
    nobody anything.

    Raises ``ValueError`` with a named cause for every malformed shape. It does
    NOT validate the order against the primary provider — that needs the rest of
    the settings and belongs to config_validation.
    """

    if value is None:
        return []
    if isinstance(value, str):
        text = value.strip()
        if not text:
            return []
        if text.startswith("["):
            import json

            try:
                parsed = json.loads(text)
            except json.JSONDecodeError as exc:
                raise ValueError(
                    "PEOPLE_PROVIDER_ORDER looks like JSON but is not valid JSON. "
                    'Use ["pdl","apollo"] or pdl,apollo.'
                ) from exc
            if not isinstance(parsed, list):
                raise ValueError(
                    'PEOPLE_PROVIDER_ORDER must be a list, e.g. ["pdl","apollo"].'
                )
            raw_items: list[object] = list(parsed)
        else:
            raw_items = list(text.split(","))
    elif isinstance(value, list | tuple):
        raw_items = list(value)
    else:
        raise ValueError(
            'PEOPLE_PROVIDER_ORDER must be a list or comma-separated string, '
            'e.g. ["pdl","apollo"] or pdl,apollo.'
        )

    order: list[str] = []
    for raw in raw_items:
        name = str(raw).strip().strip("\"'").lower()
        if not name:
            raise ValueError(
                "PEOPLE_PROVIDER_ORDER contains an empty provider name. "
                "Remove the stray separator."
            )
        if name not in KNOWN_PROVIDERS:
            raise ValueError(
                f"PEOPLE_PROVIDER_ORDER contains unknown provider {name!r}. "
                f"Known providers: {', '.join(sorted(KNOWN_PROVIDERS))}."
            )
        if name in order:
            raise ValueError(
                f"PEOPLE_PROVIDER_ORDER lists duplicate provider {name!r}. "
                "Each provider may appear once."
            )
        order.append(name)
    return order

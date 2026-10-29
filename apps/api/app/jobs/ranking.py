"""Deterministic job ranking and keyset pagination for ``GET /jobs``.

The list used to sort by the exact fit score and then by date. Exact scores almost never tie, so recency
effectively never mattered, and "newest" was a re-sort done in the browser over whatever had been downloaded.
This module is the one place that decides order, on the server, over the whole matching set.

``best_recent`` (default)
    Strong fit is the dominant signal; among jobs of *comparable* fit, newer genuine postings come first.
    "Comparable" is the fit BAND the product already shows (see :data:`FIT_BANDS`), so no new threshold is invented.
    Within a band: dated postings before undated ones, newest posting DAY first, then higher fit within that day,
    then the exact posting time, then the job id. A recent low-fit job can therefore never outrank a strong match,
    and two jobs posted on the same day are ordered by how well they fit.
``fit``
    Exact fit score descending (unscored last), then newest, then id.
``newest``
    Verified posting time descending (undated last), then fit, then id.

Only ``posted_at`` is a posting date. ``discovered_at`` is when WE found the job: it never places a job by date and is
never presented as a posting date. A job with no ``posted_at`` is "undated" and sorts after every dated job in the same
group, in every sort mode.

Every key ends with the job id, so the order is total and deterministic: no two jobs compare equal, which is what makes
keyset pagination exact. A cursor is the sort mode plus the rank key of the last job returned; the next page is every
job whose key is strictly greater. It carries no user data, so a forged or replayed cursor can only move within the
caller's own list.
"""

from __future__ import annotations

import base64
import json
from bisect import bisect_right
from datetime import UTC, datetime
from typing import Any, Literal

SortMode = Literal["best_recent", "fit", "newest"]
SORT_MODES: tuple[str, ...] = ("best_recent", "fit", "newest")
DEFAULT_SORT: SortMode = "best_recent"

#: The fit bands, highest first: (minimum score, rank). They mirror ``apps/web/lib/fitScore.ts``
#: (Strong / Good / Stretch / Low). A score under the last minimum is still "Low"; no score ranks below every band.
FIT_BANDS: tuple[tuple[float, int], ...] = ((80.0, 3), (60.0, 2), (45.0, 1))
LOW_BAND = 0
UNSCORED_BAND = -1

_MICROS = 1_000_000
Key = tuple[int, ...]


def fit_band(score: float | None) -> int:
    """3 strong, 2 good, 1 stretch, 0 low, -1 unscored."""
    if score is None or score != score:  # None or NaN
        return UNSCORED_BAND
    for minimum, rank in FIT_BANDS:
        if score >= minimum:
            return rank
    return LOW_BAND


def _as_utc(value: datetime | None) -> datetime | None:
    if value is None:
        return None
    return value.replace(tzinfo=UTC) if value.tzinfo is None else value.astimezone(UTC)


def _posted_micros(posted_at: datetime | None) -> int | None:
    moment = _as_utc(posted_at)
    return None if moment is None else int(moment.timestamp() * _MICROS)


def rank_key(sort: SortMode, *, job_id: int, fit_score: float | None, posted_at: datetime | None) -> Key:
    """The total-order key for one job; smaller sorts first. Integers only, so a cursor round-trips exactly."""
    fit_scaled = -1_000_000 if fit_score is None or fit_score != fit_score else int(round(fit_score * 1000))
    posted = _posted_micros(posted_at)
    dated = 0 if posted is not None else 1
    posted_neg = 0 if posted is None else -posted
    if sort == "fit":
        return (-fit_scaled, dated, posted_neg, job_id)
    if sort == "newest":
        return (dated, posted_neg, -fit_scaled, job_id)
    # best_recent: band, dated first, newest DAY first, higher fit within the day, then exact time, then id.
    day = 0 if posted is None else -(_as_utc(posted_at).toordinal())  # type: ignore[union-attr]
    return (-fit_band(fit_score), dated, day, -fit_scaled, posted_neg, job_id)


# --------------------------------------------------------------------------- #
# Cursor
# --------------------------------------------------------------------------- #
class InvalidCursor(ValueError):
    """The cursor is malformed, for another sort mode, or cannot be a rank key."""


def encode_cursor(sort: SortMode, key: Key) -> str:
    raw = json.dumps({"s": sort, "k": list(key)}, separators=(",", ":")).encode()
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def decode_cursor(cursor: str, sort: SortMode) -> Key:
    try:
        padded = cursor + "=" * (-len(cursor) % 4)
        data: Any = json.loads(base64.urlsafe_b64decode(padded.encode()))
        key = data["k"]
        if data["s"] != sort or not isinstance(key, list) or not key or len(key) > 8:
            raise ValueError("shape")
        if not all(isinstance(part, int) and not isinstance(part, bool) for part in key):
            raise ValueError("members")
    except (ValueError, KeyError, TypeError) as error:
        raise InvalidCursor("invalid cursor") from error
    expected = len(rank_key(sort, job_id=0, fit_score=None, posted_at=None))
    if len(key) != expected:
        raise InvalidCursor("invalid cursor")
    return tuple(key)


# --------------------------------------------------------------------------- #
# Ordering and paging
# --------------------------------------------------------------------------- #
def card_key(sort: SortMode, card: dict) -> Key:
    match = card.get("match") or {}
    return rank_key(sort, job_id=card["id"], fit_score=match.get("fit_score"), posted_at=card.get("posted_at"))


def rank_cards(cards: list[dict], sort: SortMode) -> list[tuple[Key, dict]]:
    keyed = [(card_key(sort, card), card) for card in cards]
    keyed.sort(key=lambda pair: pair[0])
    return keyed


def page_of(
    ranked: list[tuple[Key, dict]],
    sort: SortMode,
    *,
    limit: int | None,
    cursor: str | None,
) -> tuple[list[dict], dict]:
    """One page of an already ranked list, plus the paging block returned to the client.

    ``limit=None`` returns everything after the cursor (the legacy "whole list" behaviour). The page is selected by KEY,
    not by position, so jobs that appear or disappear between requests shift neither the page boundary nor the order.
    """
    after = decode_cursor(cursor, sort) if cursor else None
    # `ranked` is sorted by key, so the first job strictly after the cursor is found by binary search, not by scanning.
    start = 0 if after is None else bisect_right(ranked, after, key=lambda pair: pair[0])
    remaining = ranked[start:]
    chosen = remaining if limit is None else remaining[:limit]
    has_more = limit is not None and len(remaining) > limit
    next_cursor = encode_cursor(sort, chosen[-1][0]) if has_more and chosen else None
    return [card for _, card in chosen], {
        "sort": sort,
        "total": len(ranked),
        "limit": limit,
        "returned": len(chosen),
        "has_more": has_more,
        "next_cursor": next_cursor,
    }

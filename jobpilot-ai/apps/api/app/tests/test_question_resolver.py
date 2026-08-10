"""Deterministic employer-wording resolution.

The bias under test is refusal: wording that is not unambiguously recognised
must reach the user, not the nearest canonical key.
"""

from __future__ import annotations

import pytest

from app.applications.question_registry import (
    REGISTRY,
    REGISTRY_VERSION,
    AnswerType,
    Sensitivity,
    normalize_question,
    question_hash,
)
from app.applications.question_resolver import (
    combine_sponsorship,
    map_boolean_option,
    map_job_source_option,
    resolve_question,
    resolve_question_descriptor,
)


# --------------------------------------------------------------------------- #
# The observed TikTok wording
# --------------------------------------------------------------------------- #
def test_tiktok_work_authorization_wording_resolves() -> None:
    result = resolve_question("Are you legally authorized to work in the US without restriction?")
    assert result.canonical_key == "work_authorization_us"
    assert result.sensitivity == Sensitivity.legal
    assert result.method in {"exact_alias", "pattern"}


def test_tiktok_combined_sponsorship_wording_resolves() -> None:
    result = resolve_question(
        "Will you now or in the future require visa sponsorship or a visa transfer?"
    )
    assert result.canonical_key == "sponsorship_required_now_or_future"
    assert REGISTRY[result.canonical_key].composed_of == (
        "sponsorship_required_now",
        "sponsorship_required_future",
    )


@pytest.mark.parametrize(
    "wording,expected",
    [
        (
            "Can you legally work in the United States without restrictions?",
            "work_authorization_us",
        ),
        (
            "Do you currently or will you in the future need employer sponsorship?",
            "sponsorship_required_now_or_future",
        ),
        (
            "Will you require sponsorship or a visa transfer in the future?",
            "sponsorship_required_future",
        ),
        ("Do you currently require employer sponsorship?", "sponsorship_required_now"),
    ],
)
def test_equivalent_timeframe_wording_resolves_deterministically(wording, expected) -> None:
    result = resolve_question(wording)
    assert result.canonical_key == expected
    assert result.method in {"exact_alias", "pattern"}


def test_broader_us_authorization_resolves_as_one_way_implication() -> None:
    result = resolve_question("Are you authorized to work in the United States?")
    assert result.canonical_key == "work_authorization_us"
    assert result.method == "deterministic_implication"


def test_descriptor_uses_accessible_name_when_visible_label_is_absent() -> None:
    result = resolve_question_descriptor(
        question="Choose an option",
        accessible_name="Will you now or in the future require visa sponsorship?",
        field_name="answer-17",
    )
    assert result.canonical_key == "sponsorship_required_now_or_future"
    assert result.method.endswith(":accessible_name")


def test_conflicting_descriptor_keys_are_never_filled() -> None:
    result = resolve_question_descriptor(
        question="Are you legally authorized to work in the US without restriction?",
        accessible_name="Will you require sponsorship in the future?",
    )
    assert result.canonical_key is None
    assert result.reason_code == "canonical_resolution_conflict"
    assert result.requires_user_action is True


def test_where_did_you_hear_resolves() -> None:
    assert (
        resolve_question("Where did you hear about this opportunity?").canonical_key
        == "source_where_heard_about_job"
    )


@pytest.mark.parametrize(
    "wording",
    [
        "Are you legally authorized to work in the US without restriction? *",
        "  ARE YOU LEGALLY AUTHORIZED TO WORK IN THE US WITHOUT RESTRICTION  ",
        "1. Are you legally authorized to work in the United States without restriction?",
    ],
)
def test_formatting_noise_does_not_defeat_matching(wording: str) -> None:
    assert resolve_question(wording).canonical_key == "work_authorization_us"


# --------------------------------------------------------------------------- #
# Refusals
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize(
    "wording",
    [
        "Are you currently authorized to work?",
        "Are you permanently authorized to work in the US?",
        "Are you authorized for this employer?",
    ],
)
def test_authorization_without_the_qualifier_is_ambiguous(wording: str) -> None:
    """"Authorized to work" and "authorized WITHOUT RESTRICTION" are different
    legal questions — someone on OPT can be the first but not the second."""
    result = resolve_question(wording)
    assert result.canonical_key is None
    assert result.reason_code == "authorization_wording_ambiguous"
    assert result.requires_user_action is True


@pytest.mark.parametrize(
    "wording",
    [
        "I agree to the privacy policy",
        "I consent to the processing of my personal data",
        "Please review the terms and conditions",
        "I certify that the information provided is accurate",
    ],
)
def test_consent_and_attestations_are_refused(wording: str) -> None:
    result = resolve_question(wording)
    assert result.canonical_key is None
    assert result.sensitivity == Sensitivity.consent
    assert result.requires_user_action is True


def test_unknown_wording_is_left_for_the_classifier() -> None:
    result = resolve_question("What is your favourite programming paradigm?")
    assert result.canonical_key is None
    assert result.reason_code == "no_deterministic_match"
    # Not flagged as needing user action — a model may still recognise it.
    assert result.requires_user_action is False


def test_an_empty_question_resolves_to_nothing() -> None:
    assert resolve_question("").reason_code == "empty_question"


# --------------------------------------------------------------------------- #
# Option mapping
# --------------------------------------------------------------------------- #
def test_plain_yes_and_no_map_exactly() -> None:
    spec = REGISTRY["work_authorization_us"]
    assert map_boolean_option(True, ["Yes", "No"], spec) == ("Yes", "exact_option")
    assert map_boolean_option(False, ["Yes", "No"], spec) == ("No", "exact_option")


@pytest.mark.parametrize(
    "options",
    [
        ["Yes, with restrictions", "No"],
        ["Yes, but may require sponsorship later", "No"],
        ["Yes, temporarily authorized", "No"],
    ],
)
def test_qualified_options_are_never_collapsed_into_yes(options: list[str]) -> None:
    spec = REGISTRY["work_authorization_us"]
    label, reason = map_boolean_option(True, options, spec)
    assert label is None
    assert reason == "qualified_option_requires_review"


def test_a_missing_option_is_not_approximated() -> None:
    spec = REGISTRY["work_authorization_us"]
    assert map_boolean_option(True, ["Prefer not to say", "Decline"], spec)[0] is None


def test_never_selects_the_first_option_as_a_fallback() -> None:
    spec = REGISTRY["work_authorization_us"]
    label, _ = map_boolean_option(True, ["Something else", "Another thing"], spec)
    assert label is None


# --------------------------------------------------------------------------- #
# Job source
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize(
    "category,options,expected",
    [
        ("linkedin", ["LinkedIn", "Indeed", "Other"], "LinkedIn"),
        ("linkedin", ["Online job board", "Other"], "Online job board"),
        ("referral", ["Employee referral", "Other"], "Employee referral"),
        ("company_site", ["Company website", "Other"], "Company website"),
        ("simplifyjobs", ["Online job board", "Other"], "Online job board"),
    ],
)
def test_job_source_maps_from_verified_metadata(category, options, expected) -> None:
    assert map_job_source_option(category, options)[0] == expected


def test_job_source_never_blindly_selects_other() -> None:
    label, reason = map_job_source_option("linkedin", ["Other", "Careers fair"])
    assert label is None
    assert reason == "option_not_found"


def test_unknown_job_source_is_unresolved() -> None:
    assert map_job_source_option(None, ["LinkedIn", "Other"])[0] is None


# --------------------------------------------------------------------------- #
# Combined sponsorship
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize(
    "now,future,expected",
    [(False, False, False), (True, False, True), (False, True, True), (True, True, True)],
)
def test_combined_sponsorship_truth_table(now, future, expected) -> None:
    assert combine_sponsorship(now, future) == (expected, "combined")


@pytest.mark.parametrize("now,future", [(None, False), (False, None), (None, None)])
def test_a_missing_component_cannot_be_inferred(now, future) -> None:
    value, reason = combine_sponsorship(now, future)
    assert value is None
    assert reason == "missing_component"


# --------------------------------------------------------------------------- #
# Registry integrity
# --------------------------------------------------------------------------- #
def test_every_legal_question_requires_explicit_confirmation() -> None:
    for spec in REGISTRY.values():
        if spec.sensitivity == Sensitivity.legal:
            assert spec.requires_explicit_confirmation is True, spec.key
            assert set(spec.allowed_sources) <= {
                "explicit_profile",
                "user_confirmed_application",
                "user_confirmed_saved",
                "verified_answer_vault",
            }, spec.key


def test_consequential_questions_are_not_auto_filled() -> None:
    assert REGISTRY["salary_expectation"].autofill_allowed is False


def test_the_registry_stores_no_answers() -> None:
    for spec in REGISTRY.values():
        assert not hasattr(spec, "value")
        assert not hasattr(spec, "answer")


def test_registry_keys_are_self_consistent() -> None:
    for key, spec in REGISTRY.items():
        assert spec.key == key
        assert spec.version == REGISTRY_VERSION
        assert isinstance(spec.answer_type, AnswerType)


def test_normalization_preserves_meaning_changing_words() -> None:
    # "without" and "not" must survive; dropping them inverts the question.
    assert "without" in normalize_question("authorized to work without restriction")
    assert "not" in normalize_question("I do not require sponsorship")


def test_question_hash_is_stable_and_option_sensitive() -> None:
    a = question_hash("Are you authorized?", options=("Yes", "No"))
    b = question_hash("  are you authorized?  ", options=("No", "Yes"))
    assert a == b
    assert a != question_hash("Are you authorized?", options=("Yes", "No", "Maybe"))

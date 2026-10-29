# XA-EXT-NAV-02 answer-drafting feature gate

## Architecture
`APPLICATION_ANSWER_DRAFTING_ENABLED` (`app/core/config.py`, default `false`) gates
`POST /application-sessions/{id}/draft-answers`. Only a literal `True` enables it; a
configured `OPENAI_API_KEY` is irrelevant to the gate.

- Route (`app/routes/applications.py`): after session authentication, before the rate limit,
  job lookup, provider call and audit log, a disabled gate returns 503
  `{"code": "answer_drafting_disabled"}`.
- Service (`question_drafting_service.draft_answers`): raises `DraftingDisabledError` first,
  so direct callers cannot reach the provider.

## Decisions
- Separate flag; `PEOPLE_OUTREACH_DRAFTING_ENABLED` is not reused.
- Authentication runs first, so `session_access` still slides a live session's idle
  deadline on a disabled request (existing behaviour, deliberately unchanged). No draft,
  answer or audit data is written.
- No migration, ORM model or Celery change.

## Validation
`app/tests/test_answer_drafting_gate.py` and `app/tests/test_question_drafting.py`
(provider mocked; no network). Other AI features are unaffected by source inspection of the diff.

## Rollout
Ship dark. Enable by setting `APPLICATION_ANSWER_DRAFTING_ENABLED=true` in the API
environment and restarting the API container only.

## Rollback
Unset the variable (or set `false`) and restart; or redeploy the previous image.

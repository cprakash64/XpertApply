# People data providers

`PeopleDiscoveryProvider` exposes `search_people`, `enrich_people`, and `get_usage`.
`WorkEmailProvider` exposes `find_work_email` and `verify_work_email`. Business logic depends only
on these protocols.

- People Data Labs: **primary** employee discovery. Order is set by
  `PEOPLE_PROVIDER_ORDER` (default `["pdl","apollo"]`) and `PEOPLE_PRIMARY_PROVIDER`.
- Apollo: secondary discovery/enrichment, used on a genuine empty result or an
  allowed retryable failure from PDL.
- Hunter: on-demand work-email finding and deliverability verification only.
  Never a discovery source.
- Mock: synthetic injected fixtures for tests/local development; empty by default.

Providers disagree about how they represent the same profile URL: PDL sends
`linkedin.com/in/<slug>` with no scheme and a bare `linkedin_username`, Apollo
sends legacy `http://` URLs. Adapters must canonicalize through
`app.people.security.canonical_profile_url` **before** validating with
`safe_profile_url`. Passing a raw provider value straight to the validator
silently drops every record from that provider — see
`docs/people-discovery-audit.md`.

Accounts and plans may omit fields or deny endpoints. Missing data is normal and lowers confidence;
it is never synthesized. Calls have bounded timeouts, no redirects, a response-size ceiling,
sanitized failure codes, and tightly bounded enrichment. Provider payloads and keys are never
logged or returned. Only normalized evidence, field provenance, stable provider identity, and an
empty redacted diagnostic object are retained.

No adapter scrapes LinkedIn. Public LinkedIn URLs supplied by a licensed provider are allowlisted
to HTTPS `linkedin.com/in/...` links and are never fetched server-side. Confirm that the applicable
provider agreement allows storage, display, and job-level reuse before enabling production.

# XA-14 — Extension-private fill state

## Finding

XA-14 confirmed a low-severity privacy boundary defect: fill ownership, review status, repeater ownership, and original scalar values were stored in `data-jobpilot-*` attributes on employer-page elements. Employer JavaScript could synchronously read those attributes or observe their mutations. No credential, token, resume, or complete profile payload was exposed, but an original field value could be copied into page-readable DOM.

## Architecture and decision

Fill ownership and status now live in `WeakMap<HTMLElement, ...>` state, original scalar values and dropdown selections live in separate weak maps, and repeater ownership lives in a `WeakSet`. The objects are scoped to the content-script document session, are never persisted or sent over the network, and do not retain detached controls.

The widget ledger remains authoritative for user-facing status counts and navigation. Clear enumerates the current deep DOM and consults private ownership state, preserving the first pre-fill snapshot across repeated forced fills. Highlighting alone does not claim ownership, so Clear cannot erase a value merely because a field needs review.

## Progress

- Removed production writes and reads of the legacy ownership, status, original-value, and repeater attributes.
- Migrated autofill verification, repeater filtering, and Clear to private state.
- Removed the widget's page-attribute status fallback.
- Added unit and production-MV3 assertions that employer-page scripts cannot observe private marker mutations and that Clear still restores pre-existing values and choice controls.
- Updated manual evidence collection to treat any legacy private marker as a failure.

## Validation

Validation covers focused unit tests, the complete extension unit suite, TypeScript checking, the production extension build, focused production-MV3 scenarios, and one clean complete E2E run with deterministic local fixtures. A negative-control test deliberately writes the old attribute and proves the observer catches the regression before removing it.

## XA-17 joint status presentation

Field status now renders as icon-and-text badges inside one closed-shadow decoration layer. Employer controls are positioning anchors only: no XpertApply attribute, class, ARIA metadata, CSS variable, expando, or style is written to them. Static `role="note"` semantics avoid creating one live region per field and leave XA-16's broader live-region work separate.

One shared MutationObserver, ResizeObserver, resize listener, and capture-phase scroll listener coalesce positioning through requestAnimationFrame. Records hold targets through WeakRef, remove detached targets, and create no polling loop. The layer uses system colors under forced-colors, retains text/icon meaning without color, and is noninteractive through `pointer-events:none`. Clear removes decorations while preserving employer outline, border, box-shadow, background, and classes exactly.

## Residual observability

The employer page can still observe the stable `#jobpilot-assisted-apply` widget host and one anonymous decoration host. Closed shadow roots prevent page scripts from reading their internal status content. The anonymous host has no ID, class, data/ARIA attributes, inline style, light-DOM children, or per-target geometry, so it exposes no field relationship or status. The branded widget ID remains a generic presence fingerprint because reinjection cleanup and self-exclusion currently depend on it; it reveals no per-field state during the deliberately initiated workflow.

Private state intentionally does not survive a full page reload. Clear after reload was not supported by the prior attribute design once the employer DOM was replaced, and XA-14 does not introduce persistence. Same-document navigation and dynamic form updates remain supported while controls remain reachable.

## Rollout and rollback

Roll out with the extension release after the full checkpoint matrix passes. Monitor Clear failures through existing aggregate diagnostics only; do not add field values or provider payloads to logs. Rollback is a revert of the XA-14 commit if an adapter regression is found. Do not restore DOM attributes as a fallback; repair the private-state reader or adapter instead.

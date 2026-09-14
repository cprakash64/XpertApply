# Stage 2F — Form Interaction Hardening and B-03 Consequential Answer Safety

**Branch** `recovery/stage3-security`
**Base HEAD** `0a7c8d715abdea869dc01b36e4acdc1896ad8dce`
**Status** implemented, validated, not committed

---

## 1. What this stage is

Stage 2F has one security objective and one product objective.

The security objective is **B-03**: a provider recommendation must not be able to
authorize a consequential employer answer merely because it is confident, names
an option that exists, and names it exactly. That is now closed, and the way it
is closed is described in §5.

The product objective is that ordinary application filling behaves like a person
using a browser — focus, native setters, real events, real clicks, waiting for
the UI to settle, and then **reading back what the employer's control actually
holds**. Most of that already existed. Stage 2F closed the gaps and pinned the
behaviour with regression tests rather than rebuilding it.

Everything here is extension-side. No API change, no Web change.

---

## 2. Interaction architecture

There is **one** field interaction stack, in two paths that share the same
verification discipline. Stage 2F added no third path.

```
DISCOVER    fields/discovery.ts, dom/deepDom.ts
            gated by fields/controlBudget.ts  (>1,000 controls → refuse, XA-09)

AUTHORIZE   security/siteAccess.ts, security/senderTrust.ts, frames/*   (XA-01/06/13)
            fields/answerAuthority.decideFill                  ← profile path
            content/bootstrap.resolvedAnswerAllowed            ← resolver path
            fields/consequentialAnswer.checkConsequentialOption ← resolver path, NEW

INTERPRET   fields/mapping.ts            → canonical key + confidence
            content/questionBatch.ts     → opaque field_ref / option_ref
            backend resolver             → selected_option_ref, typed_answer

INTERACT    fields/fill.ts               text, textarea, contenteditable, checkbox
            fields/dropdown/*            select / combobox / listbox / radio
                                         (profile + widget path)
            content/dropdownTransaction  selectApprovedOption (resolver path)

VERIFY      adapter.verify() — reads real DOM selection state
            dropdownTransaction: displayed value + hidden backing input +
                                 validity, after settling

LEDGER      content/questionLedger.ts, fields/ledger.ts
```

The rule the whole stack is built around, unchanged and reinforced:

> **A click attempt is never success.** Nothing is recorded filled until the
> employer's control has been read back and agrees.

### Why two paths, and why that is not two stacks

`fields/dropdown/*` drives a control from an answer XpertApply already holds
(profile, vault, or the user's own choice in the review widget).
`content/dropdownTransaction.ts` drives a control from an option reference the
backend resolver approved. They differ in *where the answer comes from*, not in
how a control is operated or how a result is proven. Stage 2F made them share
their option-label polarity reading (§5.3) so they cannot drift apart.

---

## 3. Stale-element policy

Modern ATS forms re-render constantly, and a DOM node held across an `await` is
not evidence about anything.

Before any mutation, on the resolver path:

1. **Re-discover.** `applyResolvedAnswer` re-runs `discoverQuestionFields` and
   matches on `uid` + `frameId`. A control that is gone is `control_not_found`.
2. **Re-check the option set.** `resolutionIsStale` compares the option set the
   answer was computed against with what the control offers now. Any difference
   refuses; the answer is not re-applied against a set the backend never saw.
   A closed combobox reporting no options is its resting state, not a change —
   it is re-verified in the menu instead.
3. **Re-acquire after opening.** A React re-render during open replaces the
   trigger, so `fillCustomSelect` re-acquires before reading the option
   container and again before verifying. Final verification never trusts the
   pre-open node.
4. **Re-acquire by descriptor, only when unique.** A replaced node gets a new
   WeakMap uid; it is matched by stable descriptor (frame, normalized label,
   control type, name) and **only** when exactly one candidate matches.
   Ambiguity is `control_not_found`, which is the safe answer.
5. **Connected-ness is required, not assumed.** Detached nodes are refused, and
   `verifyUpload` no longer accepts a detached file input's `files` list as
   proof of an upload (§8).

Staleness has **two** axes, and the DOM checks above only cover one. A result
can be current with respect to the page and stale with respect to the USER, who
answered the question themselves while the request was in flight. That is
handled separately, by value authorship — see §9.

Generation fencing across async boundaries is the `ResolutionRunCoordinator`:
a late response from a superseded run is discarded wholesale
(`STALE_RUN_IGNORED`), so an out-of-order provider result can never repaint a
field the current run already settled.

---

## 4. Bounded retries and waiting

Retries are bounded and enumerated. There is no loop that can run forever.

| Path | Policy |
|---|---|
| `fields/dropdown` fill | **2 passes**: pointer, then reopen + keyboard. No third. |
| Multi-select | One reopen + re-collect per value, inside the same 2 passes. |
| Custom menu open | A fixed ladder of strategies, each with its own timeout; `OPEN_ATTEMPT_TIMEOUT_MS` 420 ms, `MENU_TIMEOUT_MS` 2500 ms. |
| Commit settle | `SETTLE_MS` 120 ms → one `requestAnimationFrame` → `SETTLE_MS` again. |
| Upload verification | 8 polls × 150 ms = 1.2 s ceiling, then decide. |
| Search queries | At most 3, most-specific first, never shorter than 3 characters. |
| Keyboard walk | At most 40 `ArrowDown` steps, and `Enter` only when the exact expected option is already active. |

Waiting is event-driven or `requestAnimationFrame`-driven where possible, and
otherwise a bounded `setTimeout`. **Stage 2F adds no `setInterval`, no new
polling loop, and no permanent `MutationObserver`.** The existing navigation
observer keeps its 5-minute self-disconnect.

**S-02 boundary.** Stage 2F did not touch the 1.5-second employer-auth polling
and creates no opportunity to remove it — that loop is in the auth-wait path,
not the field-interaction path. S-02 remains open and separate.

**S-03 boundary.** Field filling continues to use the exact current workflow/tab
authority. No active-tab fallback was broadened.

---

## 5. B-03 — the consequential answer boundary

### 5.1 The hole, precisely

```
canonical    future sponsorship = false
offered      option-1 "Yes", option-2 "No"
provider     selected_option_ref = option-1, typed_answer = false, confidence 1.0
```

Every pre-existing gate passed:

- `matchResults` — the reference belongs to this field's own offered set ✓
- `resolutionIsStale` — the option set has not changed ✓
- `resolvedAnswerAllowed` — the QUESTION's jurisdiction and polarity are fine ✓
  (it is the ANSWER that is inverted, and nothing was reading the answer)
- `matchOption` — took the **exact label match** ahead of the boolean polarity
  fallback, so "Yes" was chosen
- `committedValueMatches` — returned `true` on `shown === wanted` **before it
  ever consulted `typedAnswer`**

Result: "Yes" clicked, verified, and recorded in the ledger as
`filled_verified`. Reproduced through the real built MV3 extension: the
employer's control read **"Yes"**.

### 5.2 The boundary

`fields/consequentialAnswer.ts` (new). For a key in the existing
`CONSEQUENTIAL_KEYS` taxonomy — no key was added — the provider recommendation
is **advisory**, and must survive five checks **before any DOM interaction**:

| # | Check | Refusal |
|---|---|---|
| 1 | `safe_source` is one the **user asserted** (`saved_profile`, `application_override`, the explicit confirmations). A derived reading of a résumé or posting carries no authority to state a fact about someone. | `CONSEQUENTIAL_SOURCE_NOT_USER_ASSERTED` |
| 2 | The option is offered by **this field** in the **current generation**. | `CONSEQUENTIAL_OPTION_NOT_OFFERED` |
| 3 | The offered set names it **unambiguously** — two options normalizing alike fail closed, never pick-the-first. | `CONSEQUENTIAL_OPTION_AMBIGUOUS` |
| 4 | Where the canonical answer is an explicit boolean, the option's **own wording carries the matching polarity**. Wording with no readable polarity ("Authorized without sponsorship") is refused, not approximated. | `CONSEQUENTIAL_OPTION_POLARITY_UNKNOWN` / `CONSEQUENTIAL_OPTION_CONTRADICTS_ANSWER` |
| 5 | Where the extension **independently holds** a verified canonical boolean for the same key, the provider's typed answer must agree with it. | `CONSEQUENTIAL_ANSWER_CONTRADICTS_PROFILE` |

**Confidence is not a parameter of this function.** It cannot be: a provider's
opinion of its own output is not a reason to state a fact on someone's behalf.

Check 5 is the one that does not depend on the provider being wrong in a
self-inconsistent way. An adversary returning `typed_answer: true` *and*
pointing at "Yes" is internally consistent and still refused, because the user's
own verified answer says otherwise.

A refusal costs **zero employer-visible mutation**: it runs before the control
is opened, so nothing is clicked and the field is surfaced for review.

### 5.3 Defence in depth at the actuator

The gate is not the only place the rule is applied, because the menu is read
fresh at actuation time:

- `matchOption` — an exactly-matching label whose own wording says the opposite
  of the canonical boolean is now **disqualified**, yielding the new
  `option_contradicts_answer` failure rather than a click.
- `committedValueMatches` — the polarity check now runs **before** the
  `shown === wanted` early return, so a control displaying the contradicting
  option can never verify.
- Both read an option label through **one** polarity engine:
  `consequentialAnswer.optionPolarity`, re-exported by `dropdownTransaction` as
  `booleanPolarity`. Two engines that drifted apart would let a label the gate
  refuses be accepted by verification.

### 5.4 What is deliberately *not* changed

- Non-consequential fields pass straight through. The existing membership,
  uniqueness and post-commit verification rules continue to govern them, and
  low-risk convenience matching is not broken.
- Non-boolean consequential answers (demographics) carry no polarity to compare;
  they remain governed by `answerAuthority.checkDemographicOptions`
  (exactly-one-option-means-the-same, or refuse) and by post-commit verification.
- XA-02, XA-03, XA-04 are untouched and still run. Stage 2F adds a check on the
  **answer**; those check the **question**.

---

## 6. Option identity and generations

- Options crossing the wire are **opaque positional references**
  (`f_<frame>_<uid>_o<index>`), never selectors and never element ids. The
  provider cannot manufacture a DOM address.
- A reference is resolved back to a label through **that question's own**
  `labelByRef`. A reference from another field resolves to nothing.
- An unknown reference yields `approvedLabel = null`, which is an unresolved
  field — never a fuzzy fallback to a "closest" option.
- The generation the answer was computed against is compared with the live one
  (`resolutionIsStale`), and the approved label must still be present in the
  reopened menu or the transaction fails.
- Duplicate normalized labels fail closed at the gate
  (`CONSEQUENTIAL_OPTION_AMBIGUOUS`) and at the actuator (`ambiguous_option`).

---

## 7. Native and framework-controlled controls

| Control | Behaviour |
|---|---|
| text / email / tel / url | focus → **prototype** value setter → `input`, `change`, `blur` → read back; `validationMessage` or `aria-invalid` ⇒ review. |
| `type=search` | Deliberately **not** an application field — a site's own search box. |
| textarea | Same, through `HTMLTextAreaElement.prototype`. |
| React/Vue controlled | The **prototype** setter is called in preference to an instance-level setter the framework installed, so the framework's own listener observes the change. Pinned by a test that fails if the instance setter is used. |
| Masked / formatted | Verified through the caller's `verify(finalValue)`. The ledger records the **final** value the control holds, never the intended one. |
| checkbox | `if (el.checked !== desired) el.click()` — **idempotent**; a correct checkbox is never toggled off by a re-run. |
| radio | Group resolved semantically by name; selection is by **meaning, not position**; native activation preserves exclusivity. |
| native select | Deterministic option match, prototype setter, `input`/`change`, then the committed option is read back. No first-option fallback, no substring match, placeholders are never answers. |
| date | Handled as a text-like control against the employer's own format; an unestablished format is left for review. No locale guessing. |
| file | See §8. |
| disabled / readonly / hidden | Never mutated through property hacks; surfaced as unresolved. |
| password / OTP / CAPTCHA / CSRF | Excluded from discovery. |

Events are dispatched with `composed: true` so a web component's shadow-root
listener sees them. Event **counts** are deliberately not asserted anywhere —
they vary by framework, and the invariant that matters is that the value is
accepted and survives a re-render.

---

## 8. Uploads

- The exact historical `GeneratedDocument` bytes are attached via a synthetic
  `DataTransfer`, then `input`/`change` are dispatched.
- Verification is of the **control**, never of the download: the input holds
  exactly one file with the expected name, **and/or** the component renders the
  filename. Bounded at 8 × 150 ms.
- **Stage 2F change:** the last-resort "the file is on the input" branch now
  additionally requires `input.isConnected`. A framework that replaces the file
  input leaves the old node detached with its `files` list intact, so reading it
  back proves nothing about what the form now holds — and claiming
  `upload_verified` there is a false success on the one field the user cannot
  check from the ledger.
- A replaced input with no visible filename is honestly **unverifiable**, and is
  reported as review rather than as an upload.

---

## 9. User state preservation

- A control already holding a **non-empty** value is skipped
  (`user value present`), whether the user typed it or the employer pre-filled
  it. Overwriting requires an explicit `force`, which only the user's own action
  in the review widget sets.
- The same rule applies to dropdowns through `adapter.readSelection`, where a
  placeholder ("Select…") correctly reads as blank.
- **A pending resolver result cannot overwrite a manual choice.** This needed a
  fix found during the checkpoint review, and the earlier claim that
  re-discovery plus generation fencing already covered it was wrong. Neither
  does: a response computed before the user acted is stale with respect to
  **them**, not to the DOM, so the node is still there and the option set is
  unchanged. Verified by probe — the user picked "Yes" by hand, the resolver's
  later "No" replaced it, and the ledger recorded it verified.

  `selectApprovedOption` now refuses to replace a value XpertApply did not
  write. Authorship is tracked in an extension-private `WeakMap` keyed by the
  control (XA-14 — nothing is written to the employer's DOM), so:

  | control currently shows | outcome |
  |---|---|
  | blank or a placeholder | filled |
  | what XpertApply last wrote there | updated — a targeted re-resolution still works |
  | the approved value already | verified, untouched (idempotent) |
  | anything else | `user_value_present`, **not overwritten** |

  The one exception is `allowOverwrite`, set only by the review widget's
  "apply this answer" action — where replacing the value is exactly what the
  user asked for. An automatic run never sets it.

  A preserved user answer is recorded as `requires_confirmation`, not as a
  technical failure: there is nothing to retry, and their answer stands.

  **"Blank" has one definition.** The guard uses the project's existing
  `isBlankValue`, not a second test written beside it. The first draft of this
  guard did invent one, and it matched a bare "None" — which is a real answer to
  "years of management experience" and to "prior convictions", and would have
  been silently overwritten. `isBlankValue` matches "none selected" and "no
  selection" and never "None". The same function now also guards
  `committedValueMatches`: a placeholder is never an answer, including one that
  happens to contain an option's wording — "No selection" contains the token
  "no", and an untouched control was reading as having committed "No".

**Clear (XA-10)** restores the **first** snapshot, so repeated forced fills still
return to the user's original state — and a non-empty original is restored as
itself, never emptied. Re-verified after Stage 2F for text, textarea, select,
radio, checkbox and custom dropdown. File inputs are the documented exception:
the browser does not permit programmatic restoration of a user's original file
selection, and Stage 2F does not claim it does.

---

## 10. Multi-step forms and XA-07

The intermediate/final distinction is explicit and is an **exact, ordered
allow-list**, not a heuristic:

- Intermediate (may be actuated): `autofill with resume`, `create account`,
  `save and continue`, `next`, `continue`, `apply`.
- Final (never actuated): everything else, including `submit`,
  `submit application`, `finish`, `finish application`, and `review`.
- `isReviewPage` suppresses navigation entirely once the review step is reached
  — the step immediately before the employer's submission is exactly where an
  automatic advance must not happen.
- `findSubmitControl` exists **only** for observation (`reachedFinalStep`, and
  Stage 2D's submission-gesture observer). It is never clicked.

After an intermediate navigation, the new step undergoes fresh discovery,
authority checks and ledger mapping. No element reference survives a step.

**Invariant, asserted in both suites:** extension-triggered final-submit clicks
= 0, `form.submit()` = 0, `requestSubmit()` = 0.

---

## 11. Performance bounds

`MAX_DROPDOWN_OPTIONS = 2_000` (new, in `fields/controlBudget.ts`, alongside the
existing `MAX_APPLICATION_CONTROLS = 1_000`).

The largest legitimate list an application renders is a country picker at ~250
entries. 2,000 clears that by nearly an order of magnitude while bounding a
hostile page.

Applied where the cost actually is:

1. `rawOptionNodes` bounds the raw node list (to ceiling **+ 1**, so overflow
   stays detectable) **before** any visibility read.
2. `isOptionShaped` rejects on the raw count first, then counts visible options
   only as far as the ceiling it compares against — the 61st already settles it.
3. `collectOptionLists` has a **breadth guard**: a container with more children
   than the ceiling is not a menu, decided from `children.length`, which costs
   no layout. This was the dominant cost — menu attribution recursed into every
   child of a hostile list calling `isVisible` on each, once per open poll.

Measured on a 7,000-option hostile menu, JSDOM, same fixture:

| | options processed | elapsed |
|---|---|---|
| before | 7,000 | ~1,250 ms |
| after | 2,000 | ~520-560 ms |

And with the menu pre-mounted — the worst case for attribution, where every
open poll re-walks the list — 22.2 s → 8.3 s → ~0.5 s across the three fixes.

Timings are indicative, not a contract: they are JSDOM on one machine and will
vary. What is asserted in the suite is the property, not the number — exactly
`MAX_DROPDOWN_OPTIONS` options are read out of the 7,000 rendered, and runtime
no longer scales through the malicious set.

**What is and is not bounded, precisely.** The bound is on every *per-option*
step: visibility reads, disabled checks, label extraction, matching. The initial
`querySelectorAll` still matches the full set before the slice — that is a
native selector walk with no layout, it is not the cost being defended against,
and replacing it with an early-exit tree walk would be slower and would lose
the shadow-DOM piercing real ATS widgets need.

The documented trade-off: an option past the ceiling is a bounded **miss**
(`option_not_found`), never an approximation to some other option.

Otherwise unchanged: no repeated deep DOM scans while idle, bounded discovery
during a fill, XA-09's >1,000-control refusal before any per-field work.

---

## 12. Result model, ledger and status

The existing taxonomy already carries the needed nuance and was **not**
redesigned:

`filled_verified` · `requires_confirmation` · `interaction_failed` ·
`answer_missing` · `answer_stale` · `unsupported` · `manual`

New failure codes, all fail-closed:

- `consequential_answer_refused` — the B-03 gate refused, before any mutation.
- `option_contradicts_answer` — the actuator found the approved option and it
  said the opposite of the canonical answer.
- `user_value_present` — the control already held a value XpertApply did not
  write. Surfaced as `requires_confirmation`, never as a fill and never as a
  technical failure.

Each is mapped explicitly in `stableTransactionFailure` rather than being left
to its fallback. The fallback is `CONTROL_VALUE_VERIFICATION_FAILED`, which
would have reported a gate that worked correctly as a control that misbehaved —
and sent whoever read the diagnostics looking for a DOM problem that does not
exist. `semantics_incompatible` was falling through the same way and is now
mapped too.

The ledger records **verified committed state only**. A refusal, a verification
failure, a backing/display mismatch and a validation failure all leave the field
uncounted as filled.

User-facing wording stays plain — "Review this answer" — and never exposes
provider or resolver terminology. Status presentation goes through the existing
ASYNC-01-clean lifecycle; Stage 2F adds no new delayed status work.

**Logging:** structured result categories, codes and counts only. No résumé
text, no cover-letter text, no answer values, no demographic answers, no tokens,
no cookies, no raw employer DOM. The attempted value is recorded as
`[redacted]`.

---

## 13. Accessibility

No ARIA is removed, no `tabindex` is changed, no destructive styling is
injected, and focus is taken only transiently as part of a legitimate field
interaction. Status presentation remains non-colour-only (XA-17).

---

## 14. Files changed

| Path | Class |
|---|---|
| `apps/extension/src/fields/consequentialAnswer.ts` | **new** — B-03 boundary |
| `apps/extension/src/content/dropdownTransaction.ts` | B-03 actuator + option bounds |
| `apps/extension/src/content/bootstrap.ts` | B-03 gate wired into the apply path |
| `apps/extension/src/fields/controlBudget.ts` | `MAX_DROPDOWN_OPTIONS` |
| `apps/extension/src/fields/dropdown/dom.ts` | option bound |
| `apps/extension/src/content/autofill.ts` | upload verification requires a connected input |
| `apps/extension/src/ats/tiktokApplication.ts` | assisted action opts in to `allowOverwrite` |
| `apps/extension/src/__tests__/b03_consequential_answer.test.ts` | **new** — the gate and the actuator, 32 tests |
| `apps/extension/src/__tests__/stage2f_form_interaction.test.ts` | **new** — 39 tests |
| `apps/extension/src/__tests__/b03_adversarial_matrix.test.ts` | **new** — the A–H matrix in one place, 25 tests |
| `apps/extension/src/__tests__/stage2f_upload_provenance.test.ts` | **new** — 3 tests |
| `apps/extension/e2e/stage2f-b03.spec.ts` | **new** — 9 MV3 tests |
| `docs/plans/xpertapply-stage-2f-form-interaction-hardening.md` | this document |

Manifest unchanged: no new required host permission, no wildcard employer
permission, no broader content-script injection, no new
`externally_connectable` origin.

---

## 15. Negative controls

A regression test is only worth anything if it fails against the code it was
written for. Both were run by neutralising the fix and re-running:

| Case | Pre-fix result |
|---|---|
| Unit — `selectApprovedOption("Yes", typedAnswer: false)` | `ok: true`, control committed **"Yes"** |
| Unit — `committedValueMatches("Yes", "Yes", false)` | `true` |
| **MV3, real built extension** — provider names "Yes" at confidence 1.0 for `sponsorship_required_future = false` | employer's control read **"Yes"** |
| Unit — user picks "Yes" by hand, resolver's "No" arrives after | user's answer **overwritten**, reported `verified` |
| **MV3, real built extension** — same race, 3 s resolver delay | user's "Yes" **replaced** with "No" |
| Unit — framework replaces the file input after upload | `documents_uploaded: ["resume"]` — a false success |
| Perf — 7,000-option hostile menu | 7,000 options walked |

---

## 16. Rollback

Stage 2F is additive and self-contained. To roll back:

1. Delete `apps/extension/src/fields/consequentialAnswer.ts`, the two new unit
   test files, and `apps/extension/e2e/stage2f-b03.spec.ts`.
2. Revert `content/bootstrap.ts` — remove the `checkConsequentialOption` import
   and the gate block in `applyResolvedAnswer`, and drop `safeSource` from the
   answer payload.
3. Revert `content/dropdownTransaction.ts` — restore the local `booleanPolarity`
   definition, the exact-match-first `matchOption`, the `shown === wanted` early
   return, and the unbounded `optionNodes` / `collectOptionLists`.
4. Revert `fields/controlBudget.ts` and `fields/dropdown/dom.ts`.
5. Revert the `isConnected` condition in `autofill.verifyUpload`.
6. Revert the value-authorship guard — remove `committedByXpertApply`,
   `mayReplaceCurrentValue`, `holdsNoAnswer`, the `allowOverwrite` option and
   the `user_value_present` code from `dropdownTransaction.ts`; drop the
   `allowOverwrite` argument in `ats/tiktokApplication.ts`; restore the plain
   `interaction_failed` mapping in `bootstrap.applyResolvedAnswer`.

**Rolling back step 6 restores the defect where an automatic resolution
overwrites an answer the user gave while the request was in flight.**

**B-03 returns to OPEN on rollback.**

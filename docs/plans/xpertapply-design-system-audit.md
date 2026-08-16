# XpertApply authenticated-product design-system audit

Status: Stage 2 foundation complete; release checkpoint verified
Date: 2026-08-16
Audited release: `2c814c955870d7133e13472fef26c8e4b0d528ed` on `main`

## 1. Purpose and decision

This document defines how the logged-in XpertApply product should adopt the visual identity already shipped by the marketing site without changing product behavior, information density, accessibility, responsive navigation, authentication, profile persistence, application flows, or extension workflows.

The current product is not a collection of arbitrary hard-coded pages. It has a useful semantic CSS-variable layer, deliberate light/dark themes, accessible global focus behavior, one icon library, and several good local primitive families. Its visual fragmentation is instead a combination of:

- an obsolete pine-green brand mapped into legacy Tailwind aliases;
- brand, selection, active, progress, and success meanings sharing green treatments;
- shared primitives that cover only part of the application;
- page-local variants for cards, buttons, fields, dialogs, badges, loading, and empty states;
- inconsistent page headings, control radii/heights, card padding, and elevation.

The migration must therefore be token-first, then primitive-first, then page-by-page. A search-and-replace from green to cyan would corrupt status semantics and fail accessibility.

## 2. Repository and evidence baseline

At the start of the audit:

- branch: `main`
- `HEAD`: `2c814c955870d7133e13472fef26c8e4b0d528ed`
- `origin/main`: `2c814c955870d7133e13472fef26c8e4b0d528ed`
- ahead/behind: `0/0`
- worktree: clean
- modified/untracked/staged files: none

Evidence used:

- direct source inspection of marketing and authenticated routes, components, CSS, and Tailwind configuration;
- repository-wide searches for CSS variables, raw colors, semantic/legacy utilities, radii, shadows, icons, loading states, and duplicated primitives;
- read-only production rendering at 1280×720 for the marketing homepage, Dashboard, Jobs, Applications, Profile, and Settings;
- WCAG contrast-ratio calculations from observed color values.

The browser viewport override advertised by the environment did not change the effective 1280×720 viewport, including on a new tab. Phone behavior was therefore audited from the shipped `<640px` source rules and existing responsive component structure, not claimed as a fresh phone visual capture. No screenshots were stored.

## 3. Marketing source of truth

| Concern | Current source |
| --- | --- |
| Route/composition | `apps/web/app/page.tsx` |
| Route-scoped visual system | `apps/web/app/marketing.css` under `.xa-*` selectors and `.xa-theme` |
| Global accessibility/defaults | `apps/web/app/globals.css` |
| Theme aliases | `apps/web/tailwind.config.ts` |
| Navbar | `apps/web/components/marketing/MarketingNavbar.tsx` |
| Hero/demo | `Hero.tsx`, `ProductDemo.tsx` |
| Product story | `ProductStory.tsx`, `workflowStages.ts` |
| Extension section | `ExtensionShowcase.tsx` |
| Trust/navy break | `TrustSection.tsx` |
| CTA/footer/pricing | `FinalCta.tsx`, `MarketingFooter.tsx`, `PricingDialog.tsx` |
| Wordmark | `BrandWordmark.tsx` plus `apps/web/public/brand/xpertapply-logo.png` |
| Icons | `lucide-react` |

`marketing.css` contains a late “Supplied finished-design parity” override block. The cascade-final values in that block are the shipped source of truth; earlier declarations must not be copied blindly.

The marketing site does not download a distinct web font. It uses `Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif`; Inter appears only where locally available. The product inherits the Tailwind/system sans stack, so there is no justified font dependency change.

## 4. Marketing palette

### 4.1 Observed values

| Observed value | Current role | Assessment |
| --- | --- | --- |
| `#06245c` | primary/dark navy, primary button, navy section, wordmark “Xpert” | canonical brand primary |
| `#0b3577` | navy hover/secondary navy | canonical brand-primary hover |
| `#14b8c4` | cyan brand accent, wordmark “Apply”, decorative accents | canonical brand accent; not valid white-text fill |
| `#63d7dc` | cyan highlight/soft accent | raw accent highlight, not a text color |
| `#0e7c85` | darker cyan foreground in one marketing treatment | useful contrast-safe accent foreground; consolidation candidate |
| `#08182f` | darkest ink | canonical primary text on light surfaces |
| `#344054` | navigation/body emphasis | secondary text candidate |
| `#475467` | body text | canonical secondary text |
| `#667085` | muted text/navigation inactive | canonical muted text |
| `#ffffff` | cards/surfaces/inverse text | canonical surface/card and inverse text |
| `#f8fafc` | final page/sunken surface | canonical cool page/subtle surface |
| `#edf0f4` | soft line | subtle divider candidate |
| `#e5e9f0` | default line | default border candidate |
| `#d9e1eb` | strong line | strong/selected neutral border candidate |
| `#d7deea` | ghost-button border | consolidate toward border hierarchy where visually equivalent |
| `#087a4f`, `#0b8152` | genuine success foreground variants | preserve as semantic green; consolidate to one foreground |
| `#e9faf4`, `#e7faf6`, `#eafaf5` | genuine success tints | consolidate to one success-soft token |
| `#edf5ff`, `#bdd8f5` | informational/selection blue tint and border | candidates for semantic info, not core brand duplication |

Additional decoration uses translucent navy/cyan gradients and glows. These are marketing composition values, not general-purpose product-card tokens.

### 4.2 Recommended canonical consolidation

- Brand: `#06245c`, hover `#0b3577`, accent `#14b8c4`, accent highlight `#63d7dc`, contrast-safe accent foreground `#0e7c85`.
- Light text: `#08182f`, `#475467`, `#667085`.
- Light surfaces: `#f8fafc`, `#ffffff`.
- Light borders: `#edf0f4`, `#e5e9f0`, `#d9e1eb`.
- Success: use one deliberate green family, not cyan and not the old pine brand alias.
- Warning/danger: retain the product's existing semantic families until a separately contrast-tested canonical family is approved; marketing does not provide complete warning/danger scales.

The marketing implementation has no explicit canonical “cyan hover fill.” `#0e7c85` is source-derived and contrast-safe as accent text/focus, but its use as an accent-filled hover must be visually reviewed in Stage 2 rather than inferred.

## 5. Marketing typography, spacing, shape, depth, and motion

### Typography

- Display hero at 1280px rendered approximately `89.6px/84.2px`, weight `730`, tracking `-5.56px`; this is marketing-only.
- Navigation renders about `14.5px`, weight `650`.
- Final buttons render `14px`, weight `760`.
- Wordmark renders about `17px`, weight `820`, tracking `-0.02em`.
- Product typography should share family, color, confident weights, and tight-but-readable heading tracking—not hero scale.

### Spacing

The implementation repeatedly uses a 4px-derived rhythm: 8, 10/12, 16, 20, 24, 32, 40, 48, then larger section values. The marketing shell is `1220px` with gutters `clamp(1.25rem, …, 2.5rem)` and large section spacing. Rendered section padding at 1280px ranged from roughly 68 to 118px vertically. Product UI should retain the 4px rhythm while using its current denser 16–24px panel padding.

### Shape

- Primary/ghost buttons: final `10px` radius, `42px` minimum height.
- Navigation glass container: about `18px` radius.
- Marketing cards/panels: generally `16–22px`.
- Badges/pills: `999px`.
- Borders: predominantly 1px and low contrast.

The product already clusters around 8, 12, and 16px. Canonicalizing those values is more faithful than imposing one radius everywhere.

### Depth

- Small: `0 1px 2px rgb(7 26 51 / 4%)`.
- Primary button: `0 10px 22px rgb(6 36 92 / 17%)`.
- Major floating/hero panels: approximately `0 26–28px 80–90px rgb(13 35 67 / 12%)`.
- Navbar: translucent gradient, 22px backdrop blur, layered shadow.

Product direction: borders remain the default separator; small shadow is reserved for interactive/elevated cards; the large shadows and glows are limited to dialogs, overlays, and rare feature moments.

### Motion

- Hover transitions: mostly 160–180ms; buttons lift by 1px.
- Story progress: 80ms linear and 320–420ms eased state changes.
- Dialog: 180ms fade and 220–240ms eased entry.
- Ambient marketing animation: up to 12s.
- Reduced motion is honored globally and within marketing-specific effects.

Product defaults should be 120–180ms color/border/opacity changes, optional 1px lift only for clearly interactive cards/buttons, 200–240ms dialog entry, and no ambient animation in high-frequency work areas. Loading spinners remain functional motion and must respect reduced-motion behavior.

## 6. Current authenticated-product palette

### Light theme (`apps/web/app/globals.css`)

- surfaces: page `#fbfbf8`, surface `#ffffff`, muted `#f6f7f2`, skeleton `#e7eae3`;
- text: `#17211b`, `#33403a`, `#5d675f`;
- borders: `#d8ddd2`, strong `#b6bfb4`;
- old brand/action: pine `#1f5e45`, hover `#174935`, white foreground;
- focus: `#2f6f9f`;
- success: `#1f6b4a` / `#eef8f1` / `#b9d7c3`;
- warning: `#7a5d12` / `#fff9e8` / `#ead191`;
- danger: `#9f3d28` / `#fff3ef` / `#f0b4a4`.

### Dark theme

The app intentionally follows `prefers-color-scheme`; it is not dark-only and has no JavaScript theme toggle. Dark surfaces are `#14171a`, `#1b1f22`, `#23282c`, and `#21262a`; text is `#eef1ed`, `#c3cbc5`, and `#98a29b`. The old brand/action becomes `#4c9e7a`; semantic success/warning/danger each have distinct foreground, tint, and border values.

Stage 2 must preserve theme awareness. The marketing site supplies only a fixed light brand treatment, so dark brand aliases must be derived and contrast-tested in a small token preview before replacement. Existing dark semantic colors are a safe interim baseline.

### Quantified scope

Across authenticated TSX/CSS (excluding marketing), observed utility usage included:

- `border-line`: 186
- `bg-white`: 86
- `text-pine`: 73
- `bg-panel`: 66
- `text-ink`: 20
- `bg-pine`: 20
- `border-pine`: 8
- semantic variable use: `--text-muted` 252, `--text-secondary` 92, danger family 75+, success family 57+, warning family 37+.

Legacy word occurrences were approximately `pine` 104, `green` 4, and `teal` 1. Product raw colors are limited: `global-error.tsx` intentionally duplicates fallbacks because it cannot depend on app CSS; `layout.tsx` duplicates theme colors for metadata; `AutoApplyModal.tsx` has one hard-coded pine shadow; `CompanyLogo.tsx` has a deliberate fixed avatar palette and white logo surface. The dominant issue is semantic/primitive fragmentation, not widespread random hex values.

## 7. Brand versus semantic classification

| Existing green use | Current examples | Future meaning |
| --- | --- | --- |
| Old brand/action | primary buttons, links, icon accents, progress | navy primary action or contrast-safe cyan accent according to hierarchy |
| Active navigation | active AppShell item and brand icon tint | selected surface + navy/cyan marker; not success green |
| Selected state | workplace chips, preference tags, selected job row/tab | selected border/surface/accent tokens; not success green |
| Promotional/next action | Dashboard `NextActionCard` | brand/subtle accent surface; not success surface |
| Genuine success | offer, verified, saved confirmation, completed preparation step, mark applied | semantic green remains |
| Positive fit | fit score “Strong fit” | semantic score scale remains; it conveys probability, not brand |

The following must not be mechanically recolored: success alerts, offer/verified states, “Mark applied,” completed workflow steps, and strong-fit score bands.

## 8. Product structure and visual comparison

| Dimension | Marketing | Product | Gap and direction |
| --- | --- | --- | --- |
| Color | navy/cyan/cool neutral, fixed light | pine/warm neutral, OS light/dark | replace brand aliases; preserve semantic colors and dark capability |
| Typography | confident display, tighter tracking, heavier controls | system sans; page h1 varies 28/30/36px | one product type scale; no marketing hero sizes |
| Spacing | large section rhythm | useful 16–24px density | preserve density; normalize repeated panel/control spacing |
| Radius | 10px controls, 16–22px panels | controls 6/8/12px; panels mostly 16px with Settings at 8px | canonical 8/12/16 hierarchy |
| Border | cool subtle hierarchy | warm semantic lines | move values to cool palette, keep border-first separation |
| Shadow | premium, selective, large hero depth | Dashboard/Profile mostly none; Tracker `shadow-sm`; dialogs glassy | one small/elevated/modal scale; no universal card shadow |
| Motion | expressive ambient/story motion | functional 120–220ms transitions | retain restrained product motion and global reduced motion |
| Icons | Lucide | Lucide plus intentional brand SVGs | already aligned; standardize sizes/stroke usage |
| Buttons | 42px, 10px, navy/ghost | 36/40/44px and 6/8/12px, many local builds | canonical variants, sizes, and polymorphic link support |
| Inputs | marketing dialog-specific | mostly 40px, radii 8/12px, hand-built across pages | shared Field/Input/Select/Textarea visual layer |
| Navigation | glass/navy identity | stable responsive shell with green selection | visual token migration only; behavior frozen |
| Cards | large narrative panels | dense functional panels | standard/interative/elevated/subtle variants; density stays product-specific |

Production render confirmed these differences. At 1280×720, Dashboard used a 36px heading, 44px/12px action, 16px no-shadow cards; Jobs used a 28px heading, 40px controls with 6/8px radii; Applications and Profile used 30px headings; Applications alone broadly applied `shadow-sm`; Settings mixed 16px and 8px card radii.

## 9. Product primitive inventory

### Existing shared foundations

- `components/Button.tsx`: primary, secondary, danger; keep and extend.
- `components/SectionError.tsx`: reusable load/action error; keep.
- `components/profile/primitives.tsx`: Card, ClickableCard, SectionHeading, EditLink, ProgressMeter, MetaRow, MoreCount; keep semantics, migrate visual layer.
- `components/profile/editors/primitives.tsx`: RecordCard, menu, ConfirmDialog, SaveBar, Field, SelectField, TextArea, BulletList, TagField/List, checkbox Toggle, FieldGroup, EmptyRecords; strongest existing form system and the basis for shared fields.
- `components/profile/editors/EditorShell.tsx`: reusable editor loading/error orchestration; behavior unchanged.
- `components/jobs/badges.tsx`: job metadata, salary, fit badge/pill; keep domain semantics.
- `lib/fitScore.ts`: deliberate emerald/lime/orange/red score scale with dark variants; keep.

### Genuine duplication

- Buttons/links: Dashboard, Jobs, Job Detail, Tracker, Profile wizard, Settings, Auth, and modals hand-build common actions.
- Fields: profile editors have primitives; Auth, Jobs filters, Tracker, Settings, demographics, and wizard repeat input/select markup.
- Cards: Dashboard, Tracker, Jobs, Profile, Settings, and People use page-local shells with different elevation/padding.
- Dialogs: `UnsavedChangesDialog`, profile `ConfirmDialog`, `MarkAppliedDialog`, `AutoApplyModal`, `AuthDialog`, and marketing `PricingDialog` repeat overlay/chrome/focus decisions.
- Badges/chips: selectable preferences, job metadata, tracker status, fit score, People category, and tags look similar but have different semantics.
- Loading: local skeletons and spinners in Dashboard, Jobs, Job Detail, profile editors, AutoApply, and route states.
- Empty/error: Dashboard `EmptyLine`, Tracker empty card, profile `EmptyHint`/`EmptyRecords`, job states, and People states.
- Headers/tabs: page headings and job-detail tabs are page-local.

There is no evidence for adding a large component library. Consolidate the existing React/Tailwind/CSS-variable approach.

## 10. Form, button, card, badge, and state audit

### Forms

Most authenticated controls are 40px high, but radii vary between 6, 8, and 12px. Profile editor primitives provide labels, helpers, server validation, required/error associations, disabled styling, and save states; these behaviors are authoritative and must not be replaced. The component named `Toggle` is visually/semantically a checkbox, not a switch. Radio and true switch patterns are not established enough to fabricate now.

Canonical direction: Field wrapper + Input/Textarea/Select/Checkbox primitives, with optional start/end adornments. Keep native controls and existing validation plumbing. Add Radio or Switch only when an actual product use requires it.

### Buttons

Canonical set should stay small:

- `primary`: navy fill, inverse text;
- `secondary`: surface fill, default border;
- `ghost`: transparent/subtle hover;
- `danger`: semantic danger fill or outlined confirmation treatment;
- `link`: text action where surrounding hierarchy supplies target size;
- `icon`: square accessible action.

Sizes: compact 36px only for dense filters/tables; default 40px; prominent 44px. All icon-only controls need accessible labels. Avoid a separate variant for every page.

### Cards/panels

- `standard`: surface/card, 1px border, 16px radius, no default shadow.
- `interactive`: standard plus hover border/small elevation and focus ring.
- `elevated`: raised surface plus small product shadow; dialogs use modal shadow.
- `subtle`: subtle surface and optional border for grouped supporting content.

Standard padding should be 20–24px desktop, 16–20px tablet, and 16px phone, with compact list rows remaining denser. This is a usage guideline, not a new breakpoint architecture.

### Badges/chips/status

- `Chip`: selectable, uses selected tokens and `aria-pressed`/checkbox semantics.
- `Tag`: informational metadata, neutral surface/border.
- `StatusBadge`: semantic tone with text label; color never carries meaning alone.
- `FitBadge/FitPill`: domain-specific score scale; do not collapse into generic success.

Proposed tracker mapping: Saved neutral; Applied/Applying warning or info according to product language; Interview info; Offer success; Rejected danger. The exact “Applied” tone should be product-reviewed rather than assumed from the current warning treatment.

### Loading/empty/error

- Skeleton: one neutral token-backed primitive with text/block/circle shapes and reduced-motion handling.
- Spinner: one Lucide `Loader2` wrapper with size/tone rules; never cyan merely because it moves.
- EmptyState: optional icon, concise heading, explanation, one primary/secondary action, compact and full variants.
- Alert: info/success/warning/danger with foreground/tint/border/icon; validation remains field-level.
- Toast: no coherent shared toast system was found; do not add one until a real cross-product need is defined.

## 11. Navigation, icons, lists, and responsive density

The AppShell behavior is complete and must remain unchanged:

- desktop sidebar at `>=1280px`;
- compact rail and user-expanded overlay at `640–1279px`;
- mobile header/drawer below `640px`;
- short-height independent sidebar scroll and current keyboard/drawer behavior.

Future visual-only migration:

1. Replace brand icon/wordmark colors via brand tokens.
2. Change active-item success tint/pine foreground to selected-surface, selected-border/marker, and brand foreground.
3. Retain 44px minimum navigation targets, tooltips, focus, collapse state, and all breakpoints.
4. Use cyan as a small active marker/focus detail; do not make the entire sidebar neon.
5. Keep Logout danger-neutral until invoked; Settings stays a normal navigation item.

Icons are overwhelmingly Lucide with custom SVGs limited to real brand marks in `profile/BrandIcons.tsx`. Continue Lucide at 16px inline, 20px standard action/nav, 24px feature/empty state, generally the library default 2px stroke. Do not replace verified vendor marks or deterministic logo/avatar colors with brand cyan.

Dense lists should retain row dividers, compact metadata, inline actions, and responsive collapse. Selected rows use selected tokens; hover uses subtle surface; status remains a separate badge. Do not convert Tracker or Jobs lists into marketing-sized story cards.

## 12. Proposed token architecture

CSS custom properties remain the single value source. Tailwind should alias semantic variables, as it does today. TypeScript constants should contain domain mappings (for example status-to-tone keys), never duplicate color values.

### 12.1 Raw palette tokens

Raw values are used only inside the theme definition:

| Token | Value | Provenance |
| --- | --- | --- |
| `--raw-navy-900` | `#06245c` | source-derived |
| `--raw-navy-800` | `#0b3577` | source-derived |
| `--raw-cyan-500` | `#14b8c4` | source-derived |
| `--raw-cyan-300` | `#63d7dc` | source-derived |
| `--raw-cyan-700` | `#0e7c85` | source-derived; consolidation candidate |
| `--raw-neutral-950` | `#08182f` | source-derived |
| `--raw-neutral-700` | `#475467` | source-derived |
| `--raw-neutral-600` | `#667085` | source-derived |
| `--raw-neutral-100` | `#edf0f4` | source-derived |
| `--raw-neutral-200` | `#e5e9f0` | source-derived name/order to normalize in implementation |
| `--raw-neutral-300` | `#d9e1eb` | source-derived name/order to normalize in implementation |
| `--raw-white` | `#ffffff` | source-derived |
| `--raw-success-700` | `#087a4f` | source-derived marketing success |

Numeric raw names must be ordered by luminance during Stage 2; the table preserves observed values but does not require awkward numbering. Do not expose raw tokens to components.

### 12.2 Light semantic tokens

| Category | Proposed token | Value | Provenance/use |
| --- | --- | --- | --- |
| brand | `--color-brand-primary` | `#06245c` | source-derived |
| brand | `--color-brand-primary-hover` | `#0b3577` | source-derived |
| brand | `--color-brand-accent` | `#14b8c4` | source-derived; non-text accent |
| brand | `--color-brand-accent-foreground` | `#0e7c85` | recommended consolidation, contrast-safe on white |
| brand | `--color-brand-accent-soft` | `rgb(20 184 196 / 10%)` | new semantic alias from source accent |
| surface | `--color-surface-page` | `#f8fafc` | source-derived |
| surface | `--color-surface-shell` | `#ffffff` | source-derived |
| surface | `--color-surface-card` | `#ffffff` | source-derived |
| surface | `--color-surface-raised` | `#ffffff` | alias; elevation supplies hierarchy |
| surface | `--color-surface-subtle` | `#f8fafc` | source-derived alias |
| surface | `--color-surface-selected` | `rgb(20 184 196 / 10%)` | new semantic alias |
| text | `--color-text-primary` | `#08182f` | source-derived |
| text | `--color-text-secondary` | `#475467` | source-derived |
| text | `--color-text-muted` | `#667085` | source-derived |
| text | `--color-text-inverse` | `#ffffff` | source-derived |
| border | `--color-border-subtle` | `#edf0f4` | source-derived |
| border | `--color-border-default` | `#e5e9f0` | source-derived |
| border | `--color-border-strong` | `#d9e1eb` | source-derived |
| action | `--color-action-primary` | `#06245c` | alias |
| action | `--color-action-primary-hover` | `#0b3577` | alias |
| action | `--color-action-link` | `#0e7c85` | contrast-safe alias |
| focus | `--color-focus-ring` | `#0e7c85` | recommended consolidation; 4.73:1 on page |

Keep semantic `success`, `warning`, `danger`, `info`, their soft surfaces/borders, disabled background/text, overlay, vendor LinkedIn/email, and input-background tokens. Stage 2 should preserve the current contrast-tested status families initially, then add an explicit info family from a reviewed blue set. Do not invent an unsupported full marketing status palette.

### 12.3 Dark semantic tokens

Retain the current dark surfaces/text/borders/status values initially. Define separate dark brand semantic values only after a Stage 2 token specimen checks hover, selected, focus, disabled, and contrast. Source facts already show:

- marketing cyan `#14b8c4` has 6.86:1 contrast on current dark card `#1b1f22`;
- current dark accent `#4c9e7a` has 5.12:1 on the same surface;
- navy is not suitable as text/fill against dark surfaces without a lighter paired foreground/surface treatment.

### 12.4 Non-color tokens

- Radius: `--radius-control: 8px`, `--radius-field: 12px`, `--radius-card: 16px`, `--radius-panel: 20px`, `--radius-pill: 999px`. The first three consolidate existing/marketing values; panel 20px is used only where large composition warrants it.
- Spacing: retain Tailwind's 4px scale; standardize component recipes around 8/12/16/20/24/32 rather than adding raw component literals.
- Shadow: `--shadow-xs` from marketing 1px shadow; `--shadow-action` from the navy CTA; `--shadow-card` a restrained existing product shadow; `--shadow-dialog` the current glass/modal elevation. Exact card/dialog consolidation should be previewed in Stage 2.
- Type: system/Inter fallback stack; product heading scale proposed as 30/36 page title, 24/32 section feature, 20/28 card/section title, 16/24 body emphasis, 14/20 body/control, 12/16 label. Dashboard's 36px welcome may remain an intentional display exception.
- Motion: fast 120ms, standard 160–180ms, dialog 220–240ms, productive easing `cubic-bezier(.2,.78,.2,1)` where transform is used.

## 13. Contrast and accessibility findings

Calculated ratios:

| Combination | Ratio | Decision |
| --- | ---: | --- |
| navy `#06245c` / white | 14.84:1 | excellent button/text combination |
| navy / page `#f8fafc` | 14.19:1 | excellent primary text/brand |
| navy hover `#0b3577` / white | 11.73:1 | excellent |
| ink `#08182f` / white | 17.77:1 | excellent primary text |
| body `#475467` / white | 7.69:1 | AA/AAA body |
| muted `#667085` / white | 4.97:1 | AA normal text; monitor at very small sizes |
| cyan `#14b8c4` / white | 2.42:1 | fail for normal text and UI boundary; do not use cyan fill with white text or thin cyan focus on white |
| cyan / ink `#08182f` | 7.35:1 | valid dark text on cyan fill |
| dark cyan `#0e7c85` / white | 4.95:1 | AA normal text |
| dark cyan / page | 4.73:1 | acceptable focus/link foreground |
| default line `#e5e9f0` / white | 1.22:1 | decorative separation only; not enough for control boundaries alone |
| success `#087a4f` / white | 5.37:1 | AA normal text |
| current danger `#9f3d28` / white | 6.62:1 | AA |
| current warning `#7a5d12` / white | 6.17:1 | AA |
| cyan / dark card `#1b1f22` | 6.86:1 | strong dark-theme accent |
| cyan / navy | 6.14:1 | strong brand-detail combination |

Global focus currently supplies a consistent 3px ring with 2px offset for links, buttons, inputs, selects, textareas, and `[tabindex]`; preserve its broad selector coverage. Stage 2 may change the token, not remove the behavior. `#14b8c4` alone is not a safe light-theme focus ring; use `#0e7c85` or a two-layer treatment.

Navigation has 44px targets. Default forms/buttons are mainly 40px; prominent actions reach 44px, while 36px is limited to dense contexts. Icon actions under 40px require sufficient surrounding hit area and accessible labels. Semantic states include text/icon labels, so meaning is not color-only. Disabled text requires a measured pair in the Stage 2 specimen before adopting marketing muted colors on disabled surfaces.

## 14. Cyan and navy usage rules

### Cyan

Use cyan for the “Apply” wordmark, small brand details, progress/accent indicators, selected markers/outlines, and focus/link treatments only through a contrast-safe semantic alias. A cyan-filled button must use dark ink, not white. Cyan must not become every heading, icon, card border, success badge, or full-page surface.

### Navy

Use navy for primary actions on light surfaces, the “Xpert” wordmark, strong light-theme hierarchy, and occasional dark brand panels. Primary product text may use the navy-adjacent ink rather than brand navy everywhere. Do not apply dark navy as text/action on current dark surfaces; use theme-specific semantic values.

## 15. Component migration matrix

| Component | Current implementation(s) | Problem / future primitive | Priority | Risk / affected areas |
| --- | --- | --- | --- | --- |
| Button | shared `Button` plus many local buttons/links | extend to primary/secondary/ghost/danger/link/icon and size recipes | P0 | medium; every area, auth submit behavior |
| Input | editor primitives plus local Auth/Jobs/Tracker/Settings/Wizard | shared visual Input with adornments; no validation rewrite | P0 | high; auth/profile data entry |
| Textarea | profile editor and document forms | shared visual primitive | P0 | high; profile/document editing |
| Select | profile editor and local filters | shared native Select | P0 | medium; filtering/profile forms |
| Checkbox | native + editor `Toggle` | canonical Checkbox, preserve native behavior | P1 | medium; preferences/privacy |
| Radio | sparse/native | add only for real use, not speculatively | P2 | low |
| Toggle/Switch | `Toggle` is actually checkbox | clarify name; create Switch only if semantics require | P2 | medium; avoid ARIA regression |
| Card | profile primitives plus page-local shells | standard/interactive/elevated/subtle recipes | P0 | medium; all pages |
| Badge | jobs/tracker/people local | semantic StatusBadge plus domain variants | P1 | medium; status meaning |
| Chip | preference/job selections mixed with tags | separate selectable Chip from Tag | P1 | high; filters/preferences |
| Alert | SectionError plus local banners | info/success/warning/danger shell; keep error plumbing | P1 | high; auth/API/validation |
| Tabs | Job Detail and filter groups local | accessible Tabs visual primitive only after behavior audit | P1 | high; Jobs workflow |
| Dialog | six local implementations | shared overlay/chrome/focus shell, domain bodies remain local | P1 | very high; focus/unsaved/auth/apply |
| Tooltip | AppShell rail CSS tooltip | keep shell behavior; extract visual recipe only if another use emerges | P2 | high in shell |
| Dropdown | profile record menu/local triggers | shared trigger/menu chrome; keep interaction implementation | P2 | medium |
| Skeleton | local spans/cards | shared shape primitive and page compositions | P1 | low |
| EmptyState | Dashboard/Tracker/Profile/Jobs/People local | compact/full EmptyState composition | P1 | low-medium |
| PageHeader | every route local | title/subtitle/actions recipe with size exceptions | P0 | low |
| SectionHeader | Dashboard/Profile/Jobs local | title/description/action recipe | P1 | low |

## 16. Page migration matrix

| Order | Area | Complexity | Dependencies | Risk | Direction |
| ---: | --- | --- | --- | --- | --- |
| 1 | AppShell | medium | tokens, Button/icon treatment | high | visual token swap only; freeze responsive state machine |
| 2 | Dashboard | medium | PageHeader, Card, Button, Badge, Skeleton, EmptyState | medium | establish product expression and preserve 36px welcome exception |
| 3 | Applications/Tracker | medium | Card, controls, StatusBadge, EmptyState | high | preserve status transitions and dense scanning |
| 4 | Jobs discovery/list | high | fields, chips, Card, badges, buttons, loading | very high | selected versus success separation first |
| 5 | Job Detail/apply/documents | very high | Tabs, Dialog, Button, Card, Alert | very high | split from discovery for reviewability |
| 6 | Profile overview | medium | Card, headers, tags | medium | migrate overview before editors |
| 7 | Profile editors/preferences | very high | form primitives, Chip, Alert, Dialog | very high | preserve validation, dirty state, and partial persistence |
| 8 | Settings | medium | forms, Button, Card, destructive dialog | high | normalize mixed radii; protect credentials/deletion |
| 9 | People/referrals | high | Card, Badge, Empty/Error, external actions | high | preserve provider/privacy semantics and vendor colors |
| 10 | Resumes/cover letter/answers | currently low route complexity; generation flows are embedded in Jobs | Dialog, documents, form primitives | high where generated previews apply | migrate actual generation surfaces, not only placeholder routes |

## 17. What must remain unchanged

- Responsive shell breakpoints, state persistence, drawer/rail/desktop behavior, keyboard access, tooltips, and short-height scrolling.
- OS-driven light/dark support and no-hydration-script approach.
- Global visible focus coverage and global reduced-motion fallback.
- Product's compact list/filter density and border-first separation.
- Profile editor validation, field-error association, dirty/save/unsaved flows, and partial persistence.
- Authentication/session behavior and credential semantics.
- Jobs selection, job-detail, apply, mark-applied, polling, document, and external-link behavior.
- Tracker status data and transitions.
- Fit-score emerald/lime/orange/red domain scale and text labels.
- Genuine success/warning/danger meanings.
- Lucide as the primary icon system; verified vendor colors and marks.
- Deterministic company/avatar palette and global-error self-contained fallbacks unless deliberately redesigned with equivalent resilience.

## 18. High-risk boundaries

- `AppShell`: visual class changes can alter responsive layout, focus order, overflow, and persisted collapsed state.
- Auth dialog/login: shared dialog/input migration can break focus restoration, submission, errors, and expired-session recovery.
- Profile editors/wizard: visual wrappers can break labels, server errors, required state, dirty state, and partial updates.
- Jobs/AutoApply/documents: buttons, tabs, dialogs, fixed workspaces, polling, downloads, and mark-applied status are behavior-heavy.
- Settings: password storage and destructive account controls require exact semantic hierarchy.
- People/referrals: external contact actions, provider confidence/status, privacy, and vendor styling must remain domain-specific.
- Extension-related actions: product visual changes must not imply autonomous behavior or change browser-extension contracts.
- Dark theme: light marketing values copied directly can create invisible controls or low-contrast navy actions.

Every migration PR should be narrowly scoped, preserve DOM semantics and handlers, include light/dark and keyboard checks, and have a token-only rollback path where possible.

## 19. Recommended staged rollout

1. **Stage 2 — token foundation and specimen page:** introduce raw/semantic aliases, maintain compatibility aliases (`pine`, `panel`, `line`, etc.), build a non-production-facing specimen or tests, contrast-check light/dark, then extend Button/Card/Field recipes without page migration.
2. **Stage 3 — AppShell visual migration:** brand, active/hover/focus visuals only; rerun the complete responsive shell matrix.
3. **Stage 4 — Dashboard:** PageHeader, Button, Card, badge, skeleton, and empty-state adoption.
4. **Stage 5 — Applications/Tracker:** dense cards, filters, and deliberate status mapping.
5. **Stage 6A — Jobs discovery/list:** fields, chips, selection, job cards, score/meta badges.
6. **Stage 6B — Job Detail/apply/documents:** tabs, action hierarchy, dialogs, alerts, generated previews.
7. **Stage 7 — Profile overview:** cards, headers, metadata, completion/readiness presentation.
8. **Stage 8 — Profile editors/preferences/wizard:** shared form visuals with full persistence/validation regression.
9. **Stage 9 — Settings and People/referrals:** credentials/destructive states and provider-aware contact cards.
10. **Stage 10 — Resumes, cover letter, application answers, remaining surfaces:** include embedded generation flows and route placeholders.
11. **Stage 11 — product-wide visual/accessibility regression:** desktop/tablet/phone; light/dark; keyboard/focus; contrast; reduced motion; loading/empty/error; remove obsolete compatibility aliases only after zero-use verification.

Rollout should use normal reversible commits per stage. Roll back the affected stage commit if behavioral or contrast regressions appear; do not remove compatibility aliases until all callers have migrated.

## 20. Stage 2 acceptance criteria

- Values originate in CSS custom properties and Tailwind aliases consume them; no component-local navy/cyan literals.
- Existing semantic success/warning/danger and vendor colors remain distinct.
- Light and dark specimens cover default, hover, active, selected, focus, disabled, loading, error, and destructive states.
- Cyan/white is not used for normal button text; focus meets non-text contrast expectations.
- Existing legacy aliases remain behaviorally compatible during migration.
- Button/Card/Field work changes only visual composition, not event handlers, validation, or data flow.
- AppShell and page migrations have not started.
- Relevant web tests, production build, keyboard checks, and contrast calculations pass.

## 21. Audit conclusion

XpertApply has a solid behavioral and accessibility base worth preserving. The marketing identity is sufficiently explicit to support a controlled migration: navy is the dependable primary-action and hierarchy color; cyan is an accent requiring careful foreground/focus pairing; cool neutrals can replace the warm product foundation in light mode; and product-specific dark semantic values must be retained or separately derived. The safest next step is the isolated token/primitive foundation described above, not page recoloring.

## 22. Stage 2 implementation record

Status: implemented and locally validated on 2026-08-16; no page adoption, commit, push, or deployment.

### Architecture decision

`apps/web/app/globals.css` is the single runtime value source. It now contains:

1. a small marketing-derived raw palette (`--xa-*`);
2. canonical product semantics (`--color-*`) with light and dark mappings;
3. role-based shape, shadow, and motion values;
4. the pre-existing product tokens unchanged as a temporary compatibility layer.

`apps/web/tailwind.config.ts` maps semantic utility names to those variables and contains no duplicated brand hex values. TypeScript component code contains semantic names only. Domain code may map a state to `success`, `warning`, `danger`, `info`, or `neutral`, but must not contain palette values.

### Final raw palette

| Raw token | Exact value | Provenance |
| --- | --- | --- |
| `--xa-navy` | `#06245c` | marketing source |
| `--xa-navy-hover` | `#0b3577` | marketing source |
| `--xa-cyan` | `#14b8c4` | marketing source |
| `--xa-cyan-highlight` | `#63d7dc` | marketing source |
| `--xa-cyan-dark` | `#0e7c85` | marketing source, consolidated contrast-safe accent text |
| `--xa-ink` | `#08182f` | marketing source |
| `--xa-neutral-secondary` | `#475467` | marketing source |
| `--xa-neutral-muted` | `#667085` | marketing source |
| `--xa-light-page` | `#f8fafc` | marketing source |
| `--xa-light-card` | `#ffffff` | marketing source |
| `--xa-light-border-subtle` | `#edf0f4` | marketing source |
| `--xa-light-border` | `#e5e9f0` | marketing source |
| `--xa-light-border-strong` | `#d9e1eb` | marketing source |

Existing dark colors remain product-derived because marketing is intentionally light-only: page `#14171a`, card/shell `#1b1f22`, raised `#23282c`, subtle `#21262a`, primary text `#eef1ed`, secondary `#c3cbc5`, muted/disabled `#98a29b`, borders `#2b3136`/`#333a3d`/`#4a5357`.

### Final semantic hierarchy

| Role | Light | Dark |
| --- | --- | --- |
| brand primary | navy `#06245c` | cyan `#14b8c4` |
| brand primary hover | navy `#0b3577` | cyan highlight `#63d7dc` |
| brand accent | cyan `#14b8c4` | cyan `#14b8c4` |
| foreground on cyan | ink `#08182f` | ink `#08182f` |
| accent-colored text | dark cyan `#0e7c85` | cyan highlight `#63d7dc` |
| primary action | navy/white | cyan/ink |
| secondary action | white/ink/strong border | raised charcoal/light text/strong border |
| ghost action | secondary text/page hover | secondary text/subtle hover |
| destructive action | `#9f3d28`/white | `#f08a70`/ink |
| page | `#f8fafc` | `#14171a` |
| shell/card | white | `#1b1f22` |
| selected | 10% cyan tint, dark-cyan border/text | 14% cyan tint, cyan border, highlight text |
| link/focus | dark cyan `#0e7c85` | cyan highlight `#63d7dc` |

Status remains independent:

- light success `#1f6b4a` on `#eef8f1`, border `#b9d7c3`;
- light warning `#7a5d12` on `#fff9e8`, border `#ead191`;
- light danger `#9f3d28` on `#fff3ef`, border `#f0b4a4`;
- light info `#2f6f9f` on `#edf5ff`, border `#bdd8f5`;
- dark success `#6cc196` on `#172b22`, border `#2c5c45`;
- dark warning `#e0b95f` on `#2b2415`, border `#5c4a1f`;
- dark danger `#f08a70` on `#2e1a15`, border `#6b3527`;
- dark info `#7db8e8` on a 12% matching tint, 40% matching border.

### Cyan, navy, and legacy-green rules

Canonical cyan is permitted for brand detail, selected/focus accents, dark primary actions with ink text, and decorative highlights. It is forbidden as a normal white-text fill, ordinary body text, generic success, every icon, or every border. Navy is the light-theme primary-action/hierarchy color; it is not used as foreground on charcoal.

No global pine-to-cyan rebind exists. `--accent`, `--accent-hover`, legacy `pine`, and existing success variables retain their exact previous mappings. The legacy `components/Button.tsx` also retains its existing appearance. Stage 3+ migrates call sites to canonical semantics contextually; once the legacy import and aliases reach zero consumers, remove the adapter and compatibility aliases in a dedicated cleanup.

### Canonical primitive APIs

Canonical primitives live under `apps/web/components/ui`:

- `Button`: `variant="primary|secondary|ghost|destructive"`, `size="sm|md|lg|icon"`, optional `loading`; default type is `button`, loading sets disabled and `aria-busy`.
- `Input`, `Textarea`, `Select`: native prop forwarding plus `label`, `hint`, `error`, and `required`; generated IDs associate labels/messages; errors set `aria-invalid` and descriptive text; data/validation behavior stays caller-owned.
- `Card`: `standard|interactive|raised|subtle`; normal cards remain border-first. Card is always a static visual shell: the interactive variant highlights a semantic link/button inside it and its type intentionally rejects direct event handlers, roles, and tab stops on the wrapping `div`.
- `Chip`: a keyboard-native button with `selected` mapped to `aria-pressed`; callers cannot override `aria-pressed` independently.
- `Tag`: non-interactive metadata; its type rejects direct event handlers and fake interactive roles.
- `StatusBadge`: `neutral|info|success|warning|danger`, always paired with visible text; its type likewise remains static.
- `Alert`: `info|success|warning|danger`; danger uses `role="alert"`, other updates use `role="status"`; icons are decorative when visible text supplies meaning.

Every primitive accepts `className` as a normal escape hatch. APIs expose semantics, never raw-color switches.

### Shape, depth, motion, and focus

- radii: control 8px, field 12px, card 16px, panel 20px, pill 999px;
- shadows: subtle, raised, overlay only; standard cards have no shadow;
- durations: fast 120ms, normal 180ms; standard productive easing;
- spacing: the existing Tailwind 4px scale remains authoritative;
- canonical focus: 3px contrast-safe ring with 2px offset; error fields use the error-focus token;
- coarse-pointer Button/Chip targets enforce a 44px minimum through `ds-touch-target`;
- global reduced-motion behavior remains unchanged.

### Automated contrast contracts

`design-system-tokens.test.ts` resolves the actual CSS variable graph and enforces WCAG AA normal-text contrast for primary action, accent foreground, primary/secondary/muted/disabled text, link, success, warning, and danger in both themes. It also enforces 3:1 focus/page contrast and proves white-on-cyan is forbidden while ink-on-cyan passes.

Measured core results:

| Pair | Light | Dark |
| --- | ---: | ---: |
| primary action | 14.84:1 | 7.35:1 |
| accent foreground/cyan | 7.35:1 | 7.35:1 |
| primary text/page | 16.98:1 | 15.80:1 |
| secondary text/page | 7.35:1 | 10.85:1 |
| muted text/page | 4.75:1 | 6.83:1 |
| link/page | 4.73:1 | 10.52:1 |
| disabled text/surface | 5.23:1 | 5.44:1 |
| info/soft | 4.90:1 | 6.24:1 |
| success/soft | 5.93:1 | 6.91:1 |
| warning/soft | 5.87:1 | 8.25:1 |
| danger/soft | 6.09:1 | 6.73:1 |

### Stage 2 validation and scope

A temporary specimen route exercised brand/surface/status colors, all Button states, fields, cards, Chip/Tag/StatusBadge, and Alert. Playwright asserted actual dimensions and keyboard focus at 1440×900, 900×900, 390×844, and 390×667 in light and dark (8 combinations). It also asserted no horizontal overflow. The temporary route/spec and screenshots were removed from the candidate diff after review.

Existing AppShell, Dashboard, Jobs, Applications, Profile, and Settings were checked through the existing responsive authenticated-page suite at desktop and phone sizes. Auth-expiry tests also passed. No existing product call site was migrated and no unexpected global recolor occurred.

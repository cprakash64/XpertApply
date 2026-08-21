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

## 21A. Stage 3 AppShell migration record

Status: implemented for visual review on 2026-08-16; responsive and authentication behavior frozen.

The authenticated shell now consumes the Stage 2 semantic system directly. No new token was required. The page canvas remains on the compatibility `--background` token so unmigrated Dashboard, Jobs, Applications, Profile, and Settings content continues to meet its existing surface assumptions; only navigation-owned chrome moved to canonical shell roles.

| Shell concern | Canonical treatment |
| --- | --- |
| sidebar, mobile header, drawer | `surface-shell` with `line-default` separation |
| default navigation | `foreground-muted`; icons inherit the label tone |
| hover | `surface-subtle` plus `foreground`; quieter than selection |
| active navigation | `surface-selected`, semibold `brand-primary`, and a persistent `border-selected` edge marker |
| keyboard focus | canonical `ds-focus-ring`, visually stronger than hover |
| overlay/backdrop | `surface-overlay`; tablet elevation uses `shadow-overlay` |
| Settings | normal secondary navigation, separated with the utility group |
| Logout | neutral by default; `status-danger-surface`/`status-danger` only on hover |
| collapse/expand and mobile controls | neutral navigation/ghost hierarchy with semantic hover and focus |
| rail tooltip | `surface-raised`, `line-default`, `foreground`, and `shadow-raised` |

Expanded desktop, tablet overlay, mobile header, and mobile drawer use a compact two-part XpertApply wordmark: “Xpert” follows theme-correct primary foreground and “Apply” retains the cyan brand accent. Collapsed desktop and tablet rails show a crop of the existing supplied XpertApply mark; no logo or monogram was generated. The crop is shared across every shell mode.

Legacy shell branding removed from `AppShell.tsx`: the green success-surface/`text-pine` briefcase tile and the green success-surface/`text-pine` active item. The former generic `border-line`, `bg-white`, `text-ink`, `bg-panel`, `focus-ring`, and hard-coded black backdrop combinations were compatibility styling and have been replaced only inside the shell with canonical semantic roles. No genuine success styling outside the shell changed.

Light mode uses a white shell, cool borders, ink/navy hierarchy, a restrained cyan selection tint and marker, and a navy current label. Dark mode keeps the Stage 2 charcoal shell, light neutral hierarchy, a translucent cyan selection tint, and cyan/highlight selection and focus treatments; it does not introduce a saturated navy dark sidebar. Cyan is never used as a white-text control fill.

The active state remains semantic (`aria-current="page"`) and is distinguishable by surface, font weight, and marker in addition to color. Tooltips remain presentational because every rail control retains its accessible name. All existing widths, breakpoints, offsets, overlays, focus trapping/restoration, Escape and backdrop dismissal, inertness, scroll locks, resize cleanup, route mapping, collapse persistence, and session invalidation code remain unchanged.

Runtime scope is limited to `AppShell.tsx` plus its existing global shell recipe. Zero application page files were visually migrated. Remaining work follows the page order in the migration matrix, beginning with Dashboard only after this shell is reviewed. Browser screenshots are temporary review artifacts and are not repository deliverables.

### Stage 3 validation record

Real Chromium rendering was inspected in light and dark at 1440×900, 900×900, 390×844, and 390×667. The review covered desktop expanded/collapsed, tablet rail/expanded overlay, phone header/drawer, and the short phone drawer. Dashboard, Find Jobs, Applications (`/tracker`), Profile, and Settings were also rendered at desktop and phone sizes to verify the staged shell/page boundary without migrating page content. A 1152×720 increased-zoom-equivalent check was attempted in the in-app browser but its reload was blocked by browser URL policy; the existing 900×400 short-tablet check and exact breakpoint tests cover the relevant reachability/layout risk.

Measured shell contrast (foreground/background): light muted navigation, Settings, and default Logout 4.97:1; light active text/icon on selected surface 13.59:1; light tooltip 17.77:1; light focus/shell 4.95:1; light Logout hover 6.09:1. Dark muted navigation, Settings, and default Logout 6.30:1; dark active text/icon on selected surface 5.45:1; dark tooltip 13.07:1; dark focus/shell 9.71:1; dark Logout hover 6.73:1.

### Stage 3 takeover review

An independent review of the above implementation kept it intact apart from one correction, and closed the outstanding verification gap.

Correction: the active-item edge marker was drawn in `--color-brand-accent`. Measured against its own composited selected surface that is 2.21:1 in light mode (2.42:1 against the bare shell), below the 3:1 WCAG 1.4.11 bar for a state indicator. The marker is load-bearing specifically in the collapsed rail, where the hidden label removes the font-weight cue and leaves the marker as the only non-colour indicator of the current page. It now uses `--color-border-selected`, the canonical selected-edge role, which resolves to the darker cyan in light mode and stays cyan in dark: 4.53:1 light and 5.42:1 dark against the selected surface. No other rule, token, or component changed.

Independently re-measured shell contrast from live computed styles: light muted navigation/Settings/Logout 4.97:1, light active text/icon on selected surface 13.57:1, light tooltip 17.77:1, light focus ring against shell 4.95:1, light Logout hover 6.09:1; dark muted navigation/Settings/Logout 6.30:1, dark active text/icon 5.42:1, dark tooltip 13.07:1, dark focus ring 9.71:1, dark Logout hover 6.73:1. Keyboard focus resolves to a 3px `--color-focus-ring` outline at 2px offset in both schemes, measurably stronger than the hover surface shift. The two-part wordmark is `aria-hidden` beside the link's own accessible name and is exempt from text contrast as a logotype.

The increased-density gap was closed as effective-viewport validation, not browser-chrome zoom: a 1152×720 CSS viewport at `deviceScaleFactor` 1.25 reproduces the layout and raster conditions of 125% zoom on a 1440×900 display. In both schemes the shell resolves to the 64px tablet rail with no horizontal overflow, no brand/navigation or navigation/footer overlap, Settings and Logout in the viewport, working rail tooltips, and a 256px overlay whose labels are all visible and unclipped. Short heights were re-checked at 900×400 and 1280×400, and a breakpoint sweep from 320px to 1920px confirmed exactly one usable navigation mode at every width with no horizontal overflow.

The compact mark is a very tight crop: the mark occupies x 545–918, y 204–558 of the 1448×1086 source. The flat leg terminations are the asset's own geometry, not clipping. Corrected after production measurement: `overflow: hidden` clips at the *padding* box, so the visible window is 30px rather than the plate's 32px, and roughly 1.5px of the cyan swoosh's outer tip is cut inside the corner radius. The mark stays complete enough to read correctly at its rendered size and was accepted for release, but it is genuinely (marginally) clipped rather than fully contained as first recorded.

The focused shell/design-system/auth suite passed 64 tests. The complete web suite passed 44 files / 843 tests, ESLint, TypeScript, and production build. The responsive AppShell Playwright suite passed 9/9, including exact breakpoint geometry, persisted collapse, overlays, focus/dismissal, short-height utilities, protected-session invalidation, core-page compatibility, and the semantic light/dark visual contract. The extension gate passed 56 files / 819 tests plus typecheck/build. `docker compose config` passed. The host API gate could not start because the existing virtualenv contains cloud-placeholdered package files; a container fallback collected all 1,787 tests with current source mounted read-only but was stopped after filesystem stalls made it impractical. No backend code changed in Stage 3.

## 21B. Stage 4 Dashboard migration record

Status: implemented for visual review on 2026-08-17; data flow, routes, and fetch/cache semantics frozen.

Runtime scope is a single file, `components/DashboardClient.tsx`. It is imported only by `app/dashboard/page.tsx`, so no other route can be reached by this change. `lib/dashboardSummary.ts` was not touched: the page still renders one `/dashboard/summary` request behind the same module cache, stale time, token binding, and auth-cleanup registration.

### Strategy

The Dashboard is where the product expression is established, so the rule applied throughout was that colour must carry meaning. Navy is the primary action, cyan marks progress and the promoted next action, and green is spent only where the domain genuinely means success.

| Dashboard concern | Migrated treatment |
| --- | --- |
| page canvas | unchanged — owned by the AppShell (see exception below) |
| cards | `surface-card` + `line-default` + `radius-card`, border-first, no shadow |
| page heading | `text-foreground`, 36px display exception retained |
| supporting copy, labels | `foreground-muted` |
| primary action ("Find jobs", next-action CTA) | `action-primary` navy fill with `action-primary-foreground` |
| section links ("Open tracker", "View all") | `foreground-link` dark cyan |
| metric icons | `foreground-muted` — a metric is a number, not a status |
| metric values | `foreground`, tabular numerals |
| pipeline track | `surface-subtle`; unreached stages `line-strong` |
| pipeline current stage | `brand-accent`, except *Offer* which uses `status-success` |
| recent application status | `StatusBadge` with the Tracker's domain tone mapping |
| fit score | `getFitScoreTone` — the real score band |
| promoted next action | `surface-selected` + `line-selected`, brand-primary eyebrow |
| error | `Alert` tone `danger` + secondary `Button` retry |
| empty states | `surface-subtle` + `line-subtle` panel, muted copy, one link |
| focus | canonical `ds-focus-ring` throughout |

### Legacy green removed, semantic green kept

Removed as brand/action/selection: the `bg-pine` "Find jobs" and next-action CTAs, `text-pine` section links and empty-state links, `text-pine` metric icons, the `text-pine` pipeline bar, the `text-pine` due-date line, and the `--success-surface`/`--success-border` next-action card. Per §7 of this document the promoted next action was never a success state; it had merely borrowed the success surface, which made every visit look like an achievement.

Kept or newly made semantic: an *Offer* application status is `status-success`, a *rejected* one is `status-danger`, *interview* is `status-info`, and in-flight states are `status-warning`/neutral — the Dashboard previously flattened all of these to one neutral pill and now matches the Tracker. The pipeline's furthest-reached stage is green only when that stage is Offer. Fit scores now use the existing `lib/fitScore.ts` bands, so a 47% match reads orange instead of the flat success green every score used to wear; `lib/fitScore.ts` itself was not modified, because it is shared with the unmigrated Jobs surfaces.

### Known duplication: application status tones (RESOLVED in Stage 5)

> Superseded by the Stage 5 record below: the shared module this section names as its consolidation target now exists at `lib/applicationStatus.ts`, and both screens consume it. The description below is kept as the record of why the duplication was accepted at the time.

The Dashboard's status→tone map lives in `DashboardClient.tsx` as a local `statusTone()` returning canonical `StatusTone` values. The Tracker's equivalent lives in `TrackerClient.tsx` as a local `StatusBadge` that emits legacy colour classes directly (`--success-*`, `border-sky-300/40`, `--danger-*`, `--warning-*`, `border-line bg-panel`). The two agree on the domain rule — offer is success, interview is info, rejected is danger, applied/applying is warning, everything else neutral — but express it in two different vocabularies.

This duplication is deliberate for Stage 4. There is no shared mapping anywhere in `lib/` to consume, and extracting one now is not a safe visual-migration change: the Tracker emits raw legacy classes rather than tones, so it cannot adopt a `StatusTone` map without also migrating its visual vocabulary, which is precisely the Tracker/Applications stage. `TrackerStatus` is also exported from `TrackerClient.tsx` — a component that pulls in `lib/api` and the Dashboard cache invalidator — so importing it here would couple two page components and drag the Tracker module graph into the Dashboard bundle. The data layer types the Dashboard's `status` as a plain `string`, not `TrackerStatus`, so the signatures differ as well.

**Consolidation target:** during the Tracker/Applications migration, lift the status union and its tone mapping into a shared pure module (`lib/applicationStatus.ts` or similar) and have both screens consume it. Until then, every branch of the Dashboard map is covered by a parameterised test so the two screens cannot drift silently. Note one pre-existing wording difference that consolidation should settle: the Tracker labels an offer "Offer / selected" while the Dashboard labels it "Offer".

### Deliberate exceptions

- **Page canvas.** `--background` is painted by the AppShell for every authenticated route. Repainting it here would recolour Jobs, Tracker, Profile, and Settings at the same time, so the warm canvas stays until a later stage retires it. Dashboard-owned surfaces are canonical; only the canvas behind them is not.
- **Skeleton fill.** Placeholders use `line-subtle` rather than the legacy `--skeleton` token, which is a warm neutral that reads yellow against cool cards. Migrating the token itself would change skeletons on every unmigrated page.
- **Next-action skeleton surface.** The loading card uses the neutral card surface, not the brand tint: placeholder blocks are lighter than the tint and disappear into it, which reads as an empty panel instead of content arriving.
- **Primitive adoption.** `Alert`, `Button`, and `StatusBadge` are used directly. The card contract is applied to the `section`/`aside` elements the page already uses rather than wrapping them in `Card`, which would have cost the landmark and heading structure for no visual gain.

### Responsive and state decisions

Metrics reflow 2×2 on phones instead of four stacked full-width rows, using a 1px grid gap over the border colour so the separators stay correct at both column counts. The main grid is two columns from `xl` and one below. The next-action card is `self-start` so it sizes to its content instead of stretching into a tall empty tint. The header action is full width on phones and inline from `sm`.

Loading keeps sectional skeletons matched to final geometry — no full-page spinner, no layout jump. The error state keeps the existing distinction: a failed first load says it could not load, a failed background refresh says the numbers may be out of date and leaves the previous values on screen. `401` still leaves through the central session invalidation and never reaches this component's error branch.

### Validation

Measured contrast, light then dark: page heading 17.14 / 15.80, subtitle 4.80 / 6.83, section heading 17.77 / 14.57, metric value 17.77 / 14.57, metric label 4.97 / 6.30, primary action 14.84 / 7.35, section link 4.95 / 9.71, next-action eyebrow 13.12 / 5.95, next-action title 15.71 / 12.64, pipeline label 7.69 / 10.01, pipeline value 17.77 / 14.57. The eyebrow was first drawn in `brand-accent-text` and measured 4.38:1 on the tinted surface — under AA at 12px — and was moved to `brand-primary`.

Real Chromium against a local production build covered 1440×900, 900×900, 390×844, and 390×667 in both schemes, plus loading, empty, and error states. No horizontal overflow at any size. Keyboard traversal of the Dashboard's own controls showed a 3px `focus-ring` outline with `:focus-visible` on every link and button.

The complete web suite passed 44 files / 848 tests, including five new Dashboard tests asserting the semantic contracts rather than markup. The responsive AppShell suite passed 9/9, confirming the shell is unchanged. TypeScript, ESLint, and the production build passed.

## 21C. Stage 5 Tracker migration record

Status: implemented for visual review on 2026-08-17; read and mutation behaviour frozen.

### Strategy

The Tracker is an operational list, not a dashboard: the job is to scan many applications and move one along. So the migration spends its budget on legibility and density rather than decoration — border-first cards, no shadows, muted icons, and colour reserved for the one thing being scanned, which is the stage an application is in.

What the Tracker actually is, confirmed by reading the implementation rather than assuming: a single `GET /jobs/tracker/submitted` read into local state, a stage filter, a text search, four summary counts, and a per-card `<select>` that issues `PUT /jobs/{job_id}/tracker`. **There is no kanban board, no drag and drop, no detail drawer, no sorting, no pagination, and no delete/archive.** None of those were invented for this stage.

### Canonical application status semantics

Stage 4 recorded the Dashboard/Tracker status mapping as knowingly duplicated and named this stage as the place to fix it. It is now fixed.

`lib/applicationStatus.ts` is the single source of truth. It follows the `lib/fitScore.ts` precedent exactly — a pure domain module with no React, no API client and no component imports, so either screen can consume it without dragging the other's module graph along.

| Status | Tone | Meaning |
| --- | --- | --- |
| `saved` | neutral | parked, no judgement |
| `ready_to_apply` | neutral | parked, no judgement |
| `applying` | warning | in flight, may need attention |
| `applied` | warning | in flight, may need attention |
| `interview` | info | progress worth noticing, not yet an outcome |
| `offer` | success | the one genuine positive outcome |
| `rejected` | danger | the one genuine negative outcome |
| `withdrawn` | neutral | closed without judgement |
| *anything else* | neutral | unknown degrades safely |

`getApplicationStatusTone()` accepts a bare string because the Dashboard payload types `status` as `string` and because the backend may add a status this build has never seen. Unknown values return `neutral` rather than throwing — neutral reads as "no judgement", which is the only honest thing to show for a status the frontend cannot interpret.

`ApplicationStatusTone` is declared in `lib/` rather than imported from `components/ui`, so the directory keeps the UI-free layering every other module in it follows. A contract test asserts the two unions stay mutually assignable, so the deliberate duplication of the union cannot silently drift.

### Label decision: "Offer / selected" vs "Offer"

Resolved as **case A — same domain state, different context.** Both are correct and both are kept.

On the Tracker the value names a stage you *move an application into*, and "Offer / selected" says that some employers call it an offer and some call it being selected; it is also the confirmation wording ("Moved to Offer / selected."). The Dashboard's dense badge has no room for that nuance and says "Offer".

So the shared module owns `formatApplicationStatus()` — the compact, neutral label, including the `ready_to_apply` → "Saved" translation that both screens already agreed on — and the Tracker keeps a three-line local override for `offer` only. Domain semantic is shared; presentation copy stays with the page that owns the context.

### Legacy styling removed

`text-pine` / `bg-pine` (filter selection, summary-card icon tiles, spinners, links, empty-state CTA, confirmation text), `--success-surface` on the summary-card icon tiles, the hand-written status colours including the raw `border-sky-300/40 bg-sky-500/10 text-sky-500` interview treatment, `rounded-2xl`, `bg-white`, `border-line`, `shadow-sm`/`hover:shadow-md`, and the legacy `focus-ring`.

Semantic green is preserved and is now *more* meaningful, not less: green appears only on the offer badge and the stage-move confirmation. The old build spent the success palette on "Total tracked", which is not an achievement.

### Component treatment

| Region | Treatment |
| --- | --- |
| page header | Dashboard hierarchy — 36px desktop / 30px mobile, muted supporting line |
| summary counts | neutral `surface-card`, muted icon in a subtle tile, `tabular-nums` value |
| stage filters | canonical `Chip` with `aria-pressed`, in a labelled `role="group"` |
| search | custom markup retained for the inset icon, borrowing the canonical field visual contract |
| application card | `surface-card`, `line-default`, canonical radius, restrained `hover:border-line-interactive` |
| status badge | canonical `StatusBadge` + shared tone, label always present |
| status select | native `<select>` retained with its `aria-label`, restyled with field tokens |
| "View job" | secondary action, not primary — leaving for the posting is a normal step |
| load error | canonical `Alert tone="danger"` |
| stage confirmation | `status-success` text |
| loading | sectional skeletons in the shape of the real content |
| empty | dashed card; the primary CTA appears only when the tracker is genuinely empty, since a search that matched nothing needs a different query, not a new job |

### Deliberate decisions

**Fit score stays plain metadata.** The Tracker shows `NN% fit` as uncoloured text among the card metadata. The fit bands are a Jobs/Dashboard signal; in a dense tracker row the stage is what is being scanned, and a second coloured chip competes with it. `lib/fitScore.ts` is untouched.

**Chips over custom buttons.** A stage filter is a toggle, and the primitive carries `aria-pressed`, so the active stage is announced rather than only coloured.

**Skeletons over the spinner.** The previous loading state replaced the whole section with a centred spinner, so everything jumped when data landed. The skeletons occupy the eventual geometry. Request timing, caching and the early return are unchanged.

### Responsive

The Tracker is a stacked list at every size, so there is no board to scroll and **no intentional horizontal scrolling anywhere** — any document overflow would be a defect. The summary grid runs 1-up on phones, 2-up from `sm`, and 4-up from `xl`; the toolbar stacks above the search field until `lg`; the card's action row wraps below the content until `lg`.

### Found, not fixed

The per-card `<select>` offers only Applied / Interview / Offer / Rejected, but an application can hold `saved`, `ready_to_apply`, `applying` or `withdrawn`. For those the control falls back to displaying the first option, so a `withdrawn` application appears to read "Applied" until it is changed. This is pre-existing behaviour, unchanged by this stage, and fixing it means deciding which transitions the product actually allows — a workflow question, not a visual one. Recorded here as a Tracker-specific follow-up.

## 21D. Stage 6 Find Jobs / Job Discovery migration record

Status: implemented for visual review on 2026-08-20; search, filter, and job data behaviour frozen.

### Implementation map

`/jobs` renders `<AppShell workspace>` around `JobDiscovery`, which owns the list, the selection and the detail split in one component because opening a job never unmounts the list. Discovery-owned pieces migrated in this stage:

| File | Role |
| --- | --- |
| `components/JobDiscovery.tsx` | header, action bar, alerts, result summary, skeletons, empty/error states |
| `components/jobs/JobsFilterBar.tsx` | search + four selects + clear |
| `components/jobs/JobCard.tsx` | full result card, compact list card, secondary actions, tracker pill |
| `components/jobs/badges.tsx` | source/workplace/posted/salary/fit indicators |
| `components/jobs/ApplyButton.tsx` | the primary apply action |

Untouched and deferred to Stage 7: `JobDetailPanel.tsx`, `documents.tsx`, `MarkAppliedDialog.tsx`, `AutoApplyModal.tsx`.

### Data flow (unchanged)

Read: `GET /jobs?posted_within_days=N` into local state, re-requested only when the posted-within window changes; every other filter (`q`, `workplace`, `minFit`, `sort`) is applied client-side over that list, and all of them live in the URL so a filtered list is shareable. Tracker decoration comes from `GET /jobs/tracker/...`, and the list stays fully usable if that call fails. Mutations — save, assisted apply, document generation, mark-applied — were not touched.

### Legacy styling removed

`bg-pine` on the primary apply action, `text-pine` on match-reason bullets, the profile link and the selected compact card, `--success-surface` on the selected compact card and the tracker pill, plus the usual `bg-white` / `bg-panel` / `border-line` / `rounded-2xl` / `focus-ring` / `--text-muted` / `--text-secondary` / `text-ink` family across the five discovery files.

### Domain semantics preserved

**Fit score** still comes from `lib/fitScore.ts` and nowhere else; the four bands render distinctly (92 emerald, 68 lime, 47 orange, 31 red) and always carry the number plus the band label, with a screen-reader sentence on the compact pill. No page-local thresholds were introduced.

**Application status** now consumes `lib/applicationStatus.ts`. The card previously collapsed every post-save state into a green "In tracker", which spent the success colour on merely having applied and hid which stage the application had reached. It now shows the real stage with the canonical tone, so green appears only for an offer and a rejection finally looks like one — the same vocabulary the Tracker and the Dashboard use.

**Saved** is a neutral state, not a success: `saved` and `ready_to_apply` render neutral, and the selected compact card uses the brand selection surface rather than the success surface.

### Action hierarchy

One primary per result — "Apply on official site", now navy in light and cyan-on-ink in dark. Save, Resume, Cover Letter and Find people are secondary outline controls of equal weight; the page-level "Find fresh jobs" is primary and "Refresh matches" secondary. The card is click-to-open but is not itself a control: the title is the single keyboard stop and the action buttons are siblings, not nested interactives.

### Filters

Five URL-synced controls kept exactly as they are — a text search plus selects for workplace, minimum fit, posted-within and sort. Selects were deliberately *not* converted to chips: these are single-choice pickers from fixed lists, which is what a select is for. Only the search field and the selects were restyled onto the canonical field contract. Selection uses brand semantics; "Clear filters" appears only when a filter is set.

### Mobile

The filter row wraps to a search field above a 2×2 block of selects (154px total) — the existing wrap architecture was kept rather than replaced with a filter sheet, because five controls fit legibly without hiding anything behind a trigger.

**Defect found and fixed:** the result cards overflowed the document horizontally at 390px. The cards are grid items, whose default `min-width: auto` refuses to shrink below min-content, so a long role title pushed a card ~130px past the viewport and gave the whole document a horizontal scrollbar. The results grid now uses an explicit `minmax(0,1fr)` track and the card carries `min-w-0`. This was pre-existing — the AppShell responsive spec exercises `/jobs` with an empty list, so no card was ever rendered at phone width. The fit badge also moves below the identity block on phones and sits beside it from `sm` up, so the role and company lead the scan.

### Loading, empty, error

Skeletons now mirror the real card geometry (logo, title, meta, score block). The error state keeps its retry and is a canonical danger surface with `role="alert"`. Empty states are now two distinct states: when jobs are loaded but the filters exclude all of them the card says so and offers **Clear filters**; when the workspace itself is empty it keeps the original discovery guidance, because offering to clear filters there would be a dead end.

### Deliberate exceptions

`components/Button.tsx`, the legacy adapter, is untouched — it is still used by unmigrated pages, so discovery imports the canonical `components/ui` Button instead. `AssistedApplyButton` is shared with the detail panel; migrating it necessarily restyles the detail panel's apply control, which is the minimum boundary work Stage 6 allows. The pre-existing unused `Banknote` import in `JobCard.tsx` was left alone as out of scope.

### Remaining for Stage 7

The job detail panel (tabs, overview, networking, insights), the document generation and preview modals, the assisted-apply modal, and the mark-applied dialog.

## 21E. Stage 7 Job Detail / application preparation migration record

Status: implemented for visual review on 2026-08-20; job data, generation, apply and tracking behaviour frozen.

### Implementation map

Everything after a job is opened lives inside the Jobs workspace — `/jobs/[id]` is only a permalink that redirects to `/jobs?job=N`.

| File | Role |
| --- | --- |
| `components/jobs/JobDetailPanel.tsx` | shell, header, four tabs, fit, strengths/gaps, description, materials |
| `components/jobs/documents.tsx` | generation progress modal, document preview/edit modal |
| `components/jobs/MarkAppliedDialog.tsx` | records an application against the tracker |
| `components/AutoApplyModal.tsx` | assisted-apply flow |
| `components/PeopleWhoCanHelp.tsx` | the Networking tab's integration surface |

### Boundaries checked before editing

`AutoApplyModal` is **live**, not dead code: `JobDiscovery` renders it whenever `applyJobId` is set, which is what `AssistedApplyButton` triggers. It was therefore migrated.

`PeopleWhoCanHelp` is imported **only** by `JobDetailPanel`, and no `/people` route exists — it is the Job Detail-owned networking surface rather than a standalone People product, so migrating it stays inside the stage boundary. The People/referrals product itself remains a later stage.

### Tabs

Four sections — Overview, Job description, Application materials, Networking — already carried correct ARIA (`role="tablist"`, `aria-selected`, `aria-controls`, roving `tabIndex`, arrow/Home/End keys) and a `scroll-strip`. Only the colour changed: the selected tab moved from the legacy green underline to `border-brand-accent` with `text-brand-primary`. On phones the tab strip scrolls at component level; the document never does.

### Status semantics — the defect this stage fixes

The detail header rendered **every** tracker state in the success surface, so a closed application announced itself in green. Tone now comes from `lib/applicationStatus.ts`, while the page keeps its own wording (`TRACKER_LABELS`), which Stage 5 established as legitimate presentation copy. Verified in the browser across the whole lifecycle:

| Status | Detail header label | Tone |
| --- | --- | --- |
| `saved` | Saved | neutral |
| `applying` | Applying | warning |
| `applied` | Applied | warning |
| `interview` | Interview | info |
| `offer` | Offer | success |
| `rejected` | **Closed** | **danger** |
| `withdrawn` | Withdrawn | neutral |

Green now appears only for an offer, and the detail header agrees with the compact list card beside it.

### Fit

`lib/fitScore.ts` remains the only source; no local thresholds were added. One correction: the band label next to the score (`fit_label`) was painted green regardless of band, so "Low fit" rendered in the success colour. It is now neutral — the score block already carries the band's colour.

### Meaning-first colour decisions

*What is working for you* (strengths, matched skills) keeps semantic success: these are genuinely positive assessments, not decoration. *What is holding it back* stays neutral with a muted alert icon. The **Tailoring angle** moved from a success box to an informational one — it is advice, not an achievement. Generation progress moved from brand green to `status-info`; a finished document keeps success, because successful generation is a real positive outcome.

### Documents

The backend exposes three states and no more, so three are rendered: not generated (neutral), generating (info, with a live region), ready (success). No "outdated" or per-document error state was invented — generation failures surface through the workspace error path. Action hierarchy: **Generate** is primary when nothing exists; once ready, **Preview and download** is primary and **Regenerate** drops to secondary. The preview modal's preview/edit switch became a selection toggle rather than two filled buttons.

### Responsive

Verified at 1440×900, 900×900, 390×844 and 390×667 in both themes with representative fixtures (long title, long company, missing salary, strong and low fit, tracked and untracked, long description, bulleted requirements, networking results). **Zero document-level horizontal overflow at every size.** The only intentional component-level scrolling is the tab strip on phones. Desktop keeps the dense compact list beside a readable detail column; the workspace collapses the AppShell to a slim rail, which is existing Stage 3 behaviour.

### Deliberate exceptions

Vendor brand colours are preserved, not tokenised: `--linkedin` and `--email-action` in the networking surface identify external networks and must stay recognisable, exactly as company logos are never tinted. Two `people-who-can-help` assertions were updated from the raw legacy variable to the equivalent semantic token — the same claim in the new vocabulary, not a weakened assertion.

### Remaining

The standalone **My Resumes** library, the **People/referrals** product, Profile, Settings, the global warm canvas and the global `--skeleton` token.

## 21F. Stage 8 standalone document routes — findings and migration record

Status: investigated and migrated on 2026-08-20. **The standalone My Resumes / document-management product does not exist.**

### What is actually there

`My Resumes` in the sidebar maps to `activeRoots: ["/resume", "/cover-letter", "/application-answers"]`. All three routes are 13-line placeholders that render `AppShell` plus a static heading and one sentence. They import nothing but `AppShell`, have no client component, no data fetching, no state, and no tests. Measured in a real browser at four viewports in both themes, each page contains **zero** links, buttons, inputs, selects or textareas.

They are identical to their committed state at `ced7562` — this is the product's shape, not regression or damage.

Their own copy says where the functionality lives: *"Generate tailored, ATS-friendly resumes **from the job discovery page**."* The real document workflow is the job-specific one migrated in Stage 7 (`JobDetailPanel` materials tab, `documents.tsx` generation and preview modals).

So none of the features Stage 8 was scoped around exist to migrate: no library or list, no base/default resume, no per-document status lifecycle, no editor, no download or delete, no search/filter/sort, no standalone cover-letter or application-answers management. Inventing them would be building a product, not migrating a design system.

### What Stage 8 changed

Only what genuinely exists: the three placeholder headers now use the same hierarchy as every migrated product page — `text-3xl … sm:text-4xl` with `tracking-[-0.035em] text-foreground`, and `text-foreground-muted` supporting copy in place of the legacy `--text-muted` variable. Verified: 36px desktop / 30px mobile, zero legacy tokens remaining, zero document-level overflow at 1440×900, 900×900, 390×844 and 390×667 in both themes. Contrast: heading 17.14 light / 15.80 dark, supporting copy 4.80 / 6.83.

### Deliberately not changed

`GeneratedResumePreview.tsx` and `GeneratedCoverLetterPreview.tsx` render the document facsimile inside Stage 7's preview modal, and are imported only by `components/jobs/documents.tsx`. They still use the legacy `--text-primary` / `--text-secondary` variables and a literal paper surface with a Georgia serif face and `print:shadow-none`.

They were left alone on purpose. The legacy `--text-primary` (`#17211b`) and the canonical `--color-text-primary` (`--xa-ink`, `#08182f`) resolve to **different** colours, so a token swap would visibly change how a generated resume renders — and these components represent a printed artefact rather than product chrome. Whether a resume preview should stay white paper in dark mode is a product decision, not a token cleanup. Recorded as a Stage 7 follow-up for a human to decide.

### Remaining

Profile, Settings, the People/referrals product, the global warm canvas, the global `--skeleton` token, and the document-facsimile decision above. If a real My Resumes library is wanted, it is a product build, not a migration stage.

## 21G. Stage 9 Profile migration record

Status: implemented for visual review on 2026-08-20; every profile persistence contract frozen.

### Active routes and implementation map

`/profile` (overview), `/profile/[section]` (nine focused editors through one dynamic route), `/profile/application-preferences` and `/profile/eeo` (their own segments). `/profile/[section]` opens the existing wizard at the matching step, so there is exactly one implementation of every profile form.

| Area | Files |
| --- | --- |
| Overview | `profile/ProfileOverview.tsx`, `profile/primitives.tsx`, `profile/BrandIcons.tsx` |
| Editors | `profile/editors/` — 11 editors plus `primitives.tsx` (758 lines), `EditorShell.tsx`, `SectionEditor.tsx` |
| Wizard / import | `ProfileWizard.tsx`, `ImportProfilePreview.tsx`, `profile/UnsavedChangesDialog.tsx` |
| Routes | `app/profile/page.tsx`, `app/profile/[section]/page.tsx`, `app/profile/application-preferences/page.tsx`, `app/profile/eeo/page.tsx` |

About 7,000 lines — the largest surface in the migration so far.

### Persistence contract — untouched

**Zero files under `lib/` changed.** `profileOverview.ts`, `profileEditorData.ts`, `profileForm.ts`, `profileUrls.ts`, `profileSections.ts`, `profileCatalog.ts`, `authSession.ts` and `api.ts` are all byte-identical. Focused `PATCH /profile` field ownership, canonical server-response adoption, URL normalisation, structured `fieldErrors`/`formError`, import validation and session behaviour are therefore unchanged by construction, not merely by inspection. The 2026 production incident — a legacy `portfolio_url` blocking unrelated saves through whole-document PUT — cannot regress from a Stage 9 change, because no code on that path was edited.

### Meaning-first colour decisions

**Progress is not success.** Profile completion and autofill readiness meters moved from brand green to `brand-accent`, and stay brand at 100% because the product does not treat completion as a success event. Verified live at 72% and 100%.

**Selections are not success.** Every selected preference — target roles, target levels, locations, workplace mode, wizard multi-selects — moved from `border-pine bg-[var(--success-surface)] text-pine` to the canonical selection treatment (`border-line-selected bg-surface-selected text-brand-primary`). This was the single largest source of misused green on the surface.

**A completed save is success.** The editor's "Saved" indicator keeps `status-success`; "Saving…" stays muted with a spinner and errors stay `status-danger`.

**Identity is not an achievement.** The overview's initials tile dropped the success tint for a neutral bordered chip, and the contact-row phone chip moved off the success surface to a brand tint. LinkedIn and the email action keep their vendor brand tokens, exactly as company logos are never re-tinted.

### Buttons

Thirteen Profile files imported the legacy `components/Button` adapter, whose primary variant is `bg-pine text-white`. They now import the canonical `components/ui` Button; only `variant="danger"` needed renaming to `variant="destructive"` (3 occurrences), since `primary` and `secondary` map one-to-one. **`components/Button.tsx` itself is untouched** — Settings and other unmigrated pages still depend on it.

Hierarchy on the editors is now explicit: Save changes primary, Cancel secondary, section Edit actions quiet links, remove actions destructive.

### Responsive and accessibility

Verified across `/profile`, `/profile/personal` and `/profile/preferences` at 1440×900, 900×900, 390×844 and 390×667 in both themes — 24 combinations, **zero document-level horizontal overflow and zero legacy classes remaining in the rendered DOM**. A deliberately long employer name wraps rather than widening the page. One `h1` per page; **18 of 18 inputs on the personal editor carry a real label**; focus-visible is the canonical 3px ring throughout.

Contrast (light / dark): page heading 15.95 / 15.80 · supporting copy 4.80 / 6.83 · section heading 16.54 / 14.57 · field label 16.54 / 14.57 · input text 16.54 / 13.07 · preferences label 7.69 / 10.01. Lowest measured 4.80.

### Deferred product concerns — still real, not solved here

**Target roles are equally weighted.** The editor stores a flat list, so "Machine Learning Engineer" and "Platform Engineer" carry identical matching weight. No primary/secondary role concept exists in the model, and inventing one during a visual migration would change matching semantics.

**Target level mixes seniority with experience.** "Junior" is stored as a target *level* while the surrounding copy talks about seniority; the product has not separated years-of-experience from seniority band. Recorded, not redefined.

Both remain product-model debt for a product decision, not design-system work.

### Remaining

Settings is the last unmigrated product surface. After it, the global warm canvas and the global `--skeleton` token can finally be retired, along with the legacy `components/Button` adapter once nothing imports it.

## 21H. Stage 10 Settings migration record

Status: implemented for visual review on 2026-08-20; all settings behaviour frozen. **Two pre-existing functional findings are recorded below and were deliberately not fixed.**

### What Settings actually is

`/settings` renders two components and nothing else: `ApplicationAccounts` (employer-portal credentials) and `PrivacyControls` (data export + account deletion). There is **no** theme/appearance control, no notification settings, no connected-accounts list, no session management and no logout — logout stays canonical in the AppShell. The route has no dedicated test file.

| Setting | Ownership |
| --- | --- |
| Workday password | server, write-only; `GET /profile` reports only `workday_password_configured`, the value is never returned to the browser |
| Data export | server, `GET /privacy/export`, rendered in-page |
| Account deletion | server, `DELETE /privacy/account`, then `invalidateAuthSession({ reason: "account_deleted" })` |

Nothing is browser-local or session-backed, so no ownership could change.

### Visual migration

Both components and the route header moved onto canonical tokens, and all three now import the canonical `components/ui` Button (`variant="danger"` → `"destructive"`). A configured credential keeps semantic success — it is a genuine positive state, and it already carried an icon and a word, not colour alone.

`PrivacyControls` needed structure rather than recolouring. It previously rendered a bare card with **Export JSON and Delete account side by side as equally prominent buttons**, no heading and no explanation. It is now two labelled regions: *Your data* (export, secondary action) and an isolated *Danger zone* with a danger-toned heading, an explicit "This cannot be undone" description, a danger boundary on the card, and a destructive CTA. The danger tone sits on the boundary and the control rather than flooding a red panel.

Verified with scoped assertions — naming each control rather than taking the first button on the page: Delete is inside the danger section and uses `action-destructive`; Export is inside the data section and uses `action-secondary`; the credential Save/Update uses `action-primary`.

### Responsive and accessibility

Eight viewport/theme combinations at 1440×900, 900×900, 390×844 and 390×667, in both the configured and unconfigured credential states: **zero document-level horizontal overflow and zero legacy classes in the rendered DOM**. One `h1`, three `aria-labelledby` sections (`Application accounts`, `Your data`, `Danger zone`), 1 of 1 inputs labelled with a described hint, keyboard traversal reaching the password field, Remove, Export and Delete with the canonical 3px focus ring on each.

The credential-removal flow already had proper friction and keeps it: `role="alertdialog"`, `aria-labelledby`, Cancel plus a destructive confirm.

Contrast (light / dark): h1 17.14 / 15.80 · supporting 4.80 / 6.83 · section heading 17.14 / 15.80 · danger heading 6.39 / 7.35 · danger copy 4.80 / 6.83 · field label 16.54 / 14.57 · hint 4.97 / 6.30 · delete CTA 6.62 / 7.25 · export CTA 17.77 / 13.07 · credential status 5.93 / 6.91. Lowest 4.80.

### Findings NOT fixed — they change behaviour

**1. Account deletion has no confirmation.** `deleteAccount()` issues `DELETE /privacy/account` directly from the click handler. There is no dialog, no typed confirmation and no undo. The irony is local: removing a *stored Workday password* opens an `alertdialog` with Cancel, while deleting the entire account — profile, applications, generated documents — does not. Stage 10 isolated the control and made it unmistakably destructive, which reduces accidental-click risk, but adding friction changes the flow and is a product decision.

**2. Export and delete have no error handling.** Neither call is wrapped. Verified against a mocked 500: the click produces an unhandled rejection, no visible error, and nothing rendered — the button appears inert. The user cannot tell the difference between "failed" and "nothing happened".

Both are pre-existing and outside a visual migration's remit.

### Legacy Button status — not yet retirable

`components/Button.tsx` is untouched and still has **6 importers**, of which **7 call sites use the default (primary) variant and therefore still render `bg-pine` green**:

| File | Green primaries | Stage |
| --- | --- | --- |
| `jobs/documents.tsx` | 1 | 7 |
| `jobs/MarkAppliedDialog.tsx` | 1 | 7 |
| `AutoApplyModal.tsx` | 2 | 7 |
| `PeopleWhoCanHelp.tsx` | 1 | 7 |
| `DemographicsForm.tsx` | 1 | — |
| `SectionError.tsx` | 1 | — |

Stage 7 migrated those files' tokens but left the Button import, so their primary CTAs are still legacy green. This is a genuine Stage 7 gap, recorded here rather than fixed, because re-opening approved surfaces mid-stage would blur the accounting. It belongs in the closing stage alongside Button retirement.

### Remaining for the closing stage

Global authenticated canvas · global `--skeleton` token · legacy `Button` retirement plus the 7 green primaries above · the dead-end **My Resumes** navigation decision · product-wide responsive/accessibility regression.

## 21I. Stage 10B Settings safety hardening

Status: implemented for review on 2026-08-20. Narrow functional correction of two pre-existing defects found during Stage 10; no visual redesign.

### Why this was not part of the visual migration

Stage 10 recorded both defects and deliberately left them, because fixing either changes behaviour and the visual stage was under a functional freeze. They are corrected here as safety hardening, with their own tests, so the change is reviewable on its own terms rather than buried in a token sweep.

### Defect 1 — account deletion was one click

`deleteAccount()` issued `DELETE /privacy/account` straight from the button's click handler. No dialog, no second action, no undo. The same file already removed a *Workday password* behind an `alertdialog` with Cancel, so the far more destructive action was the less guarded one.

The request now issues only from inside a confirmation dialog, and only once the user has typed `DELETE` exactly. The dialog follows the repository's established prompt contract from `profile/UnsavedChangesDialog`: `role="alertdialog"`, `aria-modal="true"`, `aria-labelledby` / `aria-describedby`, focus trapped on Tab, Escape resolving to the safe choice, focus returned to the trigger, and a backdrop that is `role="presentation"` rather than a dismiss target. Initial focus lands on the labelled confirmation input, which is safe because the destructive button stays disabled until the phrase matches.

A typed phrase was chosen over a second click because a second click is exactly the reflex this needs to defeat. Password re-entry was rejected: no backend verification endpoint exists for it, and inventing one was out of scope.

Duplicate submissions are prevented at both ends — the handler returns early while a request is pending, and the confirm button is disabled — verified as exactly one `DELETE` under three rapid clicks.

### Defect 2 — export and delete swallowed failures

Neither call was wrapped, so a failure produced an unhandled rejection and a button that simply looked inert. Both now surface the message from the shared `ApiError`, which the transport already normalises for humans, inside `role="alert"` regions. A response body is never rendered.

Failure keeps the delete dialog open and retryable, and a retry that succeeds completes normally. Export clears any stale result on failure, so a previous payload cannot be mistaken for a fresh one.

### Auth semantics unchanged

`lib/authSession.ts` and `lib/api.ts` are untouched. The transport still owns the single 401 invalidation contract, and no page-local session logic was added. Ordinary 403 / 422 / 500 / network failures keep the user signed in — asserted directly. Success still calls `invalidateAuthSession({ reason: "account_deleted", returnTo: null })`, unchanged.

### Verification

Fifteen focused tests in `__tests__/settings-privacy-controls.test.tsx` cover: the trigger firing no request, the phrase gate rejecting `delete` and `DELETE ME`, Cancel and Escape closing without deleting, focus returning to the trigger, exactly one `DELETE` on confirm, no duplicates while pending, 500 / 403 / 422 / network keeping the dialog open with a visible non-JSON error and no session invalidation, retry succeeding, and export success, failure and recovery.

Browser-verified with mocks only — no production deletion was ever issued. Both themes at 1440×900 and both phone sizes: dialog fits width and height, Cancel and confirm reachable, no document overflow, and **zero page errors in either failure path**, confirming no unhandled rejection remains. Contrast (light / dark): title 17.77 / 14.57 · body 4.97 / 6.30 · confirmation label 17.77 / 14.57 · input 17.77 / 14.57 · dialog error 6.09 / 6.73 · destructive confirm 6.62 / 7.25 · Cancel 17.77 / 13.07.

`ApplicationAccounts` was not touched, so Workday credential behaviour is unchanged by construction.

## 21J. Stage 11 global unification and legacy retirement

Status: implemented for review on 2026-08-20. The closing stage. It owns what no single page could: the canvas underneath all of them, the loading token they share, the last legacy component, and one navigation entry that promised a product that does not exist.

### The seam this stage closed

Every authenticated page had been migrated, and the product still did not read as one system. The reason was underneath the pages: `--background` was `#fbfbf8`, a warm neutral from the pre-migration palette, painted on `html`, `body` and `.app-shell`. A migrated navy/cyan page sat on a faintly yellow sheet, and the mismatch was most visible exactly where the design system was strongest — cool cards on a warm canvas.

### Canvas ownership — a token, not a route list

The fix is a single alias rather than a background class on every page:

```css
--background: var(--color-surface-page);
```

An alias resolves against the value the active colour scheme computed, so one declaration follows light and dark, and every surface that already referenced `--background` — `html`, `body`, `.app-shell`, the Jobs workspace columns, the error boundary, and the Stage 8 placeholder routes — became canonical at once. No route-by-route exception exists, and none can be introduced, because there is no per-page background to set.

The same reasoning retired the rest of the legacy names. `--surface`, `--surface-raised`, `--surface-muted`, `--text-primary/secondary/muted`, `--border`, `--border-strong`, `--focus-ring`, `--overlay`, `--input-background`, `--disabled-background` and the four status families are now aliases onto their `--color-*` roles. Because Tailwind's compatibility palette (`bg-white`, `bg-panel`, `border-line`, `text-ink`) is defined in terms of those names, unmigrated markup became canonical without being edited.

In dark mode every aliased value was already identical to its canonical role, so the dark block's restatements were deleted rather than rewritten — and `theme.test.ts` now asserts their *absence*, since a restated alias is exactly how light and dark drift apart again. `--border-strong` maps to the *interactive* line role, not the strong one: its real consumers are scrollbar thumbs and hover edges, which need a visible contrast rather than a hairline.

Marketing is untouched by construction. `marketing.css` declares its palette on `.xa-theme` and paints `html:has(.xa-page)` itself; verified identical in both colour schemes after the change.

### Global skeleton

`--skeleton` was the warm `#e7eae3`. Two migrated pages had already routed around it with local `bg-line-subtle` blocks and a comment saying the token would be retired later. It is retired here, replaced by a dedicated `--color-skeleton` role (`#e3e8ef` / `#2f363b`) and a `bg-skeleton` utility, and the local workarounds were folded back into it. A border colour was deliberately *not* reused: a skeleton has to stay perceptible on the page, on a card and on a tinted selected row, which is a stronger requirement than any line token carries.

Measured, composited: 1.23:1 against a card and 1.18:1 against the page in light; 1.35:1 and 1.47:1 in dark. Present without competing with real content, and never dependent on the pulse animation alone.

### The last seven green primaries

`components/Button.tsx` — the pre-migration adapter, a green fill with no destructive or ghost role — had six runtime importers and seven primary call sites left. Each was re-read for its actual semantic role rather than bulk-replaced:

| Call site | Action | Treatment |
| --- | --- | --- |
| `jobs/documents.tsx` | Save document | primary — the panel's one forward action |
| `jobs/MarkAppliedDialog.tsx` | Yes, mark as applied | primary — success stays in the dialog's icon and the tinted trigger |
| `AutoApplyModal.tsx` | Apply on official site | primary — plus removal of a hard-coded pine drop shadow |
| `AutoApplyModal.tsx` | Retry preparation | primary — the only forward action in the failed phase |
| `PeopleWhoCanHelp.tsx` | Find people / Broaden search | primary |
| `DemographicsForm.tsx` | Save settings | primary; **Delete EEO data** moved `danger` → `destructive` |
| `SectionError.tsx` | Retry | **secondary**, with the way back as `ghost` |

`SectionError` is the deliberate exception. It is a `role="alert"` card that can appear several times on one screen; a navy primary there would out-rank the page's real call to action and make a failure look like the thing to do next. Recovery stays emphasised without borrowing brand weight.

With every call site moved, `components/Button.tsx` was deleted. Importer count: 6 before, 0 after.

### Other green that meant "brand"

- `ApplicationEligibility` (inside Profile → Application preferences) painted the *selected* Yes/No answer in `--accent` on the success surface — green telling the user a plain factual answer was good. Now the canonical selected treatment. Its "Saved" confirmation keeps green, because that one is a real success.
- `input[type=checkbox|radio] { accent-color: var(--accent) }` tinted every native control in the product pine. Now `--color-brand-primary`: navy in light, cyan in dark.
- `app/error.tsx` — the app-wide error boundary, which renders inside the product — had a green primary "Try again".
- `lib/fitScore.ts`'s not-scored tier used `border-line bg-panel`; now the canonical neutral. The emerald/lime/orange/red bands are the documented FIT family and were not touched.
- `app/matches/[id]` is a real authenticated route no earlier stage reached: `text-pine`, `bg-white`, `border-line`. Migrated.

### Document facsimiles were not actually paper

Stage 17 of the brief records the product decision that generated resumes and cover letters stay white-paper facsimiles in both themes. They did not. Both previews used `bg-white`, which the Tailwind compatibility palette maps to the *card surface* — so in dark mode the "sheet of paper" rendered charcoal, misrepresenting the DOCX/PDF the same content exports to.

Four fixed tokens now exist for this and nothing else: `--color-document-paper`, `--color-document-ink`, `--color-document-ink-muted`, `--color-document-rule`. They are declared once and deliberately **not** redefined in the dark block. Verified rendered: `rgb(255,255,255)` paper with `rgb(23,32,42)` ink in Georgia, identically in both themes, while the surrounding modal chrome follows the theme (`#f8fafc` / `#14171a`).

### My Resumes

`/resume`, `/cover-letter` and `/application-answers` are Stage 8 headings that explain where document generation actually happens — inside the Jobs workspace, against a specific job. There is no standalone document-management product behind them, so a top-level "My Resumes" entry advertised one and delivered a paragraph.

The entry was removed rather than repointed: sending "My Resumes" to `/jobs` under the same label would be a different kind of lie. The three routes stay reachable by direct URL for existing links and bookmarks, inherit the canonical canvas, and gained no compensating UI. Their `activeRoots` mapping went with the entry, so a directly opened placeholder route now shows *no* active primary item — correct, and asserted.

### Errors that were written for an operator

`DELETE /privacy/account` and `/jobs/tracker/*` define no user-facing failure wording of their own. What reaches the client is either the API's safe catch-all ("Something went wrong. Please try again.") or an infrastructure `detail` — and the shared auth dependency answers a database outage with `"Database unavailable or not migrated. Run alembic upgrade head."`, an operator runbook instruction. Stage 10B rendered the normalised `ApiError` message verbatim on the account-deletion dialog; the Tracker did the same above someone's application list.

Both now own stable copy. Export still passes the server message through — its endpoint returns data the user asked for and the wording there is worth showing. The backend was read only; nothing about it changed.

### Two defects the fixture data exposed

Empty-state testing would have missed both.

**Dashboard mobile overflow.** With realistic job titles the document scrolled to 683px inside a 320px viewport. A grid item's automatic minimum is its min-content width, and `truncate` reports min-content as the width of the *untruncated* string — so the two-column row was sized to the longest job title. `min-w-0` on the grid children fixes it. Pre-existing from the committed Dashboard migration; the layout markup is untouched by Stages 5–11.

**Placeholder contrast.** `globals.css` carried a rule to keep placeholders legible. It never applied: Tailwind's preflight ships `input::placeholder, textarea::placeholder` at specificity (0,0,2) and outranked the bare `::placeholder` selector, leaving placeholder text at 2.6:1 on a white field. Matching the same element-qualified pairs makes the rule real — 4.97:1 light, 5.65:1 dark.

### Coarse-pointer targets

Section links ("Open tracker", "View all"), the EEO option rows, the EEO back link and the profile "+N more" link were 17–20px tall on a touch screen. Each took `ds-touch-target`, which is scoped to `@media (pointer: coarse)`, so desktop layout is unchanged. Every remaining sub-40px hit resolves to a documented WCAG 2.5.8 exception — a stretched-link anchor whose `::after` covers its whole card, a native checkbox inside a full-width `<label>`, or a link inline in a sentence — and the audit encodes those exceptions rather than waiving them.

### Static contracts

`__tests__/design-system-contracts.test.ts` is new and deliberately narrow — a broad "no green anywhere" scan would reject the things that are supposed to be green and be deleted the first time it cried wolf. It resolves each import specifier to a repo-relative path so the retired `components/Button` cannot return while `components/ui/Button` and third-party `Button` symbols stay legal; it forbids `*-pine` utilities in authenticated chrome with the pre-auth surfaces listed explicitly; it asserts one canonical application-status source and one fit-score source; it asserts the skeleton token; and it asserts the document facsimile is fixed in both themes.

### Verification

292 fixture-backed browser checks passed in both colour schemes: 13 authenticated surfaces × 7 viewports (1440×900, 1280×800, 900×900, 640×800, 390×844, 390×667, 320×700) with zero unintended document overflow; the Tracker's nine statuses with badge and select agreeing and transition targets still exactly applied/interview/offer/rejected; the Job Detail header status measured by role — rejected renders "Closed" in danger, never success; every fit band; account-deletion, mark-applied and unsaved-changes dialogs; the keyboard journey with a visible 3px ring on every stop; navigation destinations and active state including the three placeholder routes; short-height layouts at 900×400 and 390×667; marketing and login regression; empty and mocked-error states on Dashboard, Jobs and Tracker.

934 unit tests across 47 files, typecheck, lint and a clean production build all pass. The repository Playwright suite passes 34 with 20 self-skipping without a stack; against a local stub API 52 pass, the two remaining requiring real sign-up and persistence a stub cannot provide.

## 21K. Stage 11B public entry surface cleanup

Status: implemented for review on 2026-08-20. The last visual migration stage. Narrow by design: the authenticated product is frozen, and nothing here touches it.

### The seam

Stage 11 finished the authenticated product and recorded what it deliberately left alone — the pre-authentication surfaces. A visitor moved from the canonical navy/cyan marketing homepage, clicked "Sign in", and landed on a green sign-in form. The old brand had one place left to live, and it was the doorway.

### AuthDialog

`components/AuthDialog.tsx` is the whole of `/login` and `/signup` (both render it with `presentation="page"`; the `modal` path is live code but unused today). Six legacy constructs, each classified before it was changed:

| Element | Was | Now | Why |
| --- | --- | --- | --- |
| Brand mark badge | `bg-[var(--success-surface)] text-pine` | `bg-surface-selected text-brand-primary` | It identifies XpertApply. That is brand, not success — a green surface said "something went well" on a form nobody had submitted yet. |
| Submit | `bg-pine text-white` | `bg-action-primary text-action-primary-foreground` | Navy on white in light, cyan on ink in dark. The paired foreground token is what makes cyan-under-white structurally impossible. |
| Mode switch | `text-pine` | `text-foreground-link` | "Create an account" / "Sign in" is a link. Destinations unchanged. |
| Privacy lock icon | `text-pine` | `text-brand-accent-text` | A reassurance, not an outcome. Restrained brand accent rather than borrowing success green. |
| Error | `--danger-*` vars | `status-danger-*` roles | Same values; canonical vocabulary. |
| Fields, close, divider | `border-line`, `bg-white/50`, `text-[var(--text-muted)]` | canonical roles | Same weight and geometry; vocabulary only. |

Radii moved onto the scale where the value was already identical (`rounded-xl` → `rounded-field`, `rounded-lg` → `rounded-control`). The card's deliberate `rounded-[28px]` silhouette was left alone.

One behavioural-adjacent change: the password reveal was a 36px icon-only chip floated inside the field. It now fills the 48px gutter the field already reserves with `pr-12`, so the target is 48×48 — measured — without altering the field's geometry. Verified: it toggles `type` between `password` and `text` and back, and keeps its accessible name.

The submit button stays a raw `<button>` rather than the canonical `<Button>`: this is a full-width 48px auth CTA, a different pattern from the product's `sm/md/lg` action sizes, and wrapping it would add indirection without changing a pixel. It consumes the same action tokens.

### Auth behaviour is untouched

`submit()`, `api()`, `storeAuthToken`, `safeReturnPath`, the `next` parameter, redirect target, error handling and the `submitting` guard are byte-for-byte unchanged. `lib/authSession.ts` and `lib/api.ts` were not opened. Field names, `type`, `autocomplete`, `required`, `minLength`, labels and ids are all verified identical in the browser — including that neither field has a `placeholder`, so a placeholder never stands in for a label.

### Static public pages

`/pricing`, `/privacy`, `/opensource` each carried one `text-pine` back-link and one legacy `--text-muted` paragraph. Both migrated; the `href="/"` destination is asserted unchanged and every word of the pricing, legal and open-source copy is byte-for-byte identical.

### Two leftovers from the Stage 11 canvas move

Neither is green, both were found by sweeping for the retired warm hex:

- **`app/layout.tsx` `themeColor`** still declared `#fbfbf8` for light. That is the colour the mobile browser paints its own chrome with, so on the public entry surfaces — where mobile visitors land — the browser frame was warm against a cool page. Now `#f8fafc`, the canonical page surface.
- **`app/global-error.tsx`** inlines its own palette, because it replaces the entire document and cannot rely on the stylesheet having loaded. That inlining is a real and permanent exception — but the *values* were the complete pre-migration palette, including a pine "Reload" button on a warm sheet. The values now mirror the canonical roles in both schemes (navy action in light, cyan on ink in dark), and its hard-coded focus outline became a per-scheme variable.

### The pine end state

Zero `*-pine` utilities and zero `var(--accent)` references remain in the entire runtime — public and authenticated.

`--accent` and `--accent-hover` are now defined with **no consumers**, and the `pine` Tailwind alias has **no call sites**. Both stay defined on purpose rather than being quietly deleted: `--accent-foreground` is still the paired foreground for the green success fill behind "Mark as applied", and removing the palette name would downgrade a stray `bg-pine` from a test failure to a class that silently does nothing. The token comments were rewritten to say exactly this, replacing a Stage 1 note claiming pine "still carries real success meaning" — which stopped being true.

`design-system-contracts.test.ts` was tightened accordingly: the pine rule lost its public-surface allow-list and now covers every runtime file, a second rule blocks `bg-[var(--accent)]`-style smuggling, and a third pins the auth submit to the canonical action role and forbids white text on it.

### Verification

74 public browser checks passed in both colour schemes: the primary action's exact composited paint on `/login` and `/signup`; a whole-page scan proving no element renders any legacy pine value; the mode switch reading as a link and actually switching; the full field contract; the reveal control's 48×48 box and toggle behaviour; a mocked 401 producing styled danger with no payload, token or trace, leaving the form retryable; `/pricing`, `/privacy`, `/opensource` link colour, destination and contrast; keyboard reaching every control with a visible 3px ring and wrapping without a trap; reduced motion; and the marketing homepage measured identical in light and dark.

Responsive at 1440×900, 900×900, 390×844, 390×667 and 320×700 across all five public routes: zero unintended document overflow, submit always fully inside the viewport.

Contrast, measured composited (light / dark): heading 17.69 / 14.72 · secondary copy 4.95 / 6.37 · label 17.69 / 14.72 · input text 17.74 / 11.67 · primary action 14.84 / 7.35 · switch link 4.93 / 9.81 · error 6.09 / 6.73 · footer note 4.95 / 6.37. Public pages: heading 16.98 / 15.80 · body 4.75 / 6.83 · brand link 4.73 / 10.52.

The authenticated product was re-verified unchanged: the full Stage 11 harness passed 292/292, canvas, skeleton and document facsimile readings identical to Stage 11. 936 unit tests across 47 files, typecheck, lint and a clean production build pass. Repository Playwright is unchanged at 34 passed / 20 self-skipped without a stack, 52 passed / 2 stack-dependent against a stub.

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

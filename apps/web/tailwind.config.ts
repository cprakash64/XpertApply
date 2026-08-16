import type { Config } from "tailwindcss";

/*
 * The palette names below map onto the semantic CSS variables defined in
 * app/globals.css. That indirection is what makes the whole application
 * theme-aware: every existing `bg-panel`, `border-line`, `text-ink` or
 * `bg-white` in a component resolves to a token that already has a light and a
 * dark value, so surfaces follow the OS preference without per-component
 * `dark:` overrides.
 *
 * `white` is remapped deliberately: throughout this codebase it means "card
 * surface", not literal white, and leaving it hard-coded would leave bright
 * panels floating in dark mode. Use `text-accent-foreground` when you genuinely
 * need a colour that contrasts against the brand green.
 *
 * darkMode uses Tailwind's "media" strategy, so `dark:` variants follow
 * `prefers-color-scheme`. They are used sparingly — only where a token cannot
 * express the change, e.g. the fit-score hues in lib/fitScore.ts.
 */
const config: Config = {
  darkMode: "media",
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}", "./lib/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // Canonical XpertApply design-system aliases. CSS custom properties in
        // globals.css are the sole runtime value source; components name a
        // semantic role and never carry brand hex values.
        "brand-primary": "var(--color-brand-primary)",
        "brand-primary-hover": "var(--color-brand-primary-hover)",
        "brand-accent": "var(--color-brand-accent)",
        "brand-accent-highlight": "var(--color-brand-accent-highlight)",
        "brand-accent-foreground": "var(--color-brand-accent-foreground)",
        "brand-accent-text": "var(--color-brand-accent-text)",
        "action-primary": "var(--color-action-primary-background)",
        "action-primary-foreground": "var(--color-action-primary-foreground)",
        "action-primary-hover": "var(--color-action-primary-hover)",
        "action-secondary": "var(--color-action-secondary-background)",
        "action-secondary-foreground": "var(--color-action-secondary-foreground)",
        "action-secondary-border": "var(--color-action-secondary-border)",
        "action-ghost-foreground": "var(--color-action-ghost-foreground)",
        "action-ghost-hover": "var(--color-action-ghost-hover)",
        "action-destructive": "var(--color-action-destructive-background)",
        "action-destructive-foreground": "var(--color-action-destructive-foreground)",
        "action-destructive-hover": "var(--color-action-destructive-hover)",
        "surface-page": "var(--color-surface-page)",
        "surface-shell": "var(--color-surface-shell)",
        "surface-card": "var(--color-surface-card)",
        "surface-raised": "var(--color-surface-raised)",
        "surface-subtle": "var(--color-surface-subtle)",
        "surface-selected": "var(--color-surface-selected)",
        "surface-overlay": "var(--color-surface-overlay)",
        "surface-disabled": "var(--color-surface-disabled)",
        foreground: "var(--color-text-primary)",
        "foreground-secondary": "var(--color-text-secondary)",
        "foreground-muted": "var(--color-text-muted)",
        "foreground-disabled": "var(--color-text-disabled)",
        "foreground-inverse": "var(--color-text-inverse)",
        "foreground-link": "var(--color-text-link)",
        "line-subtle": "var(--color-border-subtle)",
        "line-default": "var(--color-border-default)",
        "line-strong": "var(--color-border-strong)",
        "line-interactive": "var(--color-border-interactive)",
        "line-selected": "var(--color-border-selected)",
        "line-error": "var(--color-border-error)",
        "focus-ring": "var(--color-focus-ring)",
        "focus-error": "var(--color-focus-ring-error)",
        "status-neutral": "var(--color-status-neutral)",
        "status-neutral-surface": "var(--color-status-neutral-surface)",
        "status-neutral-border": "var(--color-status-neutral-border)",
        "status-info": "var(--color-status-info)",
        "status-info-surface": "var(--color-status-info-surface)",
        "status-info-border": "var(--color-status-info-border)",
        "status-success": "var(--color-status-success)",
        "status-success-surface": "var(--color-status-success-surface)",
        "status-success-border": "var(--color-status-success-border)",
        "status-warning": "var(--color-status-warning)",
        "status-warning-surface": "var(--color-status-warning-surface)",
        "status-warning-border": "var(--color-status-warning-border)",
        "status-danger": "var(--color-status-danger)",
        "status-danger-strong": "var(--color-status-danger-strong)",
        "status-danger-surface": "var(--color-status-danger-surface)",
        "status-danger-border": "var(--color-status-danger-border)",

        // Semantic tokens
        background: "var(--background)",
        surface: "var(--surface)",
        "surface-muted": "var(--surface-muted)",
        "text-primary": "var(--text-primary)",
        "text-secondary": "var(--text-secondary)",
        "text-muted": "var(--text-muted)",
        border: "var(--border)",
        "border-strong": "var(--border-strong)",
        accent: "var(--accent)",
        "accent-hover": "var(--accent-hover)",
        "accent-foreground": "var(--accent-foreground)",
        success: "var(--success)",
        "success-surface": "var(--success-surface)",
        "success-border": "var(--success-border)",
        warning: "var(--warning)",
        "warning-surface": "var(--warning-surface)",
        "warning-border": "var(--warning-border)",
        danger: "var(--danger)",
        "danger-hover": "var(--danger-hover)",
        "danger-surface": "var(--danger-surface)",
        "danger-border": "var(--danger-border)",
        overlay: "var(--overlay)",

        // Legacy names, kept so existing markup keeps working — now token-backed.
        ink: "var(--text-primary)",
        panel: "var(--surface-muted)",
        line: "var(--border)",
        pine: "var(--accent)",
        coral: "var(--danger)",
        sky: "var(--focus-ring)",

        // "white" means "card surface" in this codebase, not literal white.
        white: "var(--surface)"
      },
      boxShadow: {
        card: "var(--shadow)",
        subtle: "var(--shadow-subtle)",
        raised: "var(--shadow-raised)",
        overlay: "var(--shadow-overlay)"
      },
      borderRadius: {
        control: "var(--radius-control)",
        field: "var(--radius-field)",
        card: "var(--radius-card)",
        panel: "var(--radius-panel)",
        pill: "var(--radius-pill)"
      },
      transitionDuration: {
        fast: "var(--duration-fast)",
        normal: "var(--duration-normal)"
      },
      transitionTimingFunction: {
        standard: "var(--easing-standard)"
      }
    }
  },
  plugins: []
};

export default config;

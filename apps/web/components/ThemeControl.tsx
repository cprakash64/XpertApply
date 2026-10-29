"use client";

import { useEffect, useLayoutEffect, useSyncExternalStore } from "react";
import { usePathname } from "next/navigation";
import { Monitor, Moon, Sun } from "lucide-react";
import {
  applyThemePreference,
  readThemePreference,
  setThemePreference,
  watchTheme,
  type ThemePreference
} from "@/lib/theme";

const OPTIONS: { value: ThemePreference; label: string; text: string; Icon: typeof Sun }[] = [
  { value: "light", label: "Light theme", text: "Light", Icon: Sun },
  { value: "system", label: "Match system theme", text: "System", Icon: Monitor },
  { value: "dark", label: "Dark theme", text: "Dark", Icon: Moon }
];

/**
 * A compact three-way theme control: light, system, dark.
 *
 * A radio group, because exactly one choice is always selected and the arrow
 * keys move between them. The server and the first client render both show
 * the default ("light") selected, then the stored choice is read after mount, so there is no
 * hydration mismatch; the page itself was already themed by theme-init.js.
 */
export function ThemeControl({ className = "", showLabels = false }: { className?: string; showLabels?: boolean }) {
  // The server snapshot is the default ("light"), so hydration matches; the stored choice
  // replaces it right after, and every control re-renders on a change event.
  const preference = useSyncExternalStore<ThemePreference>(
    (notify) => watchTheme(notify),
    readThemePreference,
    () => "light"
  );
  const choose = setThemePreference;

  return (
    <div role="radiogroup" aria-label="Theme" className={`theme-ctl ${showLabels ? "theme-ctl--labeled" : ""} ${className}`}>
      {OPTIONS.map(({ value, label, text, Icon }, index) => (
        <button
          key={value}
          type="button"
          role="radio"
          aria-checked={preference === value}
          aria-label={label}
          title={label}
          tabIndex={preference === value ? 0 : -1}
          className="theme-ctl__option ds-focus-ring"
          onClick={() => choose(value)}
          onKeyDown={(event) => {
            const step = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1
              : event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 0;
            if (!step) return;
            event.preventDefault();
            const next = OPTIONS[(index + step + OPTIONS.length) % OPTIONS.length].value;
            choose(next);
            (event.currentTarget.parentElement?.querySelector(`[aria-label="${OPTIONS.find((o) => o.value === next)?.label}"]`) as HTMLElement | null)?.focus();
          }}
        >
          <Icon aria-hidden width={15} height={15} />
          {/* The accessible name stays the aria-label above ("Light theme" contains the visible "Light"). */}
          {showLabels && <span aria-hidden="true">{text}</span>}
        </button>
      ))}
    </div>
  );
}

// useLayoutEffect on the client so a route change is themed before it paints;
// on the server there is nothing to do, so the effect variant avoids the warning.
const useIsomorphicLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

/**
 * Keeps data-theme correct across client-side navigation and OS or cross-tab
 * changes. The public website is always light and the signed-in app follows the
 * saved choice, so moving between them (log in, log out) must re-resolve the
 * theme; the saved choice itself is only read, never rewritten.
 */
export function ThemeSync() {
  const pathname = usePathname();
  useIsomorphicLayoutEffect(() => {
    applyThemePreference(readThemePreference(), pathname);
  }, [pathname]);
  useEffect(() => watchTheme(), []);
  return null;
}

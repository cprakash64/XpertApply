"use client";

import { useEffect, useSyncExternalStore } from "react";
import { Monitor, Moon, Sun } from "lucide-react";
import { readThemePreference, setThemePreference, watchTheme, type ThemePreference } from "@/lib/theme";

const OPTIONS: { value: ThemePreference; label: string; Icon: typeof Sun }[] = [
  { value: "light", label: "Light theme", Icon: Sun },
  { value: "system", label: "Match system theme", Icon: Monitor },
  { value: "dark", label: "Dark theme", Icon: Moon }
];

/**
 * A compact three-way theme control: light, system, dark.
 *
 * A radio group, because exactly one choice is always selected and the arrow
 * keys move between them. The server and the first client render both show
 * "system" selected, then the stored choice is read after mount, so there is no
 * hydration mismatch; the page itself was already themed by theme-init.js.
 */
export function ThemeControl({ className = "" }: { className?: string }) {
  // The server snapshot is "system", so hydration matches; the stored choice
  // replaces it right after, and every control re-renders on a change event.
  const preference = useSyncExternalStore<ThemePreference>(
    (notify) => watchTheme(notify),
    readThemePreference,
    () => "system"
  );
  const choose = setThemePreference;

  return (
    <div role="radiogroup" aria-label="Theme" className={`theme-ctl ${className}`}>
      {OPTIONS.map(({ value, label, Icon }, index) => (
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
        </button>
      ))}
    </div>
  );
}

/** Keeps the page in step with OS and cross-tab changes when no control is mounted. */
export function ThemeSync() {
  useEffect(() => watchTheme(), []);
  return null;
}

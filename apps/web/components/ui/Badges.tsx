import clsx from "clsx";

export type StatusTone = "neutral" | "info" | "success" | "warning" | "danger";

type StaticSpanProps = Omit<
  React.HTMLAttributes<HTMLSpanElement>,
  keyof React.DOMAttributes<HTMLSpanElement> | "role" | "tabIndex"
> & {
  children?: React.ReactNode;
};

const toneClasses: Record<StatusTone, string> = {
  neutral: "border-status-neutral-border bg-status-neutral-surface text-status-neutral",
  info: "border-status-info-border bg-status-info-surface text-status-info",
  success: "border-status-success-border bg-status-success-surface text-status-success",
  warning: "border-status-warning-border bg-status-warning-surface text-status-warning",
  danger: "border-status-danger-border bg-status-danger-surface text-status-danger"
};

export function Chip({
  selected = false,
  className,
  disabled,
  type = "button",
  ...props
}: Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "aria-pressed"> & { selected?: boolean }) {
  return (
    <button
      type={type}
      aria-pressed={selected}
      disabled={disabled}
      className={clsx(
        "ds-focus-ring ds-touch-target inline-flex h-9 items-center rounded-pill border px-3 text-sm font-medium transition duration-fast ease-standard disabled:pointer-events-none",
        selected
          ? "border-line-selected bg-surface-selected text-foreground-link"
          : "border-line-default bg-surface-card text-foreground-secondary hover:border-line-interactive hover:bg-surface-subtle",
        className
      )}
      {...props}
    />
  );
}

export function Tag({ className, ...props }: StaticSpanProps) {
  return (
    <span
      className={clsx(
        "inline-flex items-center rounded-pill border border-line-default bg-surface-subtle px-2.5 py-1 text-xs font-medium text-foreground-secondary",
        className
      )}
      {...props}
    />
  );
}

export function StatusBadge({
  tone = "neutral",
  className,
  ...props
}: StaticSpanProps & { tone?: StatusTone }) {
  return (
    <span
      className={clsx(
        "inline-flex items-center rounded-pill border px-2.5 py-1 text-xs font-semibold",
        toneClasses[tone],
        className
      )}
      {...props}
    />
  );
}

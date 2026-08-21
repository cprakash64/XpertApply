import clsx from "clsx";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "destructive";
export type ButtonSize = "sm" | "md" | "lg" | "icon";

type SharedButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  loading?: boolean;
  ref?: React.Ref<HTMLButtonElement>;
};

export type ButtonProps = SharedButtonProps &
  (
    | { size: "icon"; "aria-label": string }
    | { size?: Exclude<ButtonSize, "icon"> }
  );

const variantClasses: Record<ButtonVariant, string> = {
  primary:
    "bg-action-primary text-action-primary-foreground shadow-subtle hover:bg-action-primary-hover active:translate-y-px",
  secondary:
    "border border-action-secondary-border bg-action-secondary text-action-secondary-foreground hover:bg-action-ghost-hover active:bg-surface-subtle",
  ghost:
    "bg-transparent text-action-ghost-foreground hover:bg-action-ghost-hover hover:text-foreground active:bg-surface-subtle",
  destructive:
    "bg-action-destructive text-action-destructive-foreground shadow-subtle hover:bg-action-destructive-hover active:translate-y-px"
};

const sizeClasses: Record<ButtonSize, string> = {
  sm: "h-9 px-3 text-sm",
  md: "h-10 px-4 text-sm",
  lg: "h-11 px-5 text-sm",
  icon: "h-10 w-10 p-0"
};

/**
 * The product's only button. The pre-migration `components/Button` adapter —
 * a green-fill primary with no destructive/ghost roles — was retired once its
 * last call site moved here; `__tests__/design-system-contracts.test.ts` keeps
 * it from coming back.
 */
export function Button({
  children,
  className,
  variant = "primary",
  size = "md",
  loading = false,
  disabled,
  type = "button",
  "aria-busy": ariaBusy,
  ...props
}: ButtonProps) {
  return (
    <button
      type={type}
      className={clsx(
        "ds-focus-ring ds-touch-target inline-flex shrink-0 items-center justify-center gap-2 rounded-control font-semibold transition duration-fast ease-standard disabled:pointer-events-none disabled:shadow-none",
        variantClasses[variant],
        sizeClasses[size],
        className
      )}
      disabled={disabled || loading}
      {...props}
      aria-busy={loading || ariaBusy || undefined}
    >
      {children}
    </button>
  );
}

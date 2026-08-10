import clsx from "clsx";

export function Button({
  children,
  className,
  variant = "primary",
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "danger";
  /** React 19 passes `ref` as an ordinary prop; declaring it lets callers that
   * need to move focus here (e.g. a dialog's default action) do so. */
  ref?: React.Ref<HTMLButtonElement>;
}) {
  return (
    <button
      className={clsx(
        "focus-ring inline-flex h-10 items-center justify-center gap-2 rounded-md px-4 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-50",
        variant === "primary" && "bg-pine text-white hover:bg-[var(--accent-hover)]",
        variant === "secondary" && "border border-line bg-white text-ink hover:bg-panel",
        variant === "danger" && "bg-coral text-white hover:bg-[var(--danger)]",
        className
      )}
      {...props}
    >
      {children}
    </button>
  );
}


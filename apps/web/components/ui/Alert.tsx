import clsx from "clsx";
import { CircleCheck, CircleX, Info, TriangleAlert } from "lucide-react";
import type { StatusTone } from "./Badges";

type AlertTone = Exclude<StatusTone, "neutral">;

const toneClasses: Record<AlertTone, string> = {
  info: "border-status-info-border bg-status-info-surface text-status-info",
  success: "border-status-success-border bg-status-success-surface text-status-success",
  warning: "border-status-warning-border bg-status-warning-surface text-status-warning",
  danger: "border-status-danger-border bg-status-danger-surface text-status-danger"
};

const icons = {
  info: Info,
  success: CircleCheck,
  warning: TriangleAlert,
  danger: CircleX
} satisfies Record<AlertTone, typeof Info>;

export function Alert({
  tone = "info",
  title,
  children,
  className,
  role,
  ...props
}: React.HTMLAttributes<HTMLDivElement> & {
  tone?: AlertTone;
  title?: React.ReactNode;
}) {
  const Icon = icons[tone];
  return (
    <div
      role={role ?? (tone === "danger" ? "alert" : "status")}
      className={clsx("flex gap-3 rounded-field border p-4 text-sm", toneClasses[tone], className)}
      {...props}
    >
      <Icon aria-hidden="true" className="mt-0.5 h-5 w-5 shrink-0" />
      <div className="min-w-0">
        {title ? <p className="font-semibold">{title}</p> : null}
        <div className={clsx(title && "mt-1")}>{children}</div>
      </div>
    </div>
  );
}

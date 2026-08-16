import clsx from "clsx";

export type CardVariant = "standard" | "interactive" | "raised" | "subtle";

type StaticCardProps = Omit<
  React.HTMLAttributes<HTMLDivElement>,
  keyof React.DOMAttributes<HTMLDivElement> | "role" | "tabIndex"
> & {
  children?: React.ReactNode;
};

export function Card({
  variant = "standard",
  className,
  ...props
}: StaticCardProps & { variant?: CardVariant }) {
  return (
    <div
      className={clsx(
        "rounded-card border p-5 text-foreground",
        variant === "standard" && "border-line-default bg-surface-card",
        variant === "interactive" &&
          "border-line-default bg-surface-card transition duration-normal ease-standard hover:-translate-y-px hover:border-line-interactive hover:shadow-raised has-[:focus-visible]:border-line-selected has-[:focus-visible]:shadow-raised",
        variant === "raised" && "border-line-subtle bg-surface-raised shadow-raised",
        variant === "subtle" && "border-line-subtle bg-surface-subtle",
        className
      )}
      {...props}
    />
  );
}

"use client";

import clsx from "clsx";
import { useId } from "react";

type FieldChromeProps = {
  label?: React.ReactNode;
  error?: React.ReactNode;
  hint?: React.ReactNode;
  required?: boolean;
  className?: string;
};

const controlClasses =
  "ds-field ds-focus-ring w-full rounded-field border border-line-interactive bg-surface-card px-3 text-sm text-foreground placeholder:text-foreground-muted transition duration-fast ease-standard hover:border-line-strong disabled:border-line-default disabled:bg-surface-subtle disabled:text-foreground-disabled read-only:bg-surface-subtle";

function describedBy(
  callerValue: string | undefined,
  generatedValue: string | undefined
): string | undefined {
  return [callerValue, generatedValue].filter(Boolean).join(" ") || undefined;
}

function FieldChrome({
  id,
  label,
  error,
  hint,
  required,
  children,
  className
}: FieldChromeProps & { id: string; children: React.ReactNode }) {
  return (
    <div className={clsx("min-w-0", className)}>
      {label ? (
        <label htmlFor={id} className="block text-sm font-medium text-foreground">
          {label}
          {required ? <span aria-hidden="true"> *</span> : null}
        </label>
      ) : null}
      {children}
      {error ? (
        <p id={`${id}-error`} className="mt-1 text-xs text-status-danger">
          <span className="sr-only">Error: </span>
          {error}
        </p>
      ) : hint ? (
        <p id={`${id}-hint`} className="mt-1 text-xs text-foreground-muted">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

export type InputProps = Omit<React.InputHTMLAttributes<HTMLInputElement>, "size"> &
  FieldChromeProps & {
    ref?: React.Ref<HTMLInputElement>;
  };

export function Input({
  label,
  error,
  hint,
  required,
  className,
  id: suppliedId,
  "aria-describedby": ariaDescribedBy,
  "aria-invalid": ariaInvalid,
  ref,
  ...props
}: InputProps) {
  const generatedId = useId();
  const id = suppliedId ?? generatedId;
  const messageId = error ? `${id}-error` : hint ? `${id}-hint` : undefined;
  return (
    <FieldChrome id={id} label={label} error={error} hint={hint} required={required}>
      <input
        ref={ref}
        id={id}
        required={required}
        aria-describedby={describedBy(ariaDescribedBy, messageId)}
        className={clsx(controlClasses, "h-10", label && "mt-1.5", className)}
        {...props}
        aria-invalid={error ? true : ariaInvalid}
      />
    </FieldChrome>
  );
}

export type TextareaProps = React.TextareaHTMLAttributes<HTMLTextAreaElement> &
  FieldChromeProps & {
    ref?: React.Ref<HTMLTextAreaElement>;
  };

export function Textarea({
  label,
  error,
  hint,
  required,
  className,
  id: suppliedId,
  "aria-describedby": ariaDescribedBy,
  "aria-invalid": ariaInvalid,
  ref,
  ...props
}: TextareaProps) {
  const generatedId = useId();
  const id = suppliedId ?? generatedId;
  const messageId = error ? `${id}-error` : hint ? `${id}-hint` : undefined;
  return (
    <FieldChrome id={id} label={label} error={error} hint={hint} required={required}>
      <textarea
        ref={ref}
        id={id}
        required={required}
        aria-describedby={describedBy(ariaDescribedBy, messageId)}
        className={clsx(controlClasses, "min-h-24 py-2", label && "mt-1.5", className)}
        {...props}
        aria-invalid={error ? true : ariaInvalid}
      />
    </FieldChrome>
  );
}

export type SelectProps = React.SelectHTMLAttributes<HTMLSelectElement> &
  FieldChromeProps & {
    ref?: React.Ref<HTMLSelectElement>;
  };

export function Select({
  label,
  error,
  hint,
  required,
  className,
  id: suppliedId,
  "aria-describedby": ariaDescribedBy,
  "aria-invalid": ariaInvalid,
  ref,
  children,
  ...props
}: SelectProps) {
  const generatedId = useId();
  const id = suppliedId ?? generatedId;
  const messageId = error ? `${id}-error` : hint ? `${id}-hint` : undefined;
  return (
    <FieldChrome id={id} label={label} error={error} hint={hint} required={required}>
      <select
        ref={ref}
        id={id}
        required={required}
        aria-describedby={describedBy(ariaDescribedBy, messageId)}
        className={clsx(controlClasses, "h-10", label && "mt-1.5", className)}
        {...props}
        aria-invalid={error ? true : ariaInvalid}
      >
        {children}
      </select>
    </FieldChrome>
  );
}

"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ArrowRight, Eye, EyeOff, Loader2 } from "lucide-react";
import { API_URL, ApiError, api } from "@/lib/api";
import { BrandLogo } from "@/components/BrandLogo";

/**
 * Password recovery: the "Forgot password?" request page and the reset page.
 *
 * Both are public pages, so they are always light (see lib/theme.ts). They reuse
 * the sign-in card's geometry and field styles and add nothing decorative.
 *
 * Security notes that shape this file:
 *  - The request page never says whether an address has an account: success is
 *    the same sentence for every address.
 *  - The reset token arrives in the URL FRAGMENT (`#token=...`). It is read once,
 *    removed from the address bar with history.replaceState, and held only in
 *    memory: never in storage, never in a query string, never sent anywhere but
 *    the two API calls that need it.
 *  - If the server says recovery is unavailable (no email delivery configured),
 *    the page says so instead of showing a form that could not work.
 */

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD = 10;
const MAX_PASSWORD = 128;

const fieldClass =
  "auth-input ds-field mt-2 h-12 w-full rounded-field border border-line-default px-4 text-sm text-foreground";
const primaryButtonClass =
  "ds-focus-ring mt-6 flex h-12 w-full items-center justify-center gap-2 rounded-field bg-action-primary px-5 text-sm font-semibold text-action-primary-foreground shadow-subtle transition duration-fast ease-standard hover:bg-action-primary-hover disabled:opacity-70";
const linkClass = "ds-focus-ring rounded-control px-1 py-0.5 font-semibold text-foreground-link";

function RecoveryCard({ title, intro, children }: { title: string; intro?: string; children: React.ReactNode }) {
  return (
    <main className="grid min-h-screen place-items-center px-4 py-10">
      <section className="auth-dialog w-full max-w-[480px] overflow-hidden rounded-panel" aria-labelledby="recovery-title">
        <div className="px-7 pb-5 pt-7 sm:px-9 sm:pt-9">
          <Link href="/" prefetch={false} className="ds-focus-ring -m-1 inline-flex items-center rounded-control p-1">
            <BrandLogo size={44} />
          </Link>
          <h1 id="recovery-title" tabIndex={-1} className="mt-7 text-3xl font-semibold tracking-[-0.04em] outline-none">
            {title}
          </h1>
          {intro && <p className="mt-2 text-sm text-foreground-muted">{intro}</p>}
        </div>
        <div className="px-7 pb-7 sm:px-9 sm:pb-9">{children}</div>
      </section>
    </main>
  );
}

function BackToSignIn({ className = "mt-5" }: { className?: string }) {
  return (
    <p className={`${className} text-center text-sm text-foreground-muted`}>
      <Link href="/login" prefetch={false} className={linkClass}>
        Back to sign in
      </Link>
    </p>
  );
}

function PasswordField({
  id,
  label,
  toggleName,
  value,
  onChange,
  error,
  describedBy,
  inputRef,
  autoFocus
}: {
  id: string;
  label: string;
  /** What the show/hide button names, e.g. "new password" (kept distinct from the field label). */
  toggleName: string;
  value: string;
  onChange: (value: string) => void;
  error?: string;
  describedBy?: string;
  inputRef?: React.Ref<HTMLInputElement>;
  autoFocus?: boolean;
}) {
  const [visible, setVisible] = useState(false);
  return (
    <div>
      <label className="block text-sm font-medium" htmlFor={id}>
        {label}
      </label>
      <div className="relative">
        <input
          ref={inputRef}
          id={id}
          name={id}
          className={`${fieldClass} pr-12`}
          type={visible ? "text" : "password"}
          autoComplete="new-password"
          autoFocus={autoFocus}
          required
          value={value}
          aria-invalid={error ? "true" : undefined}
          aria-describedby={[error ? `${id}-error` : "", describedBy ?? ""].filter(Boolean).join(" ") || undefined}
          onChange={(event) => onChange(event.target.value)}
        />
        <button
          type="button"
          className="ds-focus-ring absolute bottom-0 right-0 grid h-12 w-12 place-items-center rounded-r-field text-foreground-muted transition duration-fast ease-standard hover:text-foreground"
          onClick={() => setVisible((v) => !v)}
          aria-label={visible ? `Hide ${toggleName}` : `Show ${toggleName}`}
          aria-pressed={visible}
        >
          {visible ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
        </button>
      </div>
      {error && (
        <p id={`${id}-error`} className="mt-2 text-sm text-status-danger" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

function FormError({ message, innerRef }: { message: string; innerRef: React.Ref<HTMLParagraphElement> }) {
  if (!message) return null;
  return (
    <p
      ref={innerRef}
      tabIndex={-1}
      role="alert"
      className="mb-4 break-words rounded-field border border-status-danger-border bg-status-danger-surface px-3 py-2.5 text-sm text-status-danger"
    >
      {message}
    </p>
  );
}

function rateLimitMessage() {
  return "Too many attempts. Please wait a few minutes and try again.";
}

/* ------------------------------------------------------------------------- */
/* Request a reset link                                                      */
/* ------------------------------------------------------------------------- */
type Availability = "checking" | "available" | "unavailable";

export function ForgotPasswordForm() {
  const [availability, setAvailability] = useState<Availability>("checking");
  const [email, setEmail] = useState("");
  const [fieldError, setFieldError] = useState("");
  const [formError, setFormError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const emailRef = useRef<HTMLInputElement>(null);
  const formErrorRef = useRef<HTMLParagraphElement>(null);
  const sentRef = useRef<HTMLHeadingElement>(null);
  const submittingRef = useRef(false);

  useEffect(() => {
    let active = true;
    void fetch(`${API_URL}/auth/password-reset/availability`)
      .then((response) => response.json() as Promise<{ available?: boolean }>)
      // An unreachable check is not proof of unavailability: show the form, and let
      // the submit report a real network failure.
      .then((result) => { if (active) setAvailability(result.available === false ? "unavailable" : "available"); })
      .catch(() => { if (active) setAvailability("available"); });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (sentTo) sentRef.current?.focus();
  }, [sentTo]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (submittingRef.current) return;
    const address = email.trim();
    if (!address) return fail("Enter your email address.");
    if (!EMAIL_PATTERN.test(address)) return fail("Enter a valid email address.");
    submittingRef.current = true;
    setFieldError("");
    setFormError("");
    setSubmitting(true);
    try {
      await api("/auth/password-reset/request", { method: "POST", body: JSON.stringify({ email: address }) });
      setSentTo(address);
    } catch (cause) {
      const apiError = cause instanceof ApiError ? cause : null;
      if (apiError?.status === 503) setAvailability("unavailable");
      else if (apiError?.status === 429) showFormError(rateLimitMessage());
      else if (apiError?.status === 422 || apiError?.code === "validation") fail("Enter a valid email address.");
      else if (apiError?.code === "network_unreachable")
        showFormError("We couldn't reach XpertApply. Check your connection and try again.");
      else showFormError("We couldn't send the link. Please try again.");
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

  function fail(message: string) {
    setFormError("");
    setFieldError(message);
    window.requestAnimationFrame(() => emailRef.current?.focus());
  }

  function showFormError(message: string) {
    setFieldError("");
    setFormError(message);
    window.requestAnimationFrame(() => formErrorRef.current?.focus());
  }

  if (availability === "unavailable") {
    return (
      <RecoveryCard title="Password recovery is unavailable">
        <p className="text-sm text-foreground-muted" role="status">
          We can&rsquo;t send password reset emails right now. Please try again later.
        </p>
        <BackToSignIn className="mt-6" />
      </RecoveryCard>
    );
  }

  if (sentTo) {
    return (
      <RecoveryCard title="Check your email">
        <div role="status">
          <h2 ref={sentRef} tabIndex={-1} className="sr-only">
            Reset link requested
          </h2>
          <p className="text-sm text-foreground-secondary">
            If an account exists for <strong className="break-all font-semibold text-foreground">{sentTo}</strong>, we&rsquo;ve
            sent a link to reset its password. The link works once and expires in 30 minutes.
          </p>
          <p className="mt-3 text-sm text-foreground-muted">Nothing arrived? Check your spam folder, or try again.</p>
        </div>
        <button
          type="button"
          className="ds-focus-ring mt-6 flex h-12 w-full items-center justify-center rounded-field border border-line-default bg-surface-card px-5 text-sm font-semibold text-foreground transition duration-fast ease-standard hover:bg-surface-subtle"
          onClick={() => setSentTo(null)}
        >
          Use a different email
        </button>
        <BackToSignIn />
      </RecoveryCard>
    );
  }

  return (
    <RecoveryCard title="Forgot your password?" intro="Enter your email and we'll send you a link to choose a new one.">
      <form onSubmit={submit} noValidate>
        <FormError message={formError} innerRef={formErrorRef} />
        <label className="block text-sm font-medium" htmlFor="recovery-email">
          Email address
        </label>
        <input
          ref={emailRef}
          id="recovery-email"
          name="email"
          className={fieldClass}
          type="email"
          inputMode="email"
          autoComplete="email"
          autoFocus
          required
          value={email}
          aria-invalid={fieldError ? "true" : undefined}
          aria-describedby={fieldError ? "recovery-email-error" : undefined}
          onChange={(event) => {
            setEmail(event.target.value);
            if (fieldError) setFieldError("");
          }}
        />
        {fieldError && (
          <p id="recovery-email-error" className="mt-2 text-sm text-status-danger" role="alert">
            {fieldError}
          </p>
        )}
        <button className={primaryButtonClass} type="submit" disabled={submitting}>
          {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowRight className="h-4 w-4" />}
          {submitting ? "Sending…" : "Send reset link"}
        </button>
        <BackToSignIn />
      </form>
    </RecoveryCard>
  );
}

/* ------------------------------------------------------------------------- */
/* Choose a new password                                                     */
/* ------------------------------------------------------------------------- */
type ResetState = "checking" | "ready" | "invalid" | "done";

function readFragmentToken(): string | null {
  const match = /(?:^#|&)token=([A-Za-z0-9_-]+)/.exec(window.location.hash);
  return match ? match[1] : null;
}

export function ResetPasswordForm() {
  const [state, setState] = useState<ResetState>("checking");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [errors, setErrors] = useState<{ password?: string; confirm?: string }>({});
  const [formError, setFormError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  // In memory only. A ref survives the dev-mode double effect, which would
  // otherwise find the fragment already removed.
  const tokenRef = useRef<string | null>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const confirmRef = useRef<HTMLInputElement>(null);
  const formErrorRef = useRef<HTMLParagraphElement>(null);
  const submittingRef = useRef(false);

  useEffect(() => {
    if (tokenRef.current === null) {
      tokenRef.current = readFragmentToken();
      if (tokenRef.current) {
        // Take the credential out of the address bar, history and any later Referer.
        window.history.replaceState(null, "", window.location.pathname);
      }
    }
    const token = tokenRef.current;
    if (!token) {
      setState("invalid");
      return;
    }
    let active = true;
    void api<{ valid: boolean }>("/auth/password-reset/verify", { method: "POST", body: JSON.stringify({ token }) })
      .then((result) => { if (active) setState(result.valid ? "ready" : "invalid"); })
      // Could not check (offline, server error): let the person try; submit reports the truth.
      .catch(() => { if (active) setState("ready"); });
    return () => { active = false; };
  }, []);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (submittingRef.current || !tokenRef.current) return;
    const next: { password?: string; confirm?: string } = {};
    if (password.length < MIN_PASSWORD) next.password = `Password must be at least ${MIN_PASSWORD} characters.`;
    else if (password.length > MAX_PASSWORD) next.password = `Password must be at most ${MAX_PASSWORD} characters.`;
    if (!next.password && confirm !== password) next.confirm = "The passwords don't match.";
    if (next.password || next.confirm) {
      setFormError("");
      setErrors(next);
      window.requestAnimationFrame(() => (next.password ? passwordRef : confirmRef).current?.focus());
      return;
    }
    submittingRef.current = true;
    setErrors({});
    setFormError("");
    setSubmitting(true);
    try {
      await api("/auth/password-reset/confirm", {
        method: "POST",
        body: JSON.stringify({ token: tokenRef.current, new_password: password })
      });
      tokenRef.current = null;
      setPassword("");
      setConfirm("");
      setState("done");
    } catch (cause) {
      const apiError = cause instanceof ApiError ? cause : null;
      if (apiError?.status === 400) {
        tokenRef.current = null;
        setState("invalid");
      } else if (apiError?.status === 429) {
        showFormError(rateLimitMessage());
      } else if (apiError?.status === 422 || apiError?.code === "validation") {
        setErrors({ password: "Choose a different password: at least 10 characters, and not your email address." });
        window.requestAnimationFrame(() => passwordRef.current?.focus());
      } else if (apiError?.code === "network_unreachable") {
        showFormError("We couldn't reach XpertApply. Check your connection and try again.");
      } else {
        showFormError("We couldn't update your password. Please try again.");
      }
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

  function showFormError(message: string) {
    setFormError(message);
    window.requestAnimationFrame(() => formErrorRef.current?.focus());
  }

  if (state === "checking") {
    return (
      <RecoveryCard title="Reset your password">
        <p className="flex items-center gap-2 text-sm text-foreground-muted" role="status">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Checking your link…
        </p>
      </RecoveryCard>
    );
  }

  if (state === "invalid") {
    return (
      <RecoveryCard title="This link can't be used">
        <p className="text-sm text-foreground-secondary" role="status">
          This reset link is invalid, has expired, or has already been used. Request a new one to continue.
        </p>
        <Link
          href="/forgot-password"
          prefetch={false}
          className="ds-focus-ring mt-6 flex h-12 w-full items-center justify-center gap-2 rounded-field bg-action-primary px-5 text-sm font-semibold text-action-primary-foreground shadow-subtle transition duration-fast ease-standard hover:bg-action-primary-hover"
        >
          Request a new link
        </Link>
        <BackToSignIn />
      </RecoveryCard>
    );
  }

  if (state === "done") {
    return (
      <RecoveryCard title="Password updated">
        <p className="text-sm text-foreground-secondary" role="status">
          Your password has been changed. Sign in with your new password. Any other device signed in to this account
          will need to sign in again.
        </p>
        <Link
          href="/login"
          prefetch={false}
          className="ds-focus-ring mt-6 flex h-12 w-full items-center justify-center gap-2 rounded-field bg-action-primary px-5 text-sm font-semibold text-action-primary-foreground shadow-subtle transition duration-fast ease-standard hover:bg-action-primary-hover"
        >
          Go to sign in
          <ArrowRight className="h-4 w-4" aria-hidden />
        </Link>
      </RecoveryCard>
    );
  }

  return (
    <RecoveryCard title="Choose a new password">
      <form onSubmit={submit} noValidate>
        <FormError message={formError} innerRef={formErrorRef} />
        <PasswordField
          id="new-password"
          label="New password"
          toggleName="new password"
          value={password}
          onChange={(value) => {
            setPassword(value);
            if (errors.password) setErrors((current) => ({ ...current, password: undefined }));
          }}
          error={errors.password}
          describedBy="new-password-help"
          inputRef={passwordRef}
          autoFocus
        />
        <p id="new-password-help" className="mt-2 text-xs text-foreground-muted">
          {`Use at least ${MIN_PASSWORD} characters. Don’t use your email address.`}
        </p>
        <div className="mt-5">
          <PasswordField
            id="confirm-password"
            label="Confirm new password"
            toggleName="password confirmation"
            value={confirm}
            onChange={(value) => {
              setConfirm(value);
              if (errors.confirm) setErrors((current) => ({ ...current, confirm: undefined }));
            }}
            error={errors.confirm}
            inputRef={confirmRef}
          />
        </div>
        <button className={primaryButtonClass} type="submit" disabled={submitting}>
          {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowRight className="h-4 w-4" />}
          {submitting ? "Updating…" : "Update password"}
        </button>
        <BackToSignIn />
      </form>
    </RecoveryCard>
  );
}

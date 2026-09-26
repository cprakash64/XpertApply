import { ApiError } from "@/lib/api";

export type AuthErrorCategory =
  | "field_validation"
  | "authentication_failure"
  | "rate_limit"
  | "expired_flow"
  | "network_failure"
  | "provider_failure"
  | "account_link_failure"
  | "unexpected_failure";

export type AuthErrorContext = "login" | "signup" | "google" | "link";

export type AuthUiError = {
  category: AuthErrorCategory;
  fieldErrors: Record<string, string>;
  formError?: string;
};

const GOOGLE_CALLBACK_MESSAGES: Record<string, AuthUiError> = {
  GOOGLE_AUTH_CANCELLED: error("provider_failure", "Google sign-in was cancelled."),
  GOOGLE_SESSION_EXPIRED: error("expired_flow", "Your Google sign-in session expired. Please try again."),
  GOOGLE_EMAIL_UNVERIFIED: error("provider_failure", "We couldn't sign you in with Google. Please try again."),
  GOOGLE_TOKEN_INVALID: error("provider_failure", "We couldn't sign you in with Google. Please try again."),
  GOOGLE_PROVIDER_CONFLICT: error("provider_failure", "We couldn't sign you in with Google. Please try again."),
  GOOGLE_AUTH_UNAVAILABLE: error("provider_failure", "Google sign-in is currently unavailable."),
  OAUTH_TEMPORARY_FAILURE: error("provider_failure", "Google sign-in is temporarily unavailable. Please try again.")
};

function error(category: AuthErrorCategory, formError: string): AuthUiError {
  return { category, fieldErrors: {}, formError };
}

function safeValidationFields(context: AuthErrorContext, apiError: ApiError): Record<string, string> {
  const fields: Record<string, string> = {};
  if (apiError.fieldErrors.email) fields.email = "Enter a valid email address.";
  if (apiError.fieldErrors.password) {
    fields.password = context === "signup"
      ? "Password must be at least 10 characters."
      : "Enter your password.";
  }
  return fields;
}

export function validatePasswordAuth(
  context: "login" | "signup",
  email: string,
  password: string
): AuthUiError | null {
  const fieldErrors: Record<string, string> = {};
  if (!email.trim()) fieldErrors.email = "Enter your email address.";
  else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fieldErrors.email = "Enter a valid email address.";
  if (!password) fieldErrors.password = context === "signup" ? "Create a password." : "Enter your password.";
  else if (context === "signup" && password.length < 10) fieldErrors.password = "Password must be at least 10 characters.";
  return Object.keys(fieldErrors).length
    ? { category: "field_validation", fieldErrors }
    : null;
}

export function googleCallbackError(code: string): AuthUiError {
  return GOOGLE_CALLBACK_MESSAGES[code] ?? error("provider_failure", "We couldn't sign you in with Google. Please try again.");
}

export function mapAuthError(context: AuthErrorContext, cause: unknown): AuthUiError {
  const apiError = cause instanceof ApiError ? cause : null;

  if (apiError?.code === "network_unreachable") {
    if (context === "login") return error("network_failure", "We couldn't sign you in. Check your connection and try again.");
    if (context === "signup") return error("network_failure", "We couldn't create your account. Check your connection and try again.");
    if (context === "link") return error("network_failure", "We couldn't connect Google to this account. Check your connection and try again.");
    return error("network_failure", "We couldn't sign you in with Google. Check your connection and try again.");
  }

  if (apiError?.status === 429 || apiError?.code === "rate_limited") {
    return context === "link"
      ? error("rate_limit", "Too many attempts. Please wait and try again.")
      : context === "login"
        ? error("rate_limit", "Too many sign-in attempts. Please wait a few minutes and try again.")
        : error("rate_limit", context === "signup"
          ? "Too many attempts. Please wait a few minutes and try again."
          : "Google sign-in is temporarily unavailable. Please try again.");
  }

  if (context === "login" && apiError?.status === 401) {
    return error("authentication_failure", "Email or password is incorrect. Please try again.");
  }

  if (context === "signup" && apiError?.status === 409) {
    return error("authentication_failure", "We couldn't create this account. Try signing in instead.");
  }

  if (apiError?.code === "validation" && (context === "login" || context === "signup")) {
    const fieldErrors = safeValidationFields(context, apiError);
    return Object.keys(fieldErrors).length
      ? { category: "field_validation", fieldErrors }
      : error("field_validation", context === "login"
        ? "We couldn't sign you in. Check your details and try again."
        : "We couldn't create your account. Check your details and try again.");
  }

  if (context === "link") {
    if (apiError?.serverCode === "GOOGLE_LINK_EXPIRED") {
      return error("expired_flow", "This Google connection request expired. Start Google sign-in again.");
    }
    if (apiError?.status === 401 && apiError.serverCode === "GOOGLE_LINK_INVALID") {
      return error("account_link_failure", "Wrong password, please try again.");
    }
    if (apiError?.serverCode === "GOOGLE_PROVIDER_CONFLICT") {
      return error("account_link_failure", "We couldn't connect Google to this account. Please sign in again and retry.");
    }
    return error("account_link_failure", "We couldn't connect Google to this account. Please sign in again and retry.");
  }

  if (context === "google") {
    if (apiError?.serverCode) return googleCallbackError(apiError.serverCode);
    if (cause instanceof Error && cause.message.includes("session is missing")) {
      return error("expired_flow", "Your Google sign-in session expired. Please try again.");
    }
    return error("provider_failure", "We couldn't sign you in with Google. Please try again.");
  }

  return error("unexpected_failure", context === "login"
    ? "We couldn't sign you in. Please try again."
    : "We couldn't create your account. Please try again.");
}

import type { Metadata } from "next";
import { ForgotPasswordForm } from "@/components/PasswordRecovery";
import { publicViewport } from "@/lib/publicViewport";

/** The public website is always light. */
export const viewport = publicViewport;

export const metadata: Metadata = {
  title: "Forgot password",
  robots: { index: false, follow: false },
  referrer: "no-referrer"
};

export default function ForgotPasswordPage() {
  return <ForgotPasswordForm />;
}

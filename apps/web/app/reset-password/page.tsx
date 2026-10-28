import type { Metadata } from "next";
import { ResetPasswordForm } from "@/components/PasswordRecovery";
import { publicViewport } from "@/lib/publicViewport";

/** The public website is always light. */
export const viewport = publicViewport;

export const metadata: Metadata = {
  title: "Reset password",
  robots: { index: false, follow: false },
  // The reset link carries a credential: never let it travel in a Referer header.
  referrer: "no-referrer"
};

export default function ResetPasswordPage() {
  return <ResetPasswordForm />;
}

import { AuthDialog } from "@/components/AuthDialog";
import { publicViewport } from "@/lib/publicViewport";

/** The public website is always light. */
export const viewport = publicViewport;

export default function SignupPage() {
  return <AuthDialog initialMode="signup" presentation="page" />;
}

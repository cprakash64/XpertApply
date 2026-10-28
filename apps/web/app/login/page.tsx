import { AuthDialog } from "@/components/AuthDialog";
import { publicViewport } from "@/lib/publicViewport";

/** The public website is always light. */
export const viewport = publicViewport;

export default function LoginPage() {
  return <AuthDialog initialMode="login" presentation="page" />;
}

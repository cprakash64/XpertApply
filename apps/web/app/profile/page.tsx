import { AppShell } from "@/components/AppShell";
import { ProfileOverview } from "@/components/profile/ProfileOverview";

/**
 * /profile is the Profile overview — a summary you can skim, with an Edit
 * action per section. The 10-step wizard is no longer the default management
 * UI; it still runs first-time onboarding (handled inside ProfileOverview when
 * there is nothing to summarize) and still backs every focused editor route.
 *
 * The optional EEO section is deliberately not surfaced here. It lives at
 * /profile/eeo, so voluntary demographic answers are never displayed alongside
 * the career information the user shares with employers.
 */
export default function ProfilePage() {
  return (
    <AppShell>
      <ProfileOverview />
    </AppShell>
  );
}

import { AppShell } from "@/components/AppShell";
import { ApplicationAccounts } from "@/components/ApplicationAccounts";
import { PrivacyControls } from "@/components/PrivacyControls";

export default function SettingsPage() {
  return (
    <AppShell>
      <header className="mb-6">
        <h1 className="text-3xl font-semibold">Settings and data controls</h1>
        <p className="mt-2 text-[var(--text-muted)]">
          Employer account credentials, data export, and account deletion.
        </p>
      </header>
      {/* Credentials live here rather than on the profile: they are secrets used
        * to sign in on your behalf, not career information. */}
      <ApplicationAccounts />
      <div className="mt-8">
        <PrivacyControls />
      </div>
    </AppShell>
  );
}

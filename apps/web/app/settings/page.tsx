import { AppShell } from "@/components/AppShell";
import { ApplicationAccounts } from "@/components/ApplicationAccounts";
import { PrivacyControls } from "@/components/PrivacyControls";
import { ThemeControl } from "@/components/ThemeControl";

export default function SettingsPage() {
  return (
    <AppShell>
      <header className="mb-6">
        <h1 className="text-3xl font-semibold tracking-[-0.035em] text-foreground sm:text-4xl">Settings and data controls</h1>
        <p className="mt-2 text-foreground-muted">
          Employer account credentials, data export, and account deletion.
        </p>
      </header>
      <section aria-labelledby="appearance-title" className="mb-8">
        <h2 id="appearance-title" className="text-xl font-semibold tracking-tight text-foreground">Appearance</h2>
        <p className="mt-1 text-sm text-foreground-muted">
          Light, dark, or match your device. Applies across XpertApply on this browser.
        </p>
        <ThemeControl className="mt-4" showLabels />
      </section>
      {/* Credentials live here rather than on the profile: they are secrets used
        * to sign in on your behalf, not career information. */}
      <ApplicationAccounts />
      <div className="mt-8">
        <PrivacyControls />
      </div>
    </AppShell>
  );
}

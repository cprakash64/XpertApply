import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { AppShell } from "@/components/AppShell";
import { SectionEditor } from "@/components/profile/editors/SectionEditor";

/**
 * The single authoritative home for application-time answers.
 *
 * A static segment, so it takes precedence over the `[section]` dynamic route
 * that serves the career editors. The body goes through `SectionEditor` like
 * every other section, which is what gives it the shared unsaved-changes guard
 * instead of a second implementation.
 */
export default function ApplicationPreferencesPage() {
  return (
    <AppShell>
      <header className="mb-6">
        <Link
          href="/profile"
          className="focus-ring inline-flex items-center gap-1.5 text-sm font-medium text-[var(--text-muted)] transition hover:text-pine"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden /> Back to profile
        </Link>
        <h1 className="mt-3 text-3xl font-semibold tracking-[-0.03em]">Application preferences</h1>
        <p className="mt-2 max-w-2xl text-[var(--text-muted)]">
          Answers XpertApply can reuse when filling applications. Employer account passwords are
          kept in Settings, not here.
        </p>
      </header>
      <SectionEditor section="application-preferences" />
    </AppShell>
  );
}

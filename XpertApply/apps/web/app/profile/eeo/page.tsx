import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { AppShell } from "@/components/AppShell";
import { DemographicsForm } from "@/components/DemographicsForm";

/**
 * Voluntary demographic information, on its own page.
 *
 * Kept off both the Profile overview and the primary Application-preferences
 * editor so an optional, private form is never something the user scrolls
 * through on the way to something else. It is reached deliberately, from a
 * clearly labelled link.
 *
 * The form owns its own consent, save and delete behaviour; nothing here
 * summarizes or re-renders the answers.
 */
export default function ProfileEeoPage() {
  return (
    <AppShell>
      <header className="mb-6">
        <Link
          href="/profile/application-preferences"
          className="focus-ring inline-flex items-center gap-1.5 text-sm font-medium text-[var(--text-muted)] transition hover:text-pine"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden /> Back to application preferences
        </Link>
        <h1 className="mt-3 text-3xl font-semibold tracking-[-0.03em]">
          Optional demographic information
        </h1>
        <p className="mt-2 max-w-2xl text-[var(--text-muted)]">
          This information is optional and entirely up to you. It is used only to help complete
          voluntary demographic questions on applications, and never for job matching, fit
          scoring, ranking, resume generation, or cover-letter generation.
        </p>
      </header>
      <DemographicsForm />
    </AppShell>
  );
}

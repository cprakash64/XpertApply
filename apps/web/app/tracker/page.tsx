import Link from "next/link";
import { AppShell } from "@/components/AppShell";
import { TrackerClient } from "@/components/TrackerClient";

export default function TrackerPage() {
  return (
    <AppShell>
      <header className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <nav aria-label="Breadcrumb" className="text-sm text-foreground-muted">
            <ol className="flex items-center gap-1.5">
              <li>
                <Link href="/dashboard" className="ds-focus-ring rounded-control hover:text-foreground">
                  Workspace
                </Link>
              </li>
              <li aria-hidden>/</li>
              <li aria-current="page" className="font-medium text-foreground-secondary">
                Applications
              </li>
            </ol>
          </nav>
          <p className="mt-4 text-xs font-semibold uppercase tracking-[0.12em] text-foreground-link">
            Your job search
          </p>
          <h1 className="mt-1 text-3xl font-semibold tracking-[-0.035em] text-foreground sm:text-4xl">
            Applications
          </h1>
          <p className="mt-2 max-w-xl text-foreground-muted">
            Every application in one place, from first click to interview and offer.
          </p>
        </div>
        <Link
          href="/jobs"
          className="ds-focus-ring inline-flex h-10 shrink-0 items-center justify-center rounded-control border border-action-secondary-border bg-action-secondary px-4 text-sm font-semibold text-action-secondary-foreground transition duration-fast ease-standard hover:bg-action-ghost-hover"
        >
          Find more jobs
        </Link>
      </header>
      <TrackerClient />
    </AppShell>
  );
}

import Link from "next/link";
import { AppShell } from "@/components/AppShell";

export default function ResumePage() {
  return (
    <AppShell>
      <header className="mb-6">
        <h1 className="text-3xl font-semibold tracking-[-0.035em] text-foreground sm:text-4xl">Resume generation</h1>
        <p className="mt-2 max-w-2xl text-foreground-muted">Resumes are tailored to a specific job. Open a role in Find Jobs and choose Resume to generate one from your profile; each version is saved per job and checked for unsupported claims.</p>
      </header>
      <Link
        href="/jobs"
        className="ds-focus-ring inline-flex h-11 items-center rounded-control bg-action-primary px-5 text-sm font-semibold text-action-primary-foreground hover:bg-action-primary-hover"
      >
        Find jobs
      </Link>
    </AppShell>
  );
}

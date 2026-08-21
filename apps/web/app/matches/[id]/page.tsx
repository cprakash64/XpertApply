import Link from "next/link";
import { AppShell } from "@/components/AppShell";

export default async function MatchExplanationPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <AppShell>
      <header className="mb-6">
        <h1 className="text-3xl font-semibold tracking-[-0.035em] text-foreground sm:text-4xl">Match explanation</h1>
        <p className="mt-2 text-foreground-muted">Job ID {id}. Match scoring uses career-profile data only and excludes sensitive demographics.</p>
      </header>
      <div className="rounded-card border border-line-default bg-surface-card p-5">
        <Link className="ds-focus-ring rounded-control font-medium text-foreground-link" href="/jobs">Back to job discovery</Link>
      </div>
    </AppShell>
  );
}

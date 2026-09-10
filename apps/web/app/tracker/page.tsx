import { AppShell } from "@/components/AppShell";
import { TrackerClient } from "@/components/TrackerClient";

export default function TrackerPage() {
  return (
    <AppShell>
      {/* Same header hierarchy as the Dashboard, so moving between the two
          reads as one product rather than two pages that happen to share a
          sidebar. */}
      <header className="mb-6">
        <h1 className="text-3xl font-semibold tracking-[-0.035em] text-foreground sm:text-4xl">
          Application tracker
        </h1>
        <p className="mt-2 text-foreground-muted">
          Every application in one place, from first click to interview and offer.
        </p>
      </header>
      <TrackerClient />
    </AppShell>
  );
}

import { AppShell } from "@/components/AppShell";

export default function CoverLetterPage() {
  return (
    <AppShell>
      <header className="mb-6">
        <h1 className="text-3xl font-semibold tracking-[-0.035em] text-foreground sm:text-4xl">Cover letter generation</h1>
        <p className="mt-2 text-foreground-muted">Generate short, specific cover letters from the job discovery page and review each version before use.</p>
      </header>
    </AppShell>
  );
}


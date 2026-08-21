import { AppShell } from "@/components/AppShell";

export default function ResumePage() {
  return (
    <AppShell>
      <header className="mb-6">
        <h1 className="text-3xl font-semibold tracking-[-0.035em] text-foreground sm:text-4xl">Resume generation</h1>
        <p className="mt-2 text-foreground-muted">Generate tailored, ATS-friendly resumes from the job discovery page. The backend stores every version per job and checks unsupported claims.</p>
      </header>
    </AppShell>
  );
}


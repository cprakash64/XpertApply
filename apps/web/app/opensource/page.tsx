import Link from "next/link";

export default function OpenSourcePage() {
  return (
    <main className="mx-auto max-w-4xl px-6 py-16">
      <Link href="/" className="ds-focus-ring rounded-control text-sm font-medium text-foreground-link">XpertApply</Link>
      <h1 className="mt-6 text-4xl font-semibold tracking-[-0.035em] text-foreground">Open source</h1>
      <p className="mt-4 leading-7 text-foreground-muted">The repository is structured as a Next.js frontend, FastAPI backend, shared schemas, Docker Compose infrastructure, CI, and contributor documentation under the MIT License.</p>
    </main>
  );
}


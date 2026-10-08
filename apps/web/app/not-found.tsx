import Link from "next/link";

export default function NotFound() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-surface-page p-6">
      <section className="w-full max-w-md rounded-card border border-line-default bg-surface-card p-6 shadow-raised">
        <p className="text-sm font-semibold text-foreground-link">XpertApply · 404</p>
        <h1 className="mt-3 text-xl font-semibold text-foreground">Page not found</h1>
        <p className="mt-2 text-sm text-foreground-secondary">The page you requested could not be found.</p>
        <Link href="/" className="ds-focus-ring mt-5 inline-flex h-10 items-center rounded-control bg-action-primary px-4 text-sm font-semibold text-action-primary-foreground">Return home</Link>
      </section>
    </main>
  );
}

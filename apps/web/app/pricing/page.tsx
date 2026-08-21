import Link from "next/link";

export default function PricingPage() {
  return (
    <main className="mx-auto max-w-4xl px-6 py-16">
      <Link href="/" className="ds-focus-ring rounded-control text-sm font-medium text-foreground-link">XpertApply</Link>
      <h1 className="mt-6 text-4xl font-semibold tracking-[-0.035em] text-foreground">Pricing</h1>
      <p className="mt-4 leading-7 text-foreground-muted">The open-source MVP is free to run locally. Hosted pricing is intentionally a placeholder until deployment costs, AI usage controls, and privacy commitments are finalized.</p>
    </main>
  );
}


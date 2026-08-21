import Link from "next/link";

export default function PrivacyPage() {
  return (
    <main className="mx-auto max-w-4xl px-6 py-16">
      <Link href="/" className="ds-focus-ring rounded-control text-sm font-medium text-foreground-link">XpertApply</Link>
      <h1 className="mt-6 text-4xl font-semibold tracking-[-0.035em] text-foreground">Privacy</h1>
      <p className="mt-4 leading-7 text-foreground-muted">Users control profile data, generated documents, optional EEO information, exports, and deletion. Sensitive demographics are stored separately and excluded from matching and resume generation.</p>
    </main>
  );
}


import Link from "next/link";
import { PRODUCT_NAME } from "@/lib/siteConfig";

/**
 * Shared frame for the plain public pages (pricing, privacy, open source).
 *
 * A single header and footer keep these pages recognisably part of the same
 * site as the homepage without pulling the marketing stylesheet into them. All
 * colour comes from the semantic tokens, so it follows the same palette.
 */
const LINKS = [
  { href: "/pricing", label: "Pricing" },
  { href: "/opensource", label: "Open source" },
  { href: "/privacy", label: "Privacy" }
];

export function PublicPage({
  title,
  intro,
  width = "max-w-3xl",
  children
}: {
  title: string;
  intro?: string;
  width?: "max-w-3xl" | "max-w-4xl";
  children?: React.ReactNode;
}) {
  return (
    <div className="flex min-h-screen flex-col bg-surface-page text-foreground">
      <header className="border-b border-line-subtle bg-surface-card">
        <div className={`mx-auto flex ${width} items-center justify-between px-6 py-4`}>
          <Link href="/" className="ds-focus-ring rounded-control text-base font-semibold tracking-tight text-foreground">
            {PRODUCT_NAME}
          </Link>
          <Link href="/signup" className="ds-focus-ring rounded-control bg-action-primary px-4 py-2 text-sm font-semibold text-action-primary-foreground hover:bg-action-primary-hover">
            Get started
          </Link>
        </div>
      </header>

      <main id="main" className={`mx-auto w-full ${width} flex-1 px-6 py-12 sm:py-16`}>
        <h1 className="text-4xl font-semibold tracking-[-0.035em] text-foreground">{title}</h1>
        {intro ? <p className="mt-4 max-w-2xl leading-7 text-foreground-secondary">{intro}</p> : null}
        {children}
      </main>

      <footer className="border-t border-line-subtle bg-surface-card">
        <nav aria-label="Footer" className={`mx-auto flex ${width} flex-wrap items-center gap-x-6 gap-y-2 px-6 py-6 text-sm`}>
          {LINKS.map((link) => (
            <Link key={link.href} href={link.href} className="ds-focus-ring rounded-control text-foreground-secondary hover:text-foreground">
              {link.label}
            </Link>
          ))}
          <span className="ml-auto text-foreground-muted">&copy; 2026 {PRODUCT_NAME}</span>
        </nav>
      </footer>
    </div>
  );
}

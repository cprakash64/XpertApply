"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ArrowRight, BriefcaseBusiness, Menu, X } from "lucide-react";
import { PRODUCT_NAME } from "@/lib/siteConfig";
import { ExtensionCta } from "@/components/landing/ExtensionCta";

/**
 * Landing-page navigation.
 *
 * The only interactive state on the page is this menu, which is why it — and
 * not the whole page — is the client component. Everything below the nav stays
 * a server-rendered tree.
 *
 * The section links are plain in-page anchors: no scroll library, no JS handler.
 * The smooth behaviour comes from CSS (`html:has(.landing-page)` in globals.css)
 * and is switched off automatically under `prefers-reduced-motion`, and the
 * sections carry `scroll-mt-*` so a heading never lands underneath the sticky
 * bar.
 */
const SECTIONS = [
  { href: "#features", label: "Features" },
  { href: "#how-it-works", label: "How it works" },
  { href: "#extension", label: "Extension" },
  { href: "#security", label: "Security" }
];

export function LandingNav() {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);

  // Escape closes the panel — the same expectation every other overlay in the
  // app sets.
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open]);

  return (
    <header className="sticky top-0 z-40 border-b border-line bg-[var(--glass-surface-strong)] backdrop-blur-xl">
      <div className="mx-auto flex h-16 max-w-7xl items-center justify-between gap-4 px-4 sm:px-6">
        <Link
          href="/"
          aria-label={`${PRODUCT_NAME} home`}
          className="focus-ring flex shrink-0 items-center gap-2.5 rounded-lg font-semibold tracking-[-0.02em] text-ink"
        >
          <span
            aria-hidden
            className="grid h-8 w-8 place-items-center rounded-lg bg-pine text-[var(--accent-foreground)]"
          >
            <BriefcaseBusiness className="h-4 w-4" />
          </span>
          {PRODUCT_NAME}
        </Link>

        <nav aria-label="Sections" className="hidden items-center gap-1 lg:flex">
          {SECTIONS.map((section) => (
            <a
              key={section.href}
              href={section.href}
              className="focus-ring rounded-lg px-3 py-2 text-sm font-medium text-[var(--text-secondary)] transition hover:bg-panel hover:text-ink"
            >
              {section.label}
            </a>
          ))}
        </nav>

        <div className="hidden items-center gap-2 lg:flex">
          <ExtensionCta
            id="nav-extension"
            size="sm"
            label="Install Extension"
            unavailableLabel="Extension coming soon"
            showNote={false}
          />
          <Link
            href="/login"
            className="focus-ring rounded-lg px-3 py-2 text-sm font-medium text-[var(--text-secondary)] transition hover:bg-panel hover:text-ink"
          >
            Sign in
          </Link>
          <Link
            href="/signup"
            className="focus-ring inline-flex h-10 items-center gap-1.5 rounded-lg bg-pine px-4 text-sm font-medium text-[var(--accent-foreground)] transition hover:bg-[var(--accent-hover)]"
          >
            Get started <ArrowRight className="h-4 w-4" aria-hidden />
          </Link>
        </div>

        <button
          type="button"
          className="focus-ring grid h-10 w-10 shrink-0 place-items-center rounded-lg border border-line text-[var(--text-secondary)] lg:hidden"
          aria-expanded={open}
          aria-controls="landing-mobile-menu"
          aria-label={open ? "Close menu" : "Open menu"}
          onClick={() => setOpen((value) => !value)}
        >
          {open ? <X className="h-5 w-5" aria-hidden /> : <Menu className="h-5 w-5" aria-hidden />}
        </button>
      </div>

      {/*
        * Kept in the DOM only while open. A permanently-rendered hidden panel
        * would put a second copy of every nav link into the accessibility tree
        * and into every text query on the page.
        */}
      {open && (
        <div
          id="landing-mobile-menu"
          className="border-t border-line bg-[var(--surface)] px-4 py-4 lg:hidden"
        >
          <nav aria-label="Sections" className="grid gap-1">
            {SECTIONS.map((section) => (
              <a
                key={section.href}
                href={section.href}
                onClick={close}
                className="focus-ring rounded-lg px-3 py-2.5 text-sm font-medium text-[var(--text-secondary)] hover:bg-panel hover:text-ink"
              >
                {section.label}
              </a>
            ))}
          </nav>
          <div className="mt-4 grid gap-2 border-t border-line pt-4">
            <ExtensionCta
              id="mobile-nav-extension"
              label="Install Extension"
              unavailableLabel="Extension coming soon"
              showNote={false}
              className="w-full"
            />
            <Link
              href="/login"
              onClick={close}
              className="focus-ring inline-flex h-11 items-center justify-center rounded-xl border border-line px-4 text-sm font-semibold text-[var(--text-secondary)] hover:bg-panel"
            >
              Sign in
            </Link>
            <Link
              href="/signup"
              onClick={close}
              className="focus-ring inline-flex h-11 items-center justify-center gap-1.5 rounded-xl bg-pine px-4 text-sm font-semibold text-[var(--accent-foreground)] hover:bg-[var(--accent-hover)]"
            >
              Get started <ArrowRight className="h-4 w-4" aria-hidden />
            </Link>
          </div>
        </div>
      )}
    </header>
  );
}

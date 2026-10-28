"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Menu, X } from "lucide-react";
import { PRODUCT_NAME } from "@/lib/siteConfig";
import { BrandWordmark } from "@/components/marketing/BrandWordmark";
import { ThemeControl } from "@/components/ThemeControl";

/**
 * The floating navigation bar.
 *
 * It is sticky but not flush: the bar sits a little below the top of the
 * viewport and inside the page gutter, so the page appears to scroll underneath
 * a distinct object rather than beneath a banner welded to the window. At rest
 * it is a near-white surface with a hairline border; once the page has scrolled
 * it becomes a frosted, translucent one (see `data-scrolled` in marketing.css,
 * which also supplies the solid fallbacks).
 *
 * Scroll state comes from an IntersectionObserver on a 1px sentinel at the very
 * top of the page, not a scroll listener: the browser tells us once when the
 * sentinel leaves the viewport and once when it returns. The only state it
 * flips is a data attribute, so nothing reflows.
 *
 * The section entries are plain in-page anchors, with no scroll library and no
 * handler. Smooth behaviour comes from CSS and is switched off automatically
 * under `prefers-reduced-motion`; each section carries `scroll-margin-top` so a
 * heading never lands underneath the bar. There is deliberately no Pricing
 * entry: hosted pricing is not finalized (the pricing page and dialog remain).
 */
const SECTIONS = [
  { href: "#story", label: "Product" },
  { href: "#extension", label: "Extension" },
  { href: "#security", label: "Security" },
];

export function MarketingNavbar() {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const [scrolled, setScrolled] = useState(false);
  const [overDark, setOverDark] = useState(false);
  const sentinel = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const node = sentinel.current;
    if (!node || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(([entry]) => setScrolled(!entry.isIntersecting));
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  // Frosted white over a navy section reads muddy grey, so the bar becomes more
  // opaque while any section marked data-nav-tone="dark" sits under it. Another
  // observer, not a scroll handler: it watches the band the bar occupies.
  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") return;
    const nodes = Array.from(document.querySelectorAll('[data-nav-tone="dark"]'));
    if (nodes.length === 0) return;
    const under = new Set<Element>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) under.add(entry.target);
          else under.delete(entry.target);
        }
        setOverDark(under.size > 0);
      },
      { rootMargin: "0px 0px -88% 0px" },
    );
    nodes.forEach((node) => observer.observe(node));
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open]);

  return (
    <>
      <div ref={sentinel} aria-hidden className="xa-nav-sentinel" />
      <div
        className="xa-navwrap"
        data-scrolled={scrolled ? "true" : "false"}
        data-tone={overDark ? "dark" : "light"}
      >
        <div className="xa-shell">
          <header className="xa-nav">
            <Link href="/" aria-label={`${PRODUCT_NAME} home`}>
              <BrandWordmark />
            </Link>

            <nav aria-label="Sections" className="xa-nav__links">
              {SECTIONS.map((section) => (
                <a key={section.href} href={section.href} className="xa-nav__link">
                  {section.label}
                </a>
              ))}
            </nav>

            <div className="xa-nav__actions">
            <ThemeControl className="xa-nav__theme" />
              <Link href="/login" className="xa-nav__link">
                Sign in
              </Link>
              <Link href="/signup" className="xa-btn xa-btn--primary xa-btn--sm">
                Get started →
              </Link>
            </div>

            <button
              type="button"
              className="xa-nav__toggle"
              aria-expanded={open}
              aria-controls="xa-mobile-menu"
              aria-label={open ? "Close menu" : "Open menu"}
              onClick={() => setOpen((value) => !value)}
            >
              {open ? (
                <X aria-hidden width={20} height={20} />
              ) : (
                <Menu aria-hidden width={20} height={20} />
              )}
            </button>
          </header>

          {/*
           * Rendered only while open. A permanently-mounted hidden panel would
           * put a second copy of every destination into the accessibility tree.
           */}
          {open && (
            <div id="xa-mobile-menu" className="xa-nav__panel">
              <nav aria-label="Sections" className="xa-nav__panel-links">
                {SECTIONS.map((section) => (
                  <a
                    key={section.href}
                    href={section.href}
                    onClick={close}
                    className="xa-nav__link"
                  >
                    {section.label}
                  </a>
                ))}
              </nav>
              <ThemeControl className="xa-nav__panel-theme" />
            <div className="xa-nav__panel-actions">
                <Link href="/login" onClick={close} className="xa-btn xa-btn--ghost">
                  Sign in
                </Link>
                <Link href="/signup" onClick={close} className="xa-btn xa-btn--primary">
                  Get started →
                </Link>
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  );
}

import type { CSSProperties } from "react";
import { PRODUCT_NAME } from "@/lib/siteConfig";

/**
 * The first-party logo, in one place.
 *
 * Two transparent renderings of the same X mark: Midnight Ink and Sapphire for
 * light surfaces, a light ink with a lifted Sapphire for dark ones. Both are
 * derived from the original 1448px logo, so there is no tile, no padding and no
 * crop trick. CSS shows the one that matches `data-theme`; the hidden one is
 * lazy, so it is never fetched unless the theme changes.
 *
 * The wordmark is live text in the theme's own text and accent tokens, which is
 * why it is always sharp and always the right colour. Size is a prop because the
 * right size depends on where it sits (navbar, sidebar, sign-in card).
 */
export function BrandMark({ size = 36, className = "" }: { size?: number; className?: string }) {
  return (
    <span aria-hidden className={`brand-mark ${className}`} style={{ "--brand-logo-size": `${size}px` } as CSSProperties}>
      {/* Plain <img>s: static 256px assets, shown at 28-48px. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img className="brand-mark__light" src="/brand/xpertapply-mark.png" alt="" width={size} height={size} />
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img className="brand-mark__dark" src="/brand/xpertapply-mark-dark.png" alt="" width={size} height={size} loading="lazy" />
    </span>
  );
}

export function BrandLogo({
  size = 36,
  showText = true,
  className = ""
}: {
  size?: number;
  showText?: boolean;
  className?: string;
}) {
  return (
    <span className={`brand-logo ${className}`}>
      {/* One accessible string, two visual halves: a screen reader hears
        * "XpertApply", never "Xpert Apply". */}
      <span className="sr-only">{PRODUCT_NAME}</span>
      <BrandMark size={size} />
      {showText && (
        <span aria-hidden className="brand-logo__text">
          <span className="brand-logo__xpert">Xpert</span>
          <span className="brand-logo__apply">Apply</span>
        </span>
      )}
    </span>
  );
}

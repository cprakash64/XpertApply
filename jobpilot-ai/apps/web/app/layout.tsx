import type { Metadata, Viewport } from "next";
import "./globals.css";
import { PRODUCT_NAME, siteUrl } from "@/lib/siteConfig";

/**
 * Site-wide metadata.
 *
 * The canonical origin comes from NEXT_PUBLIC_SITE_URL (falling back to the
 * production domain) rather than being written into each page, so a preview or
 * self-hosted deployment advertises its own URLs without a code change.
 * `metadataBase` is what makes the relative OpenGraph/Twitter URLs below absolute.
 *
 * The title template leaves per-page titles short: a page sets "Dashboard" and
 * the browser tab reads "Dashboard · XpertApply".
 */
const description =
  `Discover better jobs, understand your fit, tailor your resume, autofill applications, ` +
  `and manage your job search with ${PRODUCT_NAME}.`;

/** The one title the site introduces itself with — search results, a shared link. */
const SITE_TITLE = `${PRODUCT_NAME} | AI Job Application Copilot`;

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl()),
  title: {
    default: SITE_TITLE,
    template: `%s · ${PRODUCT_NAME}`
  },
  applicationName: PRODUCT_NAME,
  description,
  openGraph: {
    type: "website",
    siteName: PRODUCT_NAME,
    title: SITE_TITLE,
    description,
    url: "/"
  },
  twitter: {
    card: "summary_large_image",
    title: SITE_TITLE,
    description
  }
};

/**
 * Declares support for BOTH schemes so the browser paints its own chrome
 * (canvas, form controls, scrollbars) correctly from the first frame. Together
 * with `color-scheme: light dark` in globals.css this is what prevents a white
 * flash before the stylesheet applies for a user in dark mode — and it needs no
 * JavaScript, so it cannot cause a hydration mismatch.
 */
export const viewport: Viewport = {
  colorScheme: "light dark",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#fbfbf8" },
    { media: "(prefers-color-scheme: dark)", color: "#14171a" }
  ]
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}

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
 * the browser tab reads "Dashboard · EZJobFind".
 */
const description =
  `Discover relevant jobs, understand your fit, prepare tailored resumes and cover letters, ` +
  `autofill repetitive application fields, and track your job search with ${PRODUCT_NAME}.`;

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl()),
  title: {
    default: `${PRODUCT_NAME} — Find, Prepare, and Apply Smarter`,
    template: `%s · ${PRODUCT_NAME}`
  },
  applicationName: PRODUCT_NAME,
  description,
  openGraph: {
    type: "website",
    siteName: PRODUCT_NAME,
    title: `${PRODUCT_NAME} — Find, Prepare, and Apply Smarter`,
    description,
    url: "/"
  },
  twitter: {
    card: "summary_large_image",
    title: `${PRODUCT_NAME} — Find, Prepare, and Apply Smarter`,
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

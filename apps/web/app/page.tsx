import type { Metadata } from "next";
import "./marketing.css";
import { MarketingNavbar } from "@/components/marketing/MarketingNavbar";
import { Hero } from "@/components/marketing/Hero";
import { ProductStory } from "@/components/marketing/ProductStory";
import { ExtensionShowcase } from "@/components/marketing/ExtensionShowcase";
import { TrustSection } from "@/components/marketing/TrustSection";
import { FinalCta } from "@/components/marketing/FinalCta";
import { MarketingFooter } from "@/components/marketing/MarketingFooter";
import { PricingProvider } from "@/components/marketing/PricingDialog";
import { PRODUCT_NAME, siteUrl } from "@/lib/siteConfig";

/**
 * The public marketing homepage.
 *
 * ─── Scope ───────────────────────────────────────────────────────────────────
 * This is the LOGGED-OUT surface only. It performs no authentication check and
 * issues no redirect — exactly as before — because the app's session lives in
 * localStorage and is read on the client; a signed-in visitor who navigates here
 * sees this page and reaches the product through the same links as everyone
 * else. Nothing about the authenticated experience is touched by this file.
 *
 * ─── Rendering ───────────────────────────────────────────────────────────────
 * Still a server component that fetches nothing. A signed-out visitor must be
 * able to read the whole page without a single API call, which is both a privacy
 * property and the reason it stays cheap to serve. Three client islands exist,
 * and only three: the navbar (its menu), the story (its scroll state), and the
 * pricing dialog. Everything else is static markup.
 *
 * ─── Styling ─────────────────────────────────────────────────────────────────
 * `marketing.css` is imported here rather than in the root layout, so the
 * marketing palette ships only with the routes that use it and never enters the
 * authenticated app's CSS. Its tokens are scoped to `.xa-page`.
 */
export const metadata: Metadata = {
  // `absolute` because the root layout applies a "%s · XpertApply" template and
  // this title already ends in the product name.
  title: { absolute: `${PRODUCT_NAME} — Find the right job. Apply with confidence.` },
  description:
    `Discover better-fit jobs, tailor every application, connect with the right people, ` +
    `and apply faster with ${PRODUCT_NAME}.`,
  alternates: { canonical: siteUrl() },
  openGraph: {
    type: "website",
    siteName: PRODUCT_NAME,
    url: "/",
    title: `${PRODUCT_NAME} — Find the right job. Apply with confidence.`,
    description:
      `Discover better-fit jobs, tailor every application, connect with the right people, ` +
      `and apply faster with ${PRODUCT_NAME}.`
  }
};

export default function HomePage() {
  return (
    <PricingProvider>
      <div className="xa-theme xa-page">
        <MarketingNavbar />
        <main>
          <Hero />
          <ProductStory />
          <ExtensionShowcase />
          <TrustSection />
          <FinalCta />
        </main>
        <MarketingFooter />
      </div>
    </PricingProvider>
  );
}

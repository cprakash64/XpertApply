import type { MetadataRoute } from "next";
import { siteUrl } from "@/lib/siteConfig";

/**
 * Crawling policy. Public marketing and policy pages are crawlable; every
 * signed-in surface is disallowed so account, profile, document and tracker
 * routes are never offered to a crawler. (The app also keeps its session in the
 * browser, so these routes render nothing sensitive to a bot in any case.)
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        disallow: [
          "/dashboard",
          "/jobs",
          "/matches",
          "/tracker",
          "/resume",
          "/cover-letter",
          "/profile",
          "/settings",
          "/application-answers",
          "/demographics",
          "/auth",
          "/login",
          "/signup"
        ]
      }
    ],
    sitemap: `${siteUrl()}/sitemap.xml`
  };
}

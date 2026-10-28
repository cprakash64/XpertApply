import type { MetadataRoute } from "next";
import { siteUrl } from "@/lib/siteConfig";

/** Only the public, indexable pages. Signed-in routes are deliberately absent. */
export default function sitemap(): MetadataRoute.Sitemap {
  const origin = siteUrl();
  return ["/", "/pricing", "/opensource", "/privacy"].map((path) => ({
    url: `${origin}${path === "/" ? "" : path}`
  }));
}

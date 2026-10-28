import { reportOnlyHeaders } from "./lib/securityPolicy.mjs";

/** @type {import('next').NextConfig} */
const nextConfig = {
  allowedDevOrigins: ["localhost", "127.0.0.1"],
  poweredByHeader: false,
  async headers() {
    return [
      ...reportOnlyHeaders(),
      {
        // Recovery pages carry or handle a one-time credential: no Referer, no caching.
        source: "/:page(forgot-password|reset-password)",
        headers: [
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "Cache-Control", value: "no-store" },
          { key: "X-Robots-Tag", value: "noindex, nofollow" }
        ]
      }
    ];
  }
};

export default nextConfig;

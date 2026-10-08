import { reportOnlyHeaders } from "./lib/securityPolicy.mjs";

/** @type {import('next').NextConfig} */
const nextConfig = {
  allowedDevOrigins: ["localhost", "127.0.0.1"],
  poweredByHeader: false,
  async headers() {
    return []; // Local experiment: proxy owns the sole CSP response header.
  }
};

export default nextConfig;

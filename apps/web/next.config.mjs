import { reportOnlyHeaders } from "./lib/securityPolicy.mjs";

/** @type {import('next').NextConfig} */
const nextConfig = {
  allowedDevOrigins: ["localhost", "127.0.0.1"],
  poweredByHeader: false,
  async headers() {
    return reportOnlyHeaders();
  }
};

export default nextConfig;

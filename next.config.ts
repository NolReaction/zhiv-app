import type { NextConfig } from "next";

const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Content-Security-Policy",
    value: "frame-ancestors 'none'; base-uri 'self'; object-src 'none'",
  },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=()",
  },
];

const allowedDevOrigins = (
    process.env.NEXT_ALLOWED_DEV_ORIGINS ?? ""
)
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);

const nextConfig: NextConfig = {
  output: "standalone",
  allowedDevOrigins,
  devIndicators: false,
  env: { NEXT_PUBLIC_APP_BUILD_ID: process.env.NEXT_PUBLIC_APP_BUILD_ID ?? "development" },

  async headers() {
    return [
      { source: "/world/runtime/:path*", headers: [{ key: "Cache-Control", value: "public, max-age=31536000, immutable" }] },
      { source: "/sw.js", headers: [{ key: "Cache-Control", value: "no-cache" }] },
      { source: "/updates.json", headers: [{ key: "Cache-Control", value: "no-store" }] },
      { source: "/app-status.json", headers: [{ key: "Cache-Control", value: "no-store" }] },
      {
        source: "/",
        headers: securityHeaders,
      },
      {
        source: "/:path*",
        headers: securityHeaders,
      },
    ];
  },
};

export default nextConfig;

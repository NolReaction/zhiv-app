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

  async headers() {
    return [
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

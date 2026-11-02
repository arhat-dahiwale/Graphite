import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  async rewrites() {
    // Proxy API calls to the Express API to keep cookies same-origin in dev.
    const api =
      process.env.API_URL?.replace(/\/$/, "") ?? "http://localhost:4000";
    return [
      { source: "/api/auth/:path*", destination: `${api}/api/auth/:path*` },
      { source: "/trpc/:path*", destination: `${api}/trpc/:path*` },
      { source: "/api/v1/:path*", destination: `${api}/api/v1/:path*` },
    ];
  },
};

export default nextConfig;

import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  transpilePackages: ["@eyeball/catalog", "@eyeball/core"],
};

export default nextConfig;

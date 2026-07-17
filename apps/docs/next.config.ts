import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  experimental: {
    cpus: 1,
    staticGenerationMaxConcurrency: 1,
  },
};

export default nextConfig;

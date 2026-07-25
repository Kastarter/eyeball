import type { NextConfig } from "next";

// Static-export mode is opt-in via DOCS_STATIC_EXPORT=1 so that normal `pnpm dev`
// and the default server build are unaffected. When enabled, the docs render as a
// fully static site mounted under /docs (basePath) so they can be hosted alongside
// the marketing landing on a single domain (e.g. useyeball.dev/docs).
const staticExport = process.env.DOCS_STATIC_EXPORT === "1";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  ...(staticExport
    ? {
        output: "export" as const,
        basePath: "/docs",
        trailingSlash: true,
        images: { unoptimized: true },
      }
    : {}),
  experimental: {
    cpus: 1,
    staticGenerationMaxConcurrency: 1,
  },
};

export default nextConfig;

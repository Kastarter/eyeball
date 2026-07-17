import { describe, expect, it } from "vitest";
import { getNavigationPaths, getSourcePagePaths } from "./content";

describe("documentation navigation", () => {
  it("references every generated MDX page exactly once", () => {
    const sourcePaths = getSourcePagePaths();
    const sourcePages = new Set(sourcePaths);
    const navigationPaths = getNavigationPaths();
    const missingPages = navigationPaths.filter(
      (path) => !sourcePages.has(path),
    );
    const orphanedPages = sourcePaths.filter(
      (path) => !navigationPaths.includes(path),
    );

    expect(missingPages).toEqual([]);
    expect(orphanedPages).toEqual([]);
    expect(new Set(navigationPaths).size).toBe(navigationPaths.length);
  });

  it("keeps eyeball onboarding ahead of stack integrations", () => {
    const navigationPaths = getNavigationPaths();

    expect(navigationPaths.slice(0, 8)).toEqual([
      "index",
      "getting-started/quickstart",
      "getting-started/mcp",
      "getting-started/openai",
      "getting-started/ai-sdk",
      "getting-started/anthropic",
      "getting-started/from-mocks-to-live",
      "getting-started/connect-your-first-account",
    ]);
  });
});

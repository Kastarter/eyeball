import {
  CATALOG_SUMMARY,
  defaultCatalog,
  PROVIDER_CATALOG,
} from "@eyeball/catalog";
import { describe, expect, it } from "vitest";
import { CATALOG_STATS, PROVIDER_GROUPS } from "@/src/landing-data";

describe("provider wall catalog wiring", () => {
  it("derives all public counts from the catalog exports", () => {
    expect(CATALOG_STATS.roadmapProviders).toBe(CATALOG_SUMMARY.providers);
    expect(CATALOG_STATS.capabilities).toBe(CATALOG_SUMMARY.capabilities);
    expect(CATALOG_STATS.implementedManifests).toBe(
      defaultCatalog.listManifests().length,
    );
  });

  it("renders every baseline provider exactly once", () => {
    const baselineProviders = PROVIDER_GROUPS.flatMap(({ providers }) =>
      providers.filter(({ runtimeOnly }) => !runtimeOnly),
    );
    const uniqueSlugs = new Set(baselineProviders.map(({ slug }) => slug));

    expect(baselineProviders).toHaveLength(PROVIDER_CATALOG.length);
    expect(uniqueSlugs.size).toBe(PROVIDER_CATALOG.length);
    expect(PROVIDER_CATALOG).toHaveLength(CATALOG_SUMMARY.providers);
  });

  it("accounts explicitly for catalog 1.1 runtime additions", () => {
    const runtimeProviders = PROVIDER_GROUPS.flatMap(({ providers }) =>
      providers.filter(({ runtimeOnly }) => runtimeOnly),
    );

    expect(runtimeProviders.map(({ slug }) => slug)).toEqual(["voice-agents"]);
    expect(runtimeProviders).toHaveLength(CATALOG_STATS.runtimeAdditions);
    expect(
      CATALOG_STATS.implementedRoadmapProviders +
        CATALOG_STATS.runtimeAdditions,
    ).toBe(CATALOG_STATS.implementedManifests);
  });
});

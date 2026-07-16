import { CAPABILITY_SLUGS, isCanonicalToolName } from "@eyeball/core";
import { describe, expect, it } from "vitest";
import {
  CAPABILITY_CATALOG,
  CATALOG_SNAPSHOT_DATE,
  CATALOG_SUMMARY,
  getCapabilityCatalogEntry,
  getProviderCatalogEntry,
  P0_PROVIDER_CATALOG,
  PROVIDER_CATALOG,
} from "../src/index.js";

const P0_SLUGS = [
  "gmail",
  "microsoft-outlook",
  "google-calendar",
  "slack",
  "discord",
  "telegram",
  "whatsapp-business",
  "twilio",
  "livekit",
  "pipecat",
  "elevenlabs",
  "deepgram",
  "hubspot",
  "odoo",
  "quickbooks",
  "instagram-data",
  "tiktok-data",
  "youtube-data",
  "x-data",
  "linkedin-data",
  "reddit-data",
  "twitch-data",
  "snapchat-data",
  "google-drive",
  "google-sheets",
  "airtable",
  "notion",
  "github",
  "linear",
  "stripe",
  "shopify",
  "zendesk",
  "firecrawl",
  "serper",
] as const;

describe("generated provider catalog baseline", () => {
  it("matches the frozen catalog 1.0 counts", () => {
    expect(CATALOG_SNAPSHOT_DATE).toBe("2026-07-16");
    expect(CATALOG_SUMMARY).toEqual({
      capabilities: 20,
      canonicalContracts: 187,
      providers: 157,
      tiers: { P0: 34, P1: 72, P2: 51 },
      sources: {
        "activepieces-bridge": 136,
        native: 13,
        scrapecreators: 8,
      },
    });
  });

  it("contains every core capability exactly once and every tool once per capability", () => {
    expect(CAPABILITY_CATALOG.map(({ slug }) => slug)).toEqual(
      CAPABILITY_SLUGS,
    );
    for (const capability of CAPABILITY_CATALOG) {
      expect(capability.contractFocus).not.toBe("");
      expect(capability.tools.length).toBeGreaterThan(0);
      expect(new Set(capability.tools.map(({ name }) => name)).size).toBe(
        capability.tools.length,
      );
      for (const tool of capability.tools) {
        expect(tool.name).toMatch(/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/);
        expect(tool.description).not.toBe("");
      }
    }
  });

  it("keeps every catalog membership within the portable qualified-name limit", () => {
    const capabilities = new Map(
      CAPABILITY_CATALOG.map((capability) => [capability.slug, capability]),
    );
    for (const provider of PROVIDER_CATALOG) {
      for (const membership of provider.memberships) {
        const capability = capabilities.get(membership.capability);
        expect(capability).toBeDefined();
        for (const tool of capability?.tools ?? []) {
          expect(
            isCanonicalToolName(`${provider.toolkit.slug}.${tool.name}`),
          ).toBe(true);
        }
      }
    }
  });

  it("deduplicates providers while retaining every capability membership", () => {
    expect(
      new Set(PROVIDER_CATALOG.map(({ toolkit }) => toolkit.slug)).size,
    ).toBe(157);
    expect(getProviderCatalogEntry("twilio")?.memberships).toEqual([
      expect.objectContaining({ capability: "voice_telephony" }),
      expect.objectContaining({ capability: "sms" }),
    ]);
  });

  it("matches the authoritative P0 launch set exactly", () => {
    expect(P0_PROVIDER_CATALOG.map(({ toolkit }) => toolkit.slug)).toEqual(
      P0_SLUGS,
    );
  });

  it("provides stable lookups and deeply frozen public data", () => {
    expect(getCapabilityCatalogEntry("email")).toBe(CAPABILITY_CATALOG[0]);
    expect(getProviderCatalogEntry("gmail")).toBe(
      PROVIDER_CATALOG.find(({ toolkit }) => toolkit.slug === "gmail"),
    );
    expect(getProviderCatalogEntry("missing")).toBeUndefined();
    expect(Object.isFrozen(CAPABILITY_CATALOG)).toBe(true);
    expect(Object.isFrozen(CAPABILITY_CATALOG[0]?.tools)).toBe(true);
    expect(Object.isFrozen(PROVIDER_CATALOG[0]?.toolkit)).toBe(true);
    expect(Object.isFrozen(CATALOG_SUMMARY.tiers)).toBe(true);
  });
});

import { describe, expect, it } from "vitest";
import { loadCatalogToolkit, searchCatalogTools } from "./catalog-search";

describe("dashboard catalog search client", () => {
  it("queries the same-origin BM25 route and validates compact results", async () => {
    let requestedUrl: string | undefined;
    const fetch: typeof globalThis.fetch = async (input) => {
      requestedUrl = String(input);
      return Response.json({
        tools: [
          {
            capability: "email",
            name: "gmail.create_draft",
            toolkit: "gmail",
          },
        ],
      });
    };

    await expect(
      searchCatalogTools("write an email", undefined, fetch),
    ).resolves.toEqual([
      {
        capability: "email",
        name: "gmail.create_draft",
        toolkit: "gmail",
      },
    ]);
    expect(requestedUrl).toBe("/api/catalog/search?q=write+an+email");
  });

  it("rejects malformed search envelopes instead of trusting browser data", async () => {
    const fetch: typeof globalThis.fetch = async () =>
      Response.json({ tools: [{ name: "gmail.create_draft" }] });

    await expect(searchCatalogTools("draft", undefined, fetch)).rejects.toThrow(
      "Catalog search returned an invalid response.",
    );
  });

  it("preserves the HTTP status in search failures for browser recovery UI", async () => {
    const fetch: typeof globalThis.fetch = async () =>
      new Response(null, { status: 503 });

    await expect(
      searchCatalogTools("send email", undefined, fetch),
    ).rejects.toThrow("Catalog search failed with HTTP 503.");
  });

  it("loads one toolkit detail lazily and verifies its identity", async () => {
    let requestedUrl: string | undefined;
    const fetch: typeof globalThis.fetch = async (input) => {
      requestedUrl = String(input);
      return Response.json({
        auth: {
          class: "oauth2",
          fields: [],
          optionalScopes: [],
          requiredScopes: [],
        },
        capabilities: [{ label: "Email", slug: "email" }],
        displayName: "Gmail",
        slug: "gmail",
        source: "activepieces-bridge",
        sourceLabel: "bridge",
        tier: "P0",
        tools: [],
      });
    };

    await expect(
      loadCatalogToolkit("gmail", undefined, fetch),
    ).resolves.toMatchObject({ displayName: "Gmail", slug: "gmail" });
    expect(requestedUrl).toBe("/api/catalog/toolkits/gmail");
  });
});

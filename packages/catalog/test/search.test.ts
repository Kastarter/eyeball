import type { JSONSchema202012, ToolDefinition } from "@eyeball/core";
import { describe, expect, it } from "vitest";
import {
  CatalogRegistry,
  CatalogToolSearchIndex,
  defaultCatalog,
  type EmbeddingProvider,
  emailCapabilityContracts,
  emailCapabilityTriggerContracts,
  gmailManifest,
  microsoftOutlookManifest,
  searchCatalogTools,
  TOOL_SEARCH_SYNONYMS,
} from "../src/index.js";

interface RelevanceFixture {
  query: string;
  expectedAnyOf: readonly string[];
}

const RELEVANCE_FIXTURES: readonly RelevanceFixture[] = [
  {
    query: "send an email to a customer",
    expectedAnyOf: ["gmail.send_email", "microsoft-outlook.send_email"],
  },
  {
    query: "find the email about our contract",
    expectedAnyOf: ["gmail.search_emails", "microsoft-outlook.search_emails"],
  },
  {
    query: "write an email but do not send it",
    expectedAnyOf: ["gmail.create_draft", "microsoft-outlook.create_draft"],
  },
  {
    query: "book a meeting with the customer",
    expectedAnyOf: ["google-calendar.create_event"],
  },
  {
    query: "find free time slots",
    expectedAnyOf: ["google-calendar.find_available_times"],
  },
  {
    query: "accept the calendar invite",
    expectedAnyOf: ["google-calendar.respond_to_event"],
  },
  {
    query: "cancel a calendar meeting",
    expectedAnyOf: ["google-calendar.delete_event"],
  },
  {
    query: "post to slack",
    expectedAnyOf: ["slack.send_message"],
  },
  {
    query: "text someone",
    expectedAnyOf: [
      "discord.send_message",
      "slack.send_message",
      "telegram.send_message",
      "whatsapp-business.send_message",
    ],
  },
  {
    query: "make a phone call that books a table",
    expectedAnyOf: ["voice-agents.start_agent_call", "twilio.start_call"],
  },
  {
    query: "hang up the phone call",
    expectedAnyOf: ["twilio.end_call"],
  },
  {
    query: "forward the call to sales",
    expectedAnyOf: ["twilio.transfer_call"],
  },
  {
    query: "add a note to the deal",
    expectedAnyOf: ["hubspot.add_note"],
  },
  {
    query: "find a contact by email address",
    expectedAnyOf: ["hubspot.search_contacts"],
  },
  {
    query: "refund the customer",
    expectedAnyOf: ["stripe.create_refund"],
  },
  {
    query: "invoice the customer for this order",
    expectedAnyOf: [
      "odoo.create_invoice",
      "quickbooks.create_invoice",
      "stripe.create_invoice",
    ],
  },
  {
    query: "make a payment link",
    expectedAnyOf: ["stripe.create_payment_link"],
  },
  {
    query: "cancel the subscription",
    expectedAnyOf: ["stripe.cancel_subscription"],
  },
  {
    query: "what did this tiktok creator post",
    expectedAnyOf: ["tiktok-data.get_posts"],
  },
  {
    query: "get an instagram profile",
    expectedAnyOf: ["instagram-data.get_profile"],
  },
  {
    query: "comments on a youtube video",
    expectedAnyOf: ["youtube-data.get_comments"],
  },
  {
    query: "get the transcript of a tiktok video",
    expectedAnyOf: ["tiktok-data.get_transcript"],
  },
  {
    query: "trending instagram reels",
    expectedAnyOf: ["instagram-data.get_trending_content"],
  },
  {
    query: "upload a document to drive",
    expectedAnyOf: ["google-drive.upload_file"],
  },
  {
    query: "look up a file in drive",
    expectedAnyOf: ["google-drive.search_files"],
  },
  {
    query: "share a document",
    expectedAnyOf: ["google-drive.share_file"],
  },
  {
    query: "add a row to a spreadsheet",
    expectedAnyOf: [
      "airtable.create_row",
      "google-sheets.append_row",
      "notion.create_row",
    ],
  },
  {
    query: "update spreadsheet cells",
    expectedAnyOf: ["google-sheets.update_range"],
  },
  {
    query: "open a support request",
    expectedAnyOf: ["zendesk.create_ticket"],
  },
  {
    query: "answer a support ticket",
    expectedAnyOf: ["zendesk.add_ticket_reply"],
  },
  {
    query: "assign the support case to an agent",
    expectedAnyOf: ["zendesk.assign_ticket"],
  },
  {
    query: "report a bug in github",
    expectedAnyOf: ["github.create_issue"],
  },
  {
    query: "comment on a linear issue",
    expectedAnyOf: ["linear.add_comment"],
  },
  {
    query: "fulfill a shopify order",
    expectedAnyOf: ["shopify.create_fulfillment"],
  },
  {
    query: "update shopify inventory",
    expectedAnyOf: ["shopify.update_inventory"],
  },
];

const READ_ONLY = {
  readOnly: true,
  destructive: false,
  idempotent: true,
  async: false,
} as const;

function fixtureTool(
  name: `${string}.${string}`,
  description: string,
  properties: Readonly<Record<string, JSONSchema202012>> = {},
): ToolDefinition {
  return {
    name,
    toolkit: name.slice(0, name.indexOf(".")),
    capability: "email",
    description,
    inputSchema: { type: "object", properties },
    annotations: READ_ONLY,
    version: "1.0.0",
  };
}

const HASH_DIMENSIONS = 256;

function fnv1a(value: string): number {
  let hash = 2_166_136_261;
  for (const character of value) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
}

function hashEmbedding(text: string): number[] {
  const vector = Array<number>(HASH_DIMENSIONS).fill(0);
  for (const token of text.toLowerCase().match(/[a-z0-9]+/gu) ?? []) {
    const hash = fnv1a(token);
    const bucket = hash % HASH_DIMENSIONS;
    vector[bucket] = (vector[bucket] ?? 0) + (hash < 0x80_00_00_00 ? 1 : -1);
  }
  return vector;
}

class HashEmbeddingProvider implements EmbeddingProvider {
  readonly batches: string[][] = [];

  embed(texts: string[]): Promise<number[][]> {
    this.batches.push([...texts]);
    return Promise.resolve(texts.map(hashEmbedding));
  }
}

describe("catalog tool search relevance", () => {
  it.each(
    RELEVANCE_FIXTURES,
  )("returns an expected tool in the top three for: $query", ({
    query,
    expectedAnyOf,
  }) => {
    const topThree = searchCatalogTools(defaultCatalog.listTools(), {
      query,
      limit: 3,
    }).map(({ name }) => name);

    expect(
      topThree.some((name) => expectedAnyOf.includes(name)),
      `Expected one of ${expectedAnyOf.join(", ")} in ${topThree.join(", ")}`,
    ).toBe(true);
  });

  it("keeps the curated synonym table bounded and grounded in real tools", () => {
    expect(TOOL_SEARCH_SYNONYMS.length).toBeGreaterThanOrEqual(30);
    expect(TOOL_SEARCH_SYNONYMS.length).toBeLessThanOrEqual(50);

    const names = new Set(defaultCatalog.listTools().map(({ name }) => name));
    const missing = TOOL_SEARCH_SYNONYMS.flatMap(({ phrase, expansions }) =>
      expansions
        .filter(
          (expansion) =>
            !names.has(expansion as `${string}.${string}`) &&
            ![...names].some((name) => name.endsWith(`.${expansion}`)),
        )
        .map((expansion) => `${phrase} -> ${expansion}`),
    );

    expect(missing).toEqual([]);
  });
});

describe("BM25 catalog index", () => {
  it("indexes input property names and descriptions", () => {
    const tools = [
      fixtureTool("alpha.lookup", "Look up one record.", {
        invoiceNumber: {
          type: "string",
          description: "Merchant receipt code.",
        },
      }),
      fixtureTool("beta.lookup", "Look up one record.", {
        contactId: {
          type: "string",
          description: "Customer contact identifier.",
        },
      }),
    ];

    expect(
      searchCatalogTools(tools, { query: "invoice number" })[0]?.name,
    ).toBe("alpha.lookup");
    expect(
      searchCatalogTools(tools, { query: "merchant receipt" })[0]?.name,
    ).toBe("alpha.lookup");
  });

  it("uses canonical-name order as a deterministic score tie-breaker", () => {
    const tools = [
      fixtureTool("zeta.lookup", "Retrieve an orchard record."),
      fixtureTool("alpha.lookup", "Retrieve an orchard record."),
    ];

    expect(
      searchCatalogTools(tools, { query: "orchard", limit: 2 }).map(
        ({ name }) => name,
      ),
    ).toEqual(["alpha.lookup", "zeta.lookup"]);
  });
});

describe("hybrid catalog index", () => {
  it("uses deterministic hash embeddings and caches document vectors", async () => {
    const provider = new HashEmbeddingProvider();
    const index = new CatalogToolSearchIndex([
      fixtureTool("fruit.find_apple", "Find a crisp green apple."),
      fixtureTool("fruit.find_banana", "Find a ripe yellow banana."),
    ]);

    const first = await index.searchHybrid(
      [
        fixtureTool("fruit.find_apple", "Find a crisp green apple."),
        fixtureTool("fruit.find_banana", "Find a ripe yellow banana."),
      ],
      {
        query: "ripe yellow banana",
        bm25Weight: 0,
        embeddingWeight: 1,
      },
      provider,
    );
    const second = await index.searchHybrid(
      [
        fixtureTool("fruit.find_apple", "Find a crisp green apple."),
        fixtureTool("fruit.find_banana", "Find a ripe yellow banana."),
      ],
      {
        query: "green apple",
        bm25Weight: 0,
        embeddingWeight: 1,
      },
      provider,
    );

    expect(first[0]?.name).toBe("fruit.find_banana");
    expect(second[0]?.name).toBe("fruit.find_apple");
    expect(provider.batches.map(({ length }) => length)).toEqual([2, 1, 1]);
  });

  it("builds lazily, reuses one registry index, and rebuilds after registration", async () => {
    const provider = new HashEmbeddingProvider();
    const registry = new CatalogRegistry({
      contracts: emailCapabilityContracts,
      triggerContracts: emailCapabilityTriggerContracts,
      manifests: [gmailManifest],
      embeddingProvider: provider,
    });

    expect(provider.batches).toEqual([]);
    await registry.searchTools({ query: "send an email", limit: 3 });
    await registry.searchTools({ query: "find an email", limit: 3 });
    expect(provider.batches.map(({ length }) => length)).toEqual([8, 1, 1]);

    registry.registerManifest(microsoftOutlookManifest);
    await registry.searchTools({ query: "send an email", limit: 3 });
    expect(provider.batches.map(({ length }) => length)).toEqual([
      8, 1, 1, 16, 1,
    ]);
  });

  it("does not call an embedding provider for an empty registry", async () => {
    const provider = new HashEmbeddingProvider();
    const registry = new CatalogRegistry({ embeddingProvider: provider });

    await expect(registry.searchTools({ query: "email" })).resolves.toEqual([]);
    expect(provider.batches).toEqual([]);
  });

  it("rejects a hybrid configuration with no scoring signal", async () => {
    const provider = new HashEmbeddingProvider();
    const tool = fixtureTool("fruit.find_banana", "Find a banana.");
    const index = new CatalogToolSearchIndex([tool]);

    await expect(
      index.searchHybrid(
        [tool],
        { query: "banana", bm25Weight: 0, embeddingWeight: 0 },
        provider,
      ),
    ).rejects.toThrow(
      "At least one hybrid search weight must be greater than zero.",
    );
  });
});

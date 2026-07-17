import { defaultCatalog } from "@eyeball/catalog";
import { describe, expect, it } from "vitest";
import {
  MAX_SEARCH_LIMIT,
  SearchToolInputError,
  searchTools,
  summarizeInputSchema,
} from "../src/search-tool.js";

describe("MCP tool search", () => {
  it("ranks exact canonical intent above broader description matches", () => {
    const result = searchTools(defaultCatalog.listTools(), {
      query: "gmail send email",
      limit: 4,
    });

    expect(result.tools[0]).toMatchObject({
      name: "gmail.send_email",
      capability: "email",
      toolkit: "gmail",
      inputSchema: {
        required: ["to", "subject", "body"],
        properties: {
          to: "array<string>",
          subject: "string",
          body: "string",
        },
      },
    });
    expect(result.tools).toHaveLength(4);
  });

  it("summarizes arrays, enums, unions, and references compactly", () => {
    expect(
      summarizeInputSchema({
        type: "object",
        properties: {
          names: { type: "array", items: { type: "string" } },
          state: { enum: ["open", "closed"] },
          nullable: { type: ["string", "null"] },
          linked: { $ref: "#/$defs/linked" },
        },
      }),
    ).toEqual({
      required: [],
      properties: {
        linked: "reference",
        names: "array<string>",
        nullable: "string | null",
        state: 'enum("open" | "closed")',
      },
    });
  });

  it("rejects ambiguous input instead of silently broadening a search", () => {
    expect(() =>
      searchTools(defaultCatalog.listTools(), { query: "" }),
    ).toThrow(SearchToolInputError);
    expect(() =>
      searchTools(defaultCatalog.listTools(), {
        query: "email",
        limit: MAX_SEARCH_LIMIT + 1,
      }),
    ).toThrow(`limit must be an integer from 1 through ${MAX_SEARCH_LIMIT}.`);
    expect(() =>
      searchTools(defaultCatalog.listTools(), {
        query: "email",
        extra: true,
      }),
    ).toThrow("Unknown search input field: extra.");
  });
});

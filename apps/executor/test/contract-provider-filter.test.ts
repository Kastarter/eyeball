import { describe, expect, it } from "vitest";
import {
  parseContractProviderFilter,
  validateContractProviderFilter,
} from "./contract/provider-filter.js";

describe("real contract provider filter", () => {
  it("accepts a trimmed comma-separated batch", () => {
    expect([
      ...(parseContractProviderFilter("gmail, google-drive") ?? []),
    ]).toEqual(["gmail", "google-drive"]);
  });

  it("rejects empty, malformed, and duplicate batches", () => {
    expect(() => parseContractProviderFilter("")).toThrow(/at least one/u);
    expect(() => parseContractProviderFilter("Gmail")).toThrow(/invalid slug/u);
    expect(() => parseContractProviderFilter("gmail,gmail")).toThrow(
      /duplicates/u,
    );
  });

  it("rejects provider slugs absent from the catalog", () => {
    expect(() =>
      validateContractProviderFilter(
        parseContractProviderFilter("gmail,unknown-provider"),
        ["gmail"],
      ),
    ).toThrow(/unknown-provider/u);
  });
});

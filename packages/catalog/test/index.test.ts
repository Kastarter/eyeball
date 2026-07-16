import { describe, expect, it } from "vitest";
import { CATALOG_VERSION, CatalogRegistry, VERSION } from "../src/index.js";

describe("@eyeball/catalog", () => {
  it("exports package and catalog versions from its public barrel", () => {
    expect(VERSION).toBe("0.0.1");
    expect(CATALOG_VERSION).toBe("1.1");
    expect(new CatalogRegistry().catalogVersion).toBe("1.1");
  });
});

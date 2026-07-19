import { describe, expect, it } from "vitest";
import { VERSION } from "../src/index.js";

describe("@eyeball/sdk", () => {
  it("exports its version", () => {
    expect(VERSION).toBe("0.2.0");
  });
});

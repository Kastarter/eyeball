import { describe, expect, it } from "vitest";
import { createStarterMockhouse } from "../src/index.js";

describe("createStarterMockhouse", () => {
  it("serves the mock status route in process", async () => {
    const { app } = createStarterMockhouse();

    const response = await app.request("http://mockhouse.test/_mock/status");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      providers: ["echo", "github", "gmail", "slack"],
    });
  });
});

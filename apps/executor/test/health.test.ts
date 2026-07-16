import { describe, expect, it } from "vitest";
import { app } from "../src/index.js";

describe("executor health endpoint", () => {
  it("reports that the service is healthy", async () => {
    const response = await app.request("/health");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      status: "ok",
      service: "executor",
    });
  });
});

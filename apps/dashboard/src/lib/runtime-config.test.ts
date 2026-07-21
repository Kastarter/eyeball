import { describe, expect, it } from "vitest";
import {
  dashboardDataSource,
  dashboardRuntimeConfig,
  isCloudMode,
} from "./runtime-config";

describe("dashboard runtime mode", () => {
  it("keeps demo mode and the existing data paths as the zero-config default", () => {
    const environment = {};

    expect(dashboardRuntimeConfig(environment)).toEqual({
      cloudUrlConfigured: false,
      mode: "demo",
    });
    expect(dashboardDataSource("connections", environment)).toBe("executor");
    expect(dashboardDataSource("toolkits", environment)).toBe("catalog");
    expect(dashboardDataSource("executions", environment)).toBe("executor");
    expect(dashboardDataSource("voiceAgents", environment)).toBe("executor");
    expect(dashboardDataSource("webhooks", environment)).toBe("executor");
    expect(dashboardDataSource("auth", environment)).toBe("demo");
  });

  it("gates control-plane features behind the explicit cloud mode", () => {
    const environment = {
      EYEBALL_CLOUD_URL: "https://cloud.example",
      NEXT_PUBLIC_EYEBALL_MODE: "cloud",
    };

    expect(isCloudMode(environment)).toBe(true);
    for (const feature of [
      "auth",
      "organizations",
      "connections",
      "apiKeys",
      "audit",
    ] as const) {
      expect(dashboardDataSource(feature, environment)).toBe("cloud-control");
    }
    expect(dashboardDataSource("executions", environment)).toBe("executor");
    expect(dashboardDataSource("webhooks", environment)).toBe("executor");
  });

  it("does not silently enable cloud mode from a URL alone", () => {
    const environment = { EYEBALL_CLOUD_URL: "https://cloud.example" };

    expect(dashboardRuntimeConfig(environment)).toEqual({
      cloudUrlConfigured: true,
      mode: "demo",
    });
  });
});

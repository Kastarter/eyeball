import { describe, expect, it } from "vitest";
import { getCatalogWebhookTriggerOptions } from "./catalog";

describe("dashboard catalog webhook trigger options", () => {
  it("derives a sorted, unique exact-trigger inventory with catalog metadata", () => {
    const options = getCatalogWebhookTriggerOptions();
    const values = options.map((option) => option.value);

    expect(options.length).toBeGreaterThan(0);
    expect(values.every((value) => value.startsWith("trigger."))).toBe(true);
    expect(values).toEqual([...values].sort());
    expect(new Set(values).size).toBe(values.length);
    expect(values).toContain("trigger.gmail.email_received");
    expect(values).toContain("trigger.slack.message_received");
    expect(
      options.every(
        (option) =>
          option.description.length > 0 &&
          option.toolkit.length > 0 &&
          option.label.length > 0,
      ),
    ).toBe(true);
  });
});

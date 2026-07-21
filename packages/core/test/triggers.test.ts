import { describe, expect, it } from "vitest";
import {
  createTriggerEventArrivalId,
  isTriggerEventArrivalId,
} from "../src/triggers.js";

describe("trigger event arrival IDs", () => {
  it("creates random and deterministic trgevt identifiers", () => {
    expect(createTriggerEventArrivalId()).toMatch(/^trgevt_[A-Za-z0-9_-]+$/u);
    expect(createTriggerEventArrivalId("arrival_1")).toBe("trgevt_arrival_1");
  });

  it("recognizes only valid arrival identifiers", () => {
    expect(isTriggerEventArrivalId("trgevt_arrival-1")).toBe(true);
    expect(isTriggerEventArrivalId("trgsub_arrival-1")).toBe(false);
    expect(isTriggerEventArrivalId("trgevt_ bad")).toBe(false);
    expect(isTriggerEventArrivalId("trgevt_")).toBe(false);
  });

  it("rejects empty, oversized, and illegal seeds", () => {
    expect(() => createTriggerEventArrivalId("")).toThrow();
    expect(() => createTriggerEventArrivalId("a".repeat(129))).toThrow();
    expect(() => createTriggerEventArrivalId("bad.value")).toThrow();
  });
});

import { describe, expect, it } from "vitest";
import {
  buildNameMap,
  fromRestrictedToolName,
  isCanonicalToolName,
  toRestrictedToolName,
  validateCanonicalToolName,
} from "../src/index.js";

describe("canonical tool naming", () => {
  it.each([
    ["gmail.send_email", "gmail__send_email"],
    ["twilio.start_call", "twilio__start_call"],
    ["instagram-data.get_post", "instagram-data__get_post"],
  ] as const)("round-trips %s", (canonical, wire) => {
    expect(toRestrictedToolName(canonical)).toBe(wire);
    expect(fromRestrictedToolName(wire)).toBe(canonical);
  });

  it.each([
    "Gmail.send_email",
    "gmail.Send_email",
    "gmail.send-email",
    "gmail.1send_email",
    "google_calendar.create_event",
    "gmail.send__email",
    "gmail.send.email",
  ])("rejects invalid canonical grammar: %s", (name) => {
    expect(isCanonicalToolName(name)).toBe(false);
    expect(() => validateCanonicalToolName(name)).toThrow(
      "Invalid canonical tool name",
    );
  });

  it("enforces the 63-character canonical and 64-character wire limits", () => {
    const canonical = `a.${"b".repeat(61)}` as `${string}.${string}`;
    expect(canonical).toHaveLength(63);
    expect(toRestrictedToolName(canonical)).toHaveLength(64);

    const tooLong = `a.${"b".repeat(62)}` as `${string}.${string}`;
    expect(() => toRestrictedToolName(tooLong)).toThrow(
      "Invalid canonical tool name",
    );
  });

  it.each([
    "gmail_send_email",
    "gmail___send_email",
    "gmail__send__email",
  ])("rejects an unknown or ambiguous wire name: %s", (wire) => {
    expect(() => fromRestrictedToolName(wire)).toThrow();
  });

  it("builds immutable bidirectional maps", () => {
    const map = buildNameMap([
      { name: "gmail.send_email" },
      { name: "twilio.start_call" },
    ]);

    expect(map.canonicalToWire["gmail.send_email"]).toBe("gmail__send_email");
    expect(map.wireToCanonical.gmail__send_email).toBe("gmail.send_email");
    expect(Object.isFrozen(map.canonicalToWire)).toBe(true);
    expect(Object.isFrozen(map.wireToCanonical)).toBe(true);
  });

  it("fails catalog compilation on duplicate canonical names", () => {
    expect(() =>
      buildNameMap([
        { name: "gmail.send_email" },
        { name: "gmail.send_email" },
      ]),
    ).toThrow("Canonical tool name collision");
  });

  it("rejects collision-prone double-underscore components", () => {
    expect(() =>
      buildNameMap([{ name: "gmail.send__email" as `${string}.${string}` }]),
    ).toThrow("Invalid canonical tool name");
  });
});

import { describe, expect, it } from "vitest";
import { materializeApiKeyring, parseApiKeyring } from "../src/index.js";

describe("API keyring", () => {
  it("parses project-scoped and user-pinned entries", () => {
    expect(
      Object.fromEntries(
        parseApiKeyring("project-key:proj-a,pinned-key:proj-b:user-7"),
      ),
    ).toEqual({
      "project-key": { projectId: "proj-a" },
      "pinned-key": { projectId: "proj-b", userId: "user-7" },
    });
  });

  it.each([
    "missing-project",
    "key:project:user:extra",
    "key::user",
    "key:project,key:other",
  ])("rejects malformed or duplicate entries: %s", (value) => {
    expect(() => parseApiKeyring(value)).toThrow();
  });

  it("accepts typed keyring principals while preserving legacy project strings", () => {
    expect(
      Object.fromEntries(
        materializeApiKeyring({
          legacy: "proj-a",
          pinned: { projectId: "proj-a", userId: "user-a" },
        }),
      ),
    ).toEqual({
      legacy: { projectId: "proj-a" },
      pinned: { projectId: "proj-a", userId: "user-a" },
    });
  });
});

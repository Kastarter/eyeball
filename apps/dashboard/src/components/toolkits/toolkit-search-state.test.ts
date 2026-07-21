import { describe, expect, it } from "vitest";
import {
  type ToolkitSearchState,
  toolkitSearchReducer,
} from "./toolkit-search-state";

describe("toolkit search state", () => {
  it("does not apply a delayed response from an earlier query", () => {
    const first = toolkitSearchReducer(
      { kind: "idle" },
      { query: "draft", type: "started" },
    );
    const second = toolkitSearchReducer(first, {
      query: "calendar",
      type: "started",
    });
    const stale = toolkitSearchReducer(second, {
      matchedToolkitSlugs: new Set(["gmail"]),
      query: "draft",
      type: "succeeded",
    });

    expect(stale).toEqual({ kind: "loading", query: "calendar" });
  });

  it("clears an error on retry and accepts the successful response", () => {
    const failed: ToolkitSearchState = {
      kind: "error",
      message: "Catalog search failed with HTTP 503.",
      query: "send email",
    };
    const retrying = toolkitSearchReducer(failed, {
      query: "send email",
      type: "started",
    });
    const ready = toolkitSearchReducer(retrying, {
      matchedToolkitSlugs: new Set(["gmail"]),
      query: "send email",
      type: "succeeded",
    });

    expect(retrying).toEqual({ kind: "loading", query: "send email" });
    expect(ready).toMatchObject({ kind: "ready", query: "send email" });
    expect(
      ready.kind === "ready" && ready.matchedToolkitSlugs.has("gmail"),
    ).toBe(true);
  });

  it("surfaces a malformed-response rejection for the active query", () => {
    const loading = toolkitSearchReducer(
      { kind: "idle" },
      { query: "draft", type: "started" },
    );

    expect(
      toolkitSearchReducer(loading, {
        message: "Catalog search returned an invalid response.",
        query: "draft",
        type: "failed",
      }),
    ).toEqual({
      kind: "error",
      message: "Catalog search returned an invalid response.",
      query: "draft",
    });
  });
});

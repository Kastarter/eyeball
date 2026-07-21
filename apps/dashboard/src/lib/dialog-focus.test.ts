import { describe, expect, it, vi } from "vitest";
import { wrapDialogFocus } from "./dialog-focus";

describe("dialog focus loop", () => {
  it("wraps forward from the last control to the first", () => {
    const first = { focus: vi.fn() };
    const last = { focus: vi.fn() };
    const preventDefault = vi.fn();

    expect(
      wrapDialogFocus(
        { key: "Tab", preventDefault, shiftKey: false },
        [first, last],
        last,
      ),
    ).toBe(true);
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(first.focus).toHaveBeenCalledOnce();
  });

  it("wraps backward from the first control to the last", () => {
    const first = { focus: vi.fn() };
    const last = { focus: vi.fn() };
    const preventDefault = vi.fn();

    expect(
      wrapDialogFocus(
        { key: "Tab", preventDefault, shiftKey: true },
        [first, last],
        first,
      ),
    ).toBe(true);
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(last.focus).toHaveBeenCalledOnce();
  });
});

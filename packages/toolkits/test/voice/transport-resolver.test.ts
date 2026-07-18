import { describe, expect, it } from "vitest";
import { resolveOutboundTransport } from "../../src/voice/transport-resolver.js";

const binding = {
  phoneNumber: "+15550002222",
  transportConnectionId: "conn_twilio_fixture",
} as const;

describe("resolveOutboundTransport", () => {
  it("uses a complete explicit telephony selection", () => {
    expect(
      resolveOutboundTransport({
        mode: "remote-worker",
        bindings: [],
        from: "+15550001111",
        transportConnectionId: "conn_explicit",
      }),
    ).toEqual({
      kind: "telephony",
      source: "explicit",
      from: "+15550001111",
      transportConnectionId: "conn_explicit",
    });
  });

  it("defaults to the sole attached number", () => {
    expect(
      resolveOutboundTransport({
        mode: "remote-worker",
        bindings: [binding],
      }),
    ).toEqual({
      kind: "telephony",
      source: "binding",
      from: binding.phoneNumber,
      transportConnectionId: binding.transportConnectionId,
    });
  });

  it("resolves partial input through one attached number", () => {
    expect(
      resolveOutboundTransport({
        mode: "remote-worker",
        bindings: [binding],
        from: binding.phoneNumber,
      }),
    ).toEqual({
      kind: "telephony",
      source: "binding",
      from: binding.phoneNumber,
      transportConnectionId: binding.transportConnectionId,
    });
  });

  it("uses the deterministic fake transport only in development", () => {
    expect(
      resolveOutboundTransport({ mode: "development", bindings: [] }),
    ).toEqual({ kind: "development-fake" });
  });

  it("rejects missing remote-worker transport configuration", () => {
    expect(() =>
      resolveOutboundTransport({ mode: "remote-worker", bindings: [] }),
    ).toThrowError(
      expect.objectContaining({
        code: "invalid_input",
        message: expect.stringContaining("requires an explicit transport"),
      }),
    );
  });

  it("rejects ambiguous attached-number defaults", () => {
    expect(() =>
      resolveOutboundTransport({
        mode: "remote-worker",
        bindings: [
          binding,
          {
            phoneNumber: "+15550003333",
            transportConnectionId: "conn_twilio_fixture",
          },
        ],
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "invalid_input",
        message: expect.stringContaining("multiple attached numbers"),
      }),
    );
  });

  it("rejects an explicit connection that conflicts with a binding", () => {
    expect(() =>
      resolveOutboundTransport({
        mode: "remote-worker",
        bindings: [binding],
        from: binding.phoneNumber,
        transportConnectionId: "conn_other",
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "invalid_input",
        message: expect.stringContaining("different transport connection"),
      }),
    );
  });
});

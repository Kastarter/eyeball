import { EyeballError, TOOL_ERROR_CODES } from "@eyeball/core";

export interface OutboundNumberBinding {
  phoneNumber: string;
  transportConnectionId: string;
}

export interface OutboundTransportSelectionInput {
  mode: "development" | "remote-worker";
  bindings: readonly OutboundNumberBinding[];
  from?: string;
  transportConnectionId?: string;
}

export type OutboundTransportSelection =
  | {
      kind: "telephony";
      source: "explicit" | "binding";
      from: string;
      transportConnectionId: string;
    }
  | { kind: "development-fake" };

function invalid(message: string): never {
  throw new EyeballError({
    code: TOOL_ERROR_CODES.INVALID_INPUT,
    message: `voice-agents.start_agent_call: ${message}`,
  });
}

/** RFC 002 deterministic outbound transport defaulting policy. */
export function resolveOutboundTransport(
  input: OutboundTransportSelectionInput,
): OutboundTransportSelection {
  const { bindings, from, transportConnectionId } = input;
  if (from !== undefined && transportConnectionId !== undefined) {
    const boundNumber = bindings.find(
      (binding) => binding.phoneNumber === from,
    );
    if (
      boundNumber !== undefined &&
      boundNumber.transportConnectionId !== transportConnectionId
    ) {
      return invalid(
        `number ${from} is bound to a different transport connection.`,
      );
    }
    return {
      kind: "telephony",
      source: "explicit",
      from,
      transportConnectionId,
    };
  }

  if (from !== undefined || transportConnectionId !== undefined) {
    const matching = bindings.filter(
      (binding) =>
        (from === undefined || binding.phoneNumber === from) &&
        (transportConnectionId === undefined ||
          binding.transportConnectionId === transportConnectionId),
    );
    if (matching.length !== 1) {
      return invalid(
        "partial transport input must resolve to exactly one attached number.",
      );
    }
    const binding = matching[0];
    if (binding === undefined) {
      throw new Error("Outbound transport resolver invariant violated.");
    }
    return {
      kind: "telephony",
      source: "binding",
      from: binding.phoneNumber,
      transportConnectionId: binding.transportConnectionId,
    };
  }

  if (bindings.length === 1) {
    const binding = bindings[0];
    if (binding === undefined) {
      throw new Error("Outbound transport resolver invariant violated.");
    }
    return {
      kind: "telephony",
      source: "binding",
      from: binding.phoneNumber,
      transportConnectionId: binding.transportConnectionId,
    };
  }
  if (bindings.length > 1) {
    return invalid(
      "multiple attached numbers are available; provide from or transportConnectionId.",
    );
  }
  if (input.mode === "development") return { kind: "development-fake" };
  return invalid(
    "remote-worker mode requires an explicit transport or one attached number.",
  );
}

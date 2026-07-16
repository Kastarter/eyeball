import {
  type AdapterContext,
  EyeballError,
  type JsonValue,
  TOOL_ERROR_CODES,
  type ToolkitAdapter,
} from "@eyeball/core";
import { createProviderHttpClient } from "../http-client.js";
import {
  asJson,
  isoString,
  jsonObject,
  numberValue,
  providerError,
  records,
  requiredStringField,
  stringValue,
  unsupportedTool,
} from "../messaging/common.js";

function accountSid(context: AdapterContext): string {
  if (context.credential.type !== "basic") {
    throw new EyeballError({
      code: TOOL_ERROR_CODES.AUTH_MISSING,
      message: "Twilio requires an Account SID and Auth Token.",
    });
  }
  return context.credential.username;
}

function formRequest(values: Readonly<Record<string, string>>): RequestInit {
  return {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(values).toString(),
  };
}

function direction(value: unknown): "inbound" | "outbound" {
  return value === "inbound" ? "inbound" : "outbound";
}

function callState(context: AdapterContext, value: unknown): string {
  switch (value) {
    case "initiated":
    case "queued":
      return "queued";
    case "ringing":
    case "in-progress":
    case "completed":
    case "busy":
    case "no-answer":
    case "failed":
    case "canceled":
      return value;
    default:
      throw providerError(context, "Twilio returned an unknown call status.");
  }
}

function twilioCall(
  context: AdapterContext,
  value: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const durationValue = value.duration;
  const duration =
    typeof durationValue === "string" || typeof durationValue === "number"
      ? Number(durationValue)
      : 0;
  if (!Number.isFinite(duration) || duration < 0) {
    throw new EyeballError({
      code: TOOL_ERROR_CODES.PROVIDER_ERROR,
      message: "Twilio returned an invalid call duration.",
      providerDetail: { toolkit: context.tool.toolkit },
    });
  }
  const transfers = Array.isArray(value.transfers)
    ? value.transfers.filter(
        (candidate): candidate is string => typeof candidate === "string",
      )
    : [];
  return {
    callId: requiredStringField(context, value, "sid"),
    state: callState(context, value.status),
    to: requiredStringField(context, value, "to"),
    from: requiredStringField(context, value, "from"),
    direction: direction(value.direction),
    createdAt: isoString(context, value.date_created, "date_created"),
    updatedAt: isoString(context, value.date_updated, "date_updated"),
    ...(typeof value.start_time === "string"
      ? { startedAt: isoString(context, value.start_time, "start_time") }
      : {}),
    ...(typeof value.end_time === "string"
      ? { endedAt: isoString(context, value.end_time, "end_time") }
      : {}),
    durationSeconds: Math.floor(duration),
    transfers,
  };
}

function parseOffset(
  context: AdapterContext,
  token: string | undefined,
): number {
  if (token === undefined) {
    return 0;
  }
  const match = /^offset:(\d+)$/u.exec(token);
  const offset = match === null ? Number.NaN : Number(match[1]);
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new EyeballError({
      code: TOOL_ERROR_CODES.INVALID_INPUT,
      message: `${context.tool.name}: pageToken is invalid.`,
    });
  }
  return offset;
}

async function twilioRequest(
  context: AdapterContext,
  path: string,
  init?: RequestInit,
): Promise<Readonly<Record<string, unknown>>> {
  return jsonObject(
    context,
    await createProviderHttpClient(context)(path, init),
  );
}

export class TwilioAdapter implements ToolkitAdapter {
  readonly toolkitSlug = "twilio";

  async execute(context: AdapterContext): Promise<JsonValue> {
    switch (context.tool.name) {
      case "twilio.start_call":
        return this.startCall(context);
      case "twilio.get_call":
        return this.getCall(context);
      case "twilio.list_calls":
        return this.listCalls(context);
      case "twilio.end_call":
        return this.updateCall(context, { Status: "completed" });
      case "twilio.transfer_call":
        return this.updateCall(context, {
          TransferTo: requiredStringField(
            context,
            context.canonicalInput,
            "to",
          ),
        });
      case "twilio.send_dtmf":
        return this.sendDtmf(context);
      default:
        return unsupportedTool(context);
    }
  }

  private async startCall(context: AdapterContext): Promise<JsonValue> {
    const input = context.canonicalInput;
    const values: Record<string, string> = {
      To: requiredStringField(context, input, "to"),
      From: requiredStringField(context, input, "from"),
    };
    const callback = stringValue(input, "statusCallbackUrl");
    const voiceAgentId = stringValue(input, "voiceAgentId");
    if (callback !== undefined) {
      values.StatusCallback = callback;
    }
    if (voiceAgentId !== undefined) {
      values.VoiceAgentId = voiceAgentId;
    }
    const body = await twilioRequest(
      context,
      `2010-04-01/Accounts/${encodeURIComponent(accountSid(context))}/Calls.json`,
      formRequest(values),
    );
    return asJson(twilioCall(context, body));
  }

  private async getCall(context: AdapterContext): Promise<JsonValue> {
    const body = await twilioRequest(
      context,
      `2010-04-01/Accounts/${encodeURIComponent(accountSid(context))}/Calls/${encodeURIComponent(requiredStringField(context, context.canonicalInput, "callId"))}.json`,
    );
    return asJson(twilioCall(context, body));
  }

  private async listCalls(context: AdapterContext): Promise<JsonValue> {
    const input = context.canonicalInput;
    const search = new URLSearchParams();
    const state = stringValue(input, "state");
    const to = stringValue(input, "to");
    const from = stringValue(input, "from");
    if (state !== undefined) search.set("Status", state);
    if (to !== undefined) search.set("To", to);
    if (from !== undefined) search.set("From", from);
    const suffix = search.size === 0 ? "" : `?${search.toString()}`;
    const body = await twilioRequest(
      context,
      `2010-04-01/Accounts/${encodeURIComponent(accountSid(context))}/Calls.json${suffix}`,
    );
    const normalized = records(body.calls)
      .map((call) => twilioCall(context, call))
      .filter((call) => {
        const createdAt = String(call.createdAt);
        const after = stringValue(input, "createdAfter");
        const before = stringValue(input, "createdBefore");
        return (
          (from === undefined || call.from === from) &&
          (after === undefined || createdAt >= after) &&
          (before === undefined || createdAt < before)
        );
      });
    const offset = parseOffset(context, stringValue(input, "pageToken"));
    const pageSize = numberValue(input, "pageSize") ?? 50;
    const calls = normalized.slice(offset, offset + pageSize);
    const nextOffset = offset + calls.length;
    return asJson({
      calls,
      ...(nextOffset < normalized.length
        ? { nextPageToken: `offset:${nextOffset}` }
        : {}),
    });
  }

  private async updateCall(
    context: AdapterContext,
    values: Readonly<Record<string, string>>,
  ): Promise<JsonValue> {
    const body = await twilioRequest(
      context,
      `2010-04-01/Accounts/${encodeURIComponent(accountSid(context))}/Calls/${encodeURIComponent(requiredStringField(context, context.canonicalInput, "callId"))}.json`,
      formRequest(values),
    );
    return asJson(twilioCall(context, body));
  }

  private async sendDtmf(context: AdapterContext): Promise<JsonValue> {
    const digits = requiredStringField(
      context,
      context.canonicalInput,
      "digits",
    );
    const body = await twilioRequest(
      context,
      `2010-04-01/Accounts/${encodeURIComponent(accountSid(context))}/Calls/${encodeURIComponent(requiredStringField(context, context.canonicalInput, "callId"))}.json`,
      formRequest({ Digits: digits }),
    );
    return asJson({
      callId: requiredStringField(context, body, "sid"),
      state: callState(context, body.status),
      digitsSent: digits,
    });
  }
}

export const twilioAdapter = new TwilioAdapter();

import type { AdapterContext, JsonValue, ToolkitAdapter } from "@eyeball/core";
import { createProviderHttpClient } from "../http-client.js";
import {
  asJson,
  jsonObject,
  jsonRequest,
  numberValue,
  requiredRecordField,
  requiredStringField,
  stringValue,
  unsupportedTool,
} from "../messaging/common.js";

async function liveKitRequest(
  context: AdapterContext,
  path: string,
  body: Readonly<Record<string, unknown>>,
): Promise<Readonly<Record<string, unknown>>> {
  return jsonObject(
    context,
    await createProviderHttpClient(context)(path, jsonRequest(body)),
  );
}

function createdAt(
  context: AdapterContext,
  room: Readonly<Record<string, unknown>>,
): string {
  const seconds = numberValue(room, "creationTime");
  if (seconds === undefined) {
    return requiredStringField(context, room, "createdAt");
  }
  return new Date(seconds * 1_000).toISOString();
}

export class LiveKitAdapter implements ToolkitAdapter {
  readonly toolkitSlug = "livekit";

  async execute(context: AdapterContext): Promise<JsonValue> {
    switch (context.tool.name) {
      case "livekit.create_room":
        return this.createRoom(context);
      case "livekit.join_room":
        return this.joinRoom(context);
      default:
        return unsupportedTool(context);
    }
  }

  private async createRoom(context: AdapterContext): Promise<JsonValue> {
    const input = context.canonicalInput;
    const room = await liveKitRequest(
      context,
      "twirp/livekit.RoomService/CreateRoom",
      {
        name: requiredStringField(context, input, "roomName"),
        emptyTimeout: numberValue(input, "emptyTimeoutSeconds") ?? 300,
        maxParticipants: numberValue(input, "maxParticipants") ?? 20,
        metadata: stringValue(input, "metadata") ?? "",
      },
    );
    return asJson({
      roomId: requiredStringField(context, room, "sid"),
      roomName: requiredStringField(context, room, "name"),
      state: requiredStringField(context, room, "state"),
      createdAt: createdAt(context, room),
      participantCount: numberValue(room, "numParticipants") ?? 0,
    });
  }

  private async joinRoom(context: AdapterContext): Promise<JsonValue> {
    const input = context.canonicalInput;
    const roomName = requiredStringField(context, input, "roomName");
    const participantIdentity = requiredStringField(
      context,
      input,
      "participantIdentity",
    );
    const tokenTtlSeconds = numberValue(input, "tokenTtlSeconds") ?? 3_600;
    const tokenBody = await liveKitRequest(context, "_mock/token", {
      room: roomName,
      identity: participantIdentity,
      ttlSeconds: tokenTtlSeconds,
    });
    const joined = await liveKitRequest(
      context,
      `_mock/rooms/${encodeURIComponent(roomName)}/join`,
      {
        identity: participantIdentity,
        name: stringValue(input, "participantName") ?? participantIdentity,
        metadata: stringValue(input, "metadata") ?? "",
      },
    );
    const room = requiredRecordField(context, joined, "room");
    const participant = requiredRecordField(context, joined, "participant");
    return asJson({
      roomId: requiredStringField(context, room, "sid"),
      roomName: requiredStringField(context, room, "name"),
      participantId: requiredStringField(context, participant, "sid"),
      participantIdentity: requiredStringField(
        context,
        participant,
        "identity",
      ),
      token: requiredStringField(context, tokenBody, "token"),
      expiresAt: new Date(
        context.clock.now().valueOf() + tokenTtlSeconds * 1_000,
      ).toISOString(),
      serverUrl: new URL(context.baseUrl).toString(),
    });
  }
}

export const liveKitAdapter = new LiveKitAdapter();

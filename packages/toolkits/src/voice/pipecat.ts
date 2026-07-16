import type { AdapterContext, JsonValue, ToolkitAdapter } from "@eyeball/core";
import { createProviderHttpClient } from "../http-client.js";
import {
  asJson,
  isRecord,
  jsonObject,
  jsonRequest,
  numberValue,
  requiredStringField,
  unsupportedTool,
} from "../messaging/common.js";

async function pipecatRequest(
  context: AdapterContext,
  path: string,
  init?: RequestInit,
): Promise<Readonly<Record<string, unknown>>> {
  return jsonObject(
    context,
    await createProviderHttpClient(context)(path, init),
  );
}

function pipeline(
  context: AdapterContext,
  value: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  return {
    pipelineId: requiredStringField(context, value, "id"),
    projectId: requiredStringField(context, value, "projectId"),
    userId: requiredStringField(context, value, "userId"),
    agentId: requiredStringField(context, value, "agentId"),
    agentRevision: numberValue(value, "agentRevision") ?? 1,
    transport: requiredStringField(context, value, "transport"),
    state: requiredStringField(context, value, "state"),
    createdAt: requiredStringField(context, value, "createdAt"),
    ...(typeof value.startedAt === "string"
      ? { startedAt: value.startedAt }
      : {}),
    ...(typeof value.completedAt === "string"
      ? { completedAt: value.completedAt }
      : {}),
    lastEventSequence: numberValue(value, "lastEventSequence") ?? 0,
  };
}

export class PipecatAdapter implements ToolkitAdapter {
  readonly toolkitSlug = "pipecat";

  async execute(context: AdapterContext): Promise<JsonValue> {
    switch (context.tool.name) {
      case "pipecat.start_voice_pipeline": {
        const supplied = context.canonicalInput.agentConfig;
        const agentConfig = isRecord(supplied) ? supplied : {};
        const body = await pipecatRequest(
          context,
          "sessions",
          jsonRequest({
            agentConfig: {
              ...agentConfig,
              projectId: context.projectId,
              userId: context.userId,
            },
            ...(Array.isArray(context.canonicalInput.script)
              ? { script: context.canonicalInput.script }
              : {}),
          }),
        );
        return asJson({ pipeline: pipeline(context, body) });
      }
      case "pipecat.get_voice_pipeline": {
        const body = await pipecatRequest(
          context,
          `sessions/${encodeURIComponent(requiredStringField(context, context.canonicalInput, "pipelineId"))}`,
        );
        return asJson({ pipeline: pipeline(context, body) });
      }
      default:
        return unsupportedTool(context);
    }
  }
}

export const pipecatAdapter = new PipecatAdapter();

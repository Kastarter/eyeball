import type { AdapterContext, JsonValue, ToolkitAdapter } from "@eyeball/core";
import { createProviderHttpClient } from "../http-client.js";
import {
  asJson,
  jsonObject,
  jsonRequest,
  numberValue,
  requiredStringField,
  stringValue,
  unsupportedTool,
} from "../messaging/common.js";

export class ElevenLabsAdapter implements ToolkitAdapter {
  readonly toolkitSlug = "elevenlabs";

  async execute(context: AdapterContext): Promise<JsonValue> {
    if (context.tool.name !== "elevenlabs.synthesize_speech") {
      return unsupportedTool(context);
    }
    const input = context.canonicalInput;
    const voiceId = requiredStringField(context, input, "voiceId");
    const response = await createProviderHttpClient(context)(
      `v1/text-to-speech/${encodeURIComponent(voiceId)}`,
      jsonRequest({
        text: requiredStringField(context, input, "text"),
        ...(stringValue(input, "modelId") === undefined
          ? {}
          : { model_id: stringValue(input, "modelId") }),
        voice_settings: {
          ...(numberValue(input, "stability") === undefined
            ? {}
            : { stability: numberValue(input, "stability") }),
          ...(numberValue(input, "similarityBoost") === undefined
            ? {}
            : { similarity_boost: numberValue(input, "similarityBoost") }),
        },
      }),
    );
    const body = await jsonObject(context, response);
    return asJson({
      audioRef: requiredStringField(context, body, "audio_ref"),
      characters: numberValue(body, "characters") ?? 0,
      audioFormat: stringValue(input, "audioFormat") ?? "mp3",
    });
  }
}

export const elevenLabsAdapter = new ElevenLabsAdapter();

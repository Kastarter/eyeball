import type { AdapterContext, JsonValue, ToolkitAdapter } from "@eyeball/core";
import { createProviderHttpClient } from "../http-client.js";
import {
  asJson,
  booleanValue,
  jsonObject,
  jsonRequest,
  numberValue,
  records,
  requiredRecordField,
  requiredStringField,
  stringValue,
  unsupportedTool,
} from "../messaging/common.js";

export class DeepgramAdapter implements ToolkitAdapter {
  readonly toolkitSlug = "deepgram";

  async execute(context: AdapterContext): Promise<JsonValue> {
    if (context.tool.name !== "deepgram.transcribe_audio") {
      return unsupportedTool(context);
    }
    const input = context.canonicalInput;
    const search = new URLSearchParams();
    const model = stringValue(input, "model");
    const language = stringValue(input, "language");
    if (model !== undefined) search.set("model", model);
    if (language !== undefined) search.set("language", language);
    search.set(
      "smart_format",
      String(booleanValue(input, "smartFormat") ?? true),
    );
    const response = await createProviderHttpClient(context)(
      `v1/listen?${search.toString()}`,
      jsonRequest({
        audio_ref: requiredStringField(context, input, "audioRef"),
      }),
    );
    const body = await jsonObject(context, response);
    const results = requiredRecordField(context, body, "results");
    const channel = records(results.channels)[0];
    const alternative =
      channel === undefined ? undefined : records(channel.alternatives)[0];
    if (alternative === undefined) {
      return asJson({ text: "", confidence: 0, words: [] });
    }
    return asJson({
      text: requiredStringField(context, alternative, "transcript"),
      confidence: numberValue(alternative, "confidence") ?? 0,
      ...(language === undefined ? {} : { language }),
      words: records(alternative.words).map((word) => ({
        word: requiredStringField(context, word, "word"),
        startMs: Math.round((numberValue(word, "start") ?? 0) * 1_000),
        endMs: Math.round((numberValue(word, "end") ?? 0) * 1_000),
        confidence: numberValue(word, "confidence") ?? 0,
      })),
    });
  }
}

export const deepgramAdapter = new DeepgramAdapter();

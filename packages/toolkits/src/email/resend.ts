import type { AdapterContext, JsonValue, ToolkitAdapter } from "@eyeball/core";
import { createProviderHttpClient } from "../http-client.js";
import {
  acceptedRecipients,
  asJson,
  assertNoAttachments,
  bodyPayload,
  jsonObject,
  jsonRequest,
  requiredProviderString,
  requiredStringField,
  stringArrayValue,
  stringValue,
  unsupportedTool,
} from "./common.js";

export class ResendAdapter implements ToolkitAdapter {
  readonly toolkitSlug = "resend";

  async execute(context: AdapterContext): Promise<JsonValue> {
    if (context.tool.name !== "resend.send_email") {
      return unsupportedTool(context);
    }
    assertNoAttachments(context);
    const input = context.canonicalInput;
    const response = await createProviderHttpClient(context)("emails", {
      ...jsonRequest({
        from: requiredProviderString(context, this.toolkitSlug, "from"),
        to: stringArrayValue(input, "to"),
        cc: stringArrayValue(input, "cc"),
        bcc: stringArrayValue(input, "bcc"),
        subject: stringValue(input, "subject") ?? "",
        ...bodyPayload(input),
        ...(stringValue(input, "replyTo") === undefined
          ? {}
          : { reply_to: stringValue(input, "replyTo") }),
      }),
    });
    const body = await jsonObject(context, response);
    return asJson({
      messageId: requiredStringField(context, body, "id"),
      acceptedRecipients: acceptedRecipients(input),
    });
  }
}

export const resendAdapter = new ResendAdapter();

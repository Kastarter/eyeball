import type { AdapterContext, JsonValue, ToolkitAdapter } from "@eyeball/core";
import { createProviderHttpClient } from "../http-client.js";
import {
  acceptedRecipients,
  asJson,
  assertNoAttachments,
  jsonRequest,
  optionalProviderString,
  providerError,
  requiredProviderString,
  stringArrayValue,
  stringValue,
  unsupportedTool,
} from "./common.js";

function addresses(values: readonly string[]) {
  return values.map((email) => ({ email }));
}

export class SendGridAdapter implements ToolkitAdapter {
  readonly toolkitSlug = "sendgrid";

  async execute(context: AdapterContext): Promise<JsonValue> {
    if (context.tool.name !== "sendgrid.send_email") {
      return unsupportedTool(context);
    }
    assertNoAttachments(context);
    const input = context.canonicalInput;
    const fromName = optionalProviderString(
      context,
      this.toolkitSlug,
      "fromName",
    );
    const response = await createProviderHttpClient(context)("v3/mail/send", {
      ...jsonRequest({
        personalizations: [
          {
            to: addresses(stringArrayValue(input, "to")),
            cc: addresses(stringArrayValue(input, "cc")),
            bcc: addresses(stringArrayValue(input, "bcc")),
            subject: stringValue(input, "subject") ?? "",
          },
        ],
        from: {
          email: requiredProviderString(context, this.toolkitSlug, "from"),
          ...(fromName === undefined ? {} : { name: fromName }),
        },
        content: [
          {
            type:
              stringValue(input, "bodyFormat") === "html"
                ? "text/html"
                : "text/plain",
            value: stringValue(input, "body") ?? "",
          },
        ],
        ...(stringValue(input, "replyTo") === undefined
          ? {}
          : { reply_to: { email: stringValue(input, "replyTo") } }),
      }),
    });
    const messageId = response.headers.get("x-message-id");
    if (messageId === null || messageId.length === 0) {
      throw providerError(
        context,
        "SendGrid accepted the email without returning x-message-id.",
      );
    }
    return asJson({
      messageId,
      acceptedRecipients: acceptedRecipients(input),
    });
  }
}

export const sendGridAdapter = new SendGridAdapter();

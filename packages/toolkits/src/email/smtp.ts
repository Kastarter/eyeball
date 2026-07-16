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
  stringValue,
  unsupportedTool,
} from "./common.js";

function smtpHttpFacadeClient(context: AdapterContext) {
  const fixturePassword =
    context.credential.type === "basic" &&
    context.credential.password.startsWith("fixture:")
      ? context.credential.password
      : undefined;
  return createProviderHttpClient(
    context,
    fixturePassword === undefined
      ? {}
      : { authorization: `Bearer ${fixturePassword}` },
  );
}

export class SmtpAdapter implements ToolkitAdapter {
  readonly toolkitSlug = "smtp";

  async execute(context: AdapterContext): Promise<JsonValue> {
    if (context.tool.name !== "smtp.send_email") {
      return unsupportedTool(context);
    }
    assertNoAttachments(context);
    const recipients = acceptedRecipients(context.canonicalInput);
    const client = smtpHttpFacadeClient(context);
    const response = await client("send", {
      ...jsonRequest({
        from: requiredProviderString(context, this.toolkitSlug, "from"),
        to: recipients,
        subject: stringValue(context.canonicalInput, "subject") ?? "",
        ...bodyPayload(context.canonicalInput),
      }),
    });
    const body = await jsonObject(context, response);
    return asJson({
      messageId: requiredStringField(context, body, "messageId"),
      acceptedRecipients: Array.isArray(body.accepted)
        ? body.accepted.filter(
            (value): value is string => typeof value === "string",
          )
        : recipients,
    });
  }
}

export const smtpAdapter = new SmtpAdapter();

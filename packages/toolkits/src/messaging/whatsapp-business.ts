import type { AdapterContext, JsonValue, ToolkitAdapter } from "@eyeball/core";
import { createProviderHttpClient } from "../http-client.js";
import {
  asJson,
  assertNoAttachments,
  isoFromUnixSeconds,
  isRecord,
  jsonObject,
  jsonRequest,
  notFound,
  providerError,
  records,
  requiredApiKeyValue,
  requiredStringField,
  stringValue,
  unsupportedTool,
} from "./common.js";

function connectionParameter(context: AdapterContext, key: string): string {
  const value = requiredApiKeyValue(context, key);
  // MockCredentialProvider marks every named API-key tuple value as a fixture,
  // including non-secret connection parameters such as the phone number ID.
  return value.startsWith("fixture:") ? value.slice("fixture:".length) : value;
}

export class WhatsAppBusinessAdapter implements ToolkitAdapter {
  readonly toolkitSlug = "whatsapp-business";

  async execute(context: AdapterContext): Promise<JsonValue> {
    switch (context.tool.name) {
      case "whatsapp-business.send_message":
        return this.sendMessage(context);
      case "whatsapp-business.get_message":
        return this.getMessage(context);
      default:
        return unsupportedTool(context);
    }
  }

  private async sendMessage(context: AdapterContext): Promise<JsonValue> {
    assertNoAttachments(context);
    const input = context.canonicalInput;
    const conversationId = requiredStringField(
      context,
      input,
      "conversationId",
    );
    const phoneNumberId = connectionParameter(context, "phoneNumberId");
    const response = await createProviderHttpClient(context)(
      `v18.0/${encodeURIComponent(phoneNumberId)}/messages`,
      jsonRequest({
        messaging_product: "whatsapp",
        to: conversationId,
        type: "text",
        text: { body: requiredStringField(context, input, "text") },
      }),
    );
    const body = await jsonObject(context, response);
    const created = records(body.messages)[0];
    if (created === undefined) {
      throw providerError(context, "WhatsApp omitted the created message.");
    }
    const contact = records(body.contacts)[0];
    return asJson({
      messageId: requiredStringField(context, created, "id"),
      conversationId:
        contact === undefined
          ? conversationId
          : (stringValue(contact, "wa_id") ?? conversationId),
      sentAt: context.clock.now().toISOString(),
    });
  }

  private async getMessage(context: AdapterContext): Promise<JsonValue> {
    const input = context.canonicalInput;
    const requestedConversationId = requiredStringField(
      context,
      input,
      "conversationId",
    );
    const messageId = requiredStringField(context, input, "messageId");
    const response = await createProviderHttpClient(context)(
      `v18.0/${encodeURIComponent(messageId)}`,
    );
    const message = await jsonObject(context, response);
    const conversationId = requiredStringField(context, message, "to");
    if (conversationId !== requestedConversationId) {
      return notFound(
        context,
        "WhatsApp returned a message outside the requested conversation.",
      );
    }
    const senderId = requiredStringField(context, message, "from");
    const textObject = isRecord(message.text) ? message.text : undefined;
    const template = isRecord(message.template) ? message.template : undefined;
    const text =
      (textObject === undefined
        ? undefined
        : stringValue(textObject, "body")) ??
      (template === undefined
        ? ""
        : `[template:${stringValue(template, "name") ?? "unknown"}]`);
    return asJson({
      messageId: requiredStringField(context, message, "id"),
      conversationId,
      sender: {
        memberId: senderId,
        displayName: senderId,
        isBot: true,
      },
      text,
      sentAt: isoFromUnixSeconds(context, message.timestamp, "timestamp"),
      reactions: [],
    });
  }
}

export const whatsAppBusinessAdapter = new WhatsAppBusinessAdapter();

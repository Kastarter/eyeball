import { defineCapabilityFixtures } from "../fixtures.js";

function conversation(provider: string): string {
  switch (provider) {
    case "discord":
      return "100000000000000101";
    case "telegram":
      return "-1001555000001";
    case "whatsapp-business":
      return "15550002222";
    default:
      return "C_GENERAL";
  }
}

function message(provider: string): string {
  switch (provider) {
    case "discord":
      return "100000000000001001";
    case "telegram":
      return "101";
    case "whatsapp-business":
      return "wamid.fixture_default_000001";
    default:
      return "1767225540.000001";
  }
}

export const messagingFixtures = defineCapabilityFixtures("messaging_chat", {
  add_reaction: {
    input: (context) => ({
      conversationId: context.value(
        "CONVERSATION_ID",
        conversation(context.provider),
      ),
      messageId: context.value("MESSAGE_ID", message(context.provider)),
      reaction: "eyes",
    }),
  },
  create_channel: {
    input: (context) => ({
      ...(context.provider === "discord"
        ? { workspaceId: context.value("WORKSPACE_ID", "100000000000000001") }
        : {}),
      name: "contract-fixture-channel",
      visibility: "public",
    }),
  },
  get_message: {
    input: (context) => ({
      conversationId: context.value(
        "CONVERSATION_ID",
        conversation(context.provider),
      ),
      messageId: context.value("MESSAGE_ID", message(context.provider)),
    }),
  },
  list_channels: {
    input: (context) => ({
      ...(context.provider === "discord"
        ? { workspaceId: context.value("WORKSPACE_ID", "100000000000000001") }
        : {}),
      pageSize: 10,
    }),
  },
  list_members: {
    input: (context) => ({
      ...(context.provider === "discord"
        ? { workspaceId: context.value("WORKSPACE_ID", "100000000000000001") }
        : {}),
      conversationId: context.value(
        "CONVERSATION_ID",
        conversation(context.provider),
      ),
      pageSize: 10,
    }),
  },
  list_messages: {
    input: (context) => ({
      conversationId: context.value(
        "CONVERSATION_ID",
        conversation(context.provider),
      ),
      pageSize: 10,
    }),
  },
  reply_to_message: {
    input: (context) => ({
      conversationId: context.value(
        "CONVERSATION_ID",
        conversation(context.provider),
      ),
      messageId: context.value("MESSAGE_ID", message(context.provider)),
      text: "Canonical contract reply.",
    }),
  },
  send_message: {
    input: (context) => ({
      conversationId: context.value(
        "CONVERSATION_ID",
        conversation(context.provider),
      ),
      text: "Canonical contract message.",
    }),
  },
});

import { describe, expect, it } from "vitest";
import {
  defaultCatalog,
  discordManifest,
  slackManifest,
  telegramManifest,
  whatsAppBusinessManifest,
} from "../src/index.js";

const expectedTools = [
  "discord.add_reaction",
  "discord.create_channel",
  "discord.get_message",
  "discord.list_channels",
  "discord.list_members",
  "discord.list_messages",
  "discord.reply_to_message",
  "discord.send_message",
  "slack.add_reaction",
  "slack.create_channel",
  "slack.get_message",
  "slack.list_channels",
  "slack.list_members",
  "slack.list_messages",
  "slack.reply_to_message",
  "slack.send_message",
  "telegram.get_message",
  "telegram.list_messages",
  "telegram.reply_to_message",
  "telegram.send_message",
  "whatsapp-business.get_message",
  "whatsapp-business.send_message",
] as const;

describe("default messaging provider manifests", () => {
  it("materializes exactly the executable provider subsets", () => {
    expect(
      defaultCatalog
        .listTools({ capability: "messaging_chat" })
        .map(({ name }) => name),
    ).toEqual(expectedTools);

    const messagingManifests = defaultCatalog.listManifests({
      capability: "messaging_chat",
    });
    expect(messagingManifests).toHaveLength(4);
    expect(messagingManifests.map(({ toolkit }) => toolkit)).toEqual(
      [
        discordManifest,
        slackManifest,
        telegramManifest,
        whatsAppBusinessManifest,
      ]
        .map(({ toolkit }) => toolkit)
        .sort((left, right) => left.slug.localeCompare(right.slug)),
    );
  });

  it("matches each manifest to the routes exposed by the messaging mocks", () => {
    expect(
      slackManifest.implements.map(({ canonicalTool }) => canonicalTool),
    ).toEqual([
      "send_message",
      "list_channels",
      "list_messages",
      "get_message",
      "reply_to_message",
      "add_reaction",
      "create_channel",
      "list_members",
    ]);
    expect(
      discordManifest.implements.map(({ canonicalTool }) => canonicalTool),
    ).toEqual([
      "send_message",
      "list_channels",
      "list_messages",
      "get_message",
      "reply_to_message",
      "add_reaction",
      "create_channel",
      "list_members",
    ]);
    expect(
      telegramManifest.implements.map(({ canonicalTool }) => canonicalTool),
    ).toEqual([
      "send_message",
      "list_messages",
      "get_message",
      "reply_to_message",
    ]);
    expect(
      whatsAppBusinessManifest.implements.map(
        ({ canonicalTool }) => canonicalTool,
      ),
    ).toEqual(["send_message", "get_message"]);

    expect(defaultCatalog.getTool("telegram.add_reaction")).toBeUndefined();
    expect(
      defaultCatalog.getTool("whatsapp-business.list_messages"),
    ).toBeUndefined();
  });

  it("declares connection-level authentication fields", () => {
    expect(slackManifest.auth.class).toBe("oauth2");
    expect(slackManifest.auth.optionalScopes).toContain("chat:write");
    expect(discordManifest.auth).toEqual({
      class: "api_key",
      fields: ["apiKey"],
    });
    expect(telegramManifest.auth).toEqual({
      class: "api_key",
      fields: ["apiKey"],
    });
    expect(whatsAppBusinessManifest.auth).toEqual({
      class: "api_key",
      fields: ["apiKey", "phoneNumberId"],
    });
  });

  it("computes least-privilege Slack scopes for unambiguous mutations", () => {
    expect(
      defaultCatalog.getEffectiveScopes("slack.send_message"),
    ).toMatchObject({ required: ["chat:write"] });
    expect(
      defaultCatalog.getEffectiveScopes("slack.reply_to_message"),
    ).toMatchObject({ required: ["chat:write"] });
    expect(
      defaultCatalog.getEffectiveScopes("slack.add_reaction"),
    ).toMatchObject({ required: ["reactions:write"] });
  });

  it("freezes every shipped messaging manifest", () => {
    for (const manifest of [
      slackManifest,
      discordManifest,
      telegramManifest,
      whatsAppBusinessManifest,
    ]) {
      expect(Object.isFrozen(manifest)).toBe(true);
      expect(Object.isFrozen(manifest.implements)).toBe(true);
    }
  });
});

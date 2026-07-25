import { describe, expect, it } from "vitest";
import { createSlackMock } from "../src/providers/slack.js";

const authorization = { authorization: "Bearer fixture:valid" };
const generalChannel = "C_GENERAL";

async function seedDefault(
  provider: ReturnType<typeof createSlackMock>,
): Promise<void> {
  const response = await provider.app.request("/_mock/seed", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ bundle: "default" }),
  });

  expect(response.status).toBe(200);
}

function jsonRequest(body: unknown): RequestInit {
  return {
    method: "POST",
    headers: { ...authorization, "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

describe("Slack starter provider", () => {
  it("uses Slack's HTTP-200 auth envelope and lists seeded channels", async () => {
    const provider = createSlackMock();

    const missingAuth = await provider.app.request("/api/conversations.list");
    expect(missingAuth.status).toBe(200);
    await expect(missingAuth.json()).resolves.toEqual({
      ok: false,
      error: "invalid_auth",
    });

    await seedDefault(provider);
    const response = await provider.app.request(
      "/api/conversations.list?limit=1",
      { headers: authorization },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      channels: [
        {
          id: generalChannel,
          name: "general",
          is_private: false,
          num_members: 3,
        },
      ],
      response_metadata: { next_cursor: "" },
    });
  });

  it("posts and reads a thread, then records a reaction", async () => {
    const provider = createSlackMock();
    await seedDefault(provider);

    const sentResponse = await provider.app.request(
      "/api/chat.postMessage",
      jsonRequest({ channel: generalChannel, text: "Starter fixture message" }),
    );
    expect(sentResponse.status).toBe(200);
    const sent = (await sentResponse.json()) as { ts: string };
    expect(sent).toMatchObject({
      ok: true,
      channel: generalChannel,
      message: { text: "Starter fixture message" },
    });

    const replyResponse = await provider.app.request(
      "/api/chat.postMessage",
      jsonRequest({
        channel: generalChannel,
        text: "Starter fixture reply",
        thread_ts: sent.ts,
      }),
    );
    expect(replyResponse.status).toBe(200);

    const reactionResponse = await provider.app.request(
      "/api/reactions.add",
      jsonRequest({
        channel: generalChannel,
        timestamp: sent.ts,
        name: "eyes",
      }),
    );
    expect(reactionResponse.status).toBe(200);
    await expect(reactionResponse.json()).resolves.toEqual({ ok: true });

    const threadResponse = await provider.app.request(
      `/api/conversations.replies?channel=${generalChannel}&ts=${sent.ts}`,
      { headers: authorization },
    );
    expect(threadResponse.status).toBe(200);
    await expect(threadResponse.json()).resolves.toMatchObject({
      ok: true,
      messages: [
        {
          ts: sent.ts,
          text: "Starter fixture message",
          reply_count: 1,
          reactions: [{ name: "eyes", users: ["U_FIXTURE_BOT"], count: 1 }],
        },
        { text: "Starter fixture reply", thread_ts: sent.ts },
      ],
    });
  });

  it("creates channels and returns its members and workspace users", async () => {
    const provider = createSlackMock();

    const createdResponse = await provider.app.request(
      "/api/conversations.create",
      jsonRequest({ name: "starter-fixtures", is_private: true }),
    );
    expect(createdResponse.status).toBe(200);
    const created = (await createdResponse.json()) as {
      channel: { id: string };
    };
    expect(created).toMatchObject({
      ok: true,
      channel: { name: "starter-fixtures", is_private: true },
    });

    const membersResponse = await provider.app.request(
      `/api/conversations.members?channel=${created.channel.id}`,
      { headers: authorization },
    );
    await expect(membersResponse.json()).resolves.toMatchObject({
      ok: true,
      members: ["U_FIXTURE_BOT"],
    });

    const usersResponse = await provider.app.request("/api/users.list", {
      headers: authorization,
    });
    expect(usersResponse.status).toBe(200);
    await expect(usersResponse.json()).resolves.toMatchObject({
      ok: true,
      members: [
        {
          id: "U_FIXTURE_USER_ONE",
          profile: { email: "fixture.user.one@example.com" },
        },
        { id: "U_FIXTURE_USER_TWO" },
        { id: "U_FIXTURE_BOT", is_bot: true },
      ],
    });
  });
});

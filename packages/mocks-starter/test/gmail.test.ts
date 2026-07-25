import { describe, expect, it } from "vitest";
import { createGmailMock } from "../src/providers/gmail.js";

const authorization = { authorization: "Bearer fixture:valid-token" };
const messagesPath = "/gmail/v1/users/me/messages";

function jsonRequest(payload: unknown): RequestInit {
  return {
    method: "POST",
    headers: {
      ...authorization,
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  };
}

function rawEmail(subject: string, body: string): string {
  return Buffer.from(
    [
      "From: sender@example.com",
      "To: recipient@example.com",
      `Subject: ${subject}`,
      "Content-Type: text/plain; charset=UTF-8",
      "",
      body,
    ].join("\r\n"),
    "utf8",
  ).toString("base64url");
}

describe("Gmail provider", () => {
  it("requires authentication and exposes the deterministic seeded message shape", async () => {
    const provider = createGmailMock();

    const unauthenticated = await provider.app.request(messagesPath);
    expect(unauthenticated.status).toBe(401);
    await expect(unauthenticated.json()).resolves.toMatchObject({
      error: { code: 401, errors: [{ reason: "authError" }] },
    });

    const seeded = await provider.app.request("/_mock/seed", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ bundle: "default" }),
    });
    expect(seeded.status).toBe(200);

    const listed = await provider.app.request(
      `${messagesPath}?q=${encodeURIComponent("from:billing@example.com")}`,
      { headers: authorization },
    );
    expect(listed.status).toBe(200);
    await expect(listed.json()).resolves.toMatchObject({
      messages: [
        {
          id: "msg_default_000001",
          threadId: "thread_default_000001",
        },
      ],
      resultSizeEstimate: 1,
    });

    const detail = await provider.app.request(
      `${messagesPath}/msg_default_000001`,
      { headers: authorization },
    );
    expect(detail.status).toBe(200);
    const detailBody = (await detail.json()) as {
      id: string;
      labelIds: string[];
      payload: { headers: Array<{ name: string; value: string }> };
    };
    expect(detailBody).toMatchObject({
      id: "msg_default_000001",
      labelIds: ["INBOX", "UNREAD"],
    });
    expect(detailBody.payload.headers).toEqual(
      expect.arrayContaining([
        { name: "From", value: "billing@example.com" },
        { name: "To", value: "recipient@example.com" },
      ]),
    );
  });

  it("sends a MIME message and returns a complete thread route", async () => {
    const provider = createGmailMock();

    const sent = await provider.app.request(
      `${messagesPath}/send`,
      jsonRequest({
        raw: rawEmail("Fixture delivery", "A deterministic test message."),
      }),
    );
    expect(sent.status).toBe(200);
    const message = (await sent.json()) as { id: string; threadId: string };
    expect(message).toMatchObject({
      id: "gmail_msg_000001",
      threadId: "gmail_thread_000001",
      labelIds: ["SENT"],
    });

    const thread = await provider.app.request(
      `/gmail/v1/users/me/threads/${message.threadId}`,
      { headers: authorization },
    );
    expect(thread.status).toBe(200);
    const threadBody = (await thread.json()) as {
      id: string;
      messages: Array<{
        id: string;
        payload: { headers: Array<{ name: string; value: string }> };
      }>;
    };
    expect(threadBody).toMatchObject({
      id: message.threadId,
      messages: [{ id: message.id }],
    });
    expect(threadBody.messages[0]?.payload.headers).toEqual(
      expect.arrayContaining([{ name: "Subject", value: "Fixture delivery" }]),
    );
  });

  it("lists labels and applies a label mutation to a sent message", async () => {
    const provider = createGmailMock();
    const sent = await provider.app.request(
      `${messagesPath}/send`,
      jsonRequest({
        raw: rawEmail("Label fixture", "Apply an inbox label."),
      }),
    );
    const message = (await sent.json()) as { id: string };

    const labels = await provider.app.request("/gmail/v1/users/me/labels", {
      headers: authorization,
    });
    expect(labels.status).toBe(200);
    await expect(labels.json()).resolves.toMatchObject({
      labels: [{ id: "INBOX" }, { id: "SENT" }, { id: "UNREAD" }],
    });

    const modified = await provider.app.request(
      `${messagesPath}/${message.id}/modify`,
      jsonRequest({
        addLabelIds: ["INBOX", "UNREAD"],
        removeLabelIds: ["SENT"],
      }),
    );
    expect(modified.status).toBe(200);
    await expect(modified.json()).resolves.toMatchObject({
      id: message.id,
      labelIds: ["INBOX", "UNREAD"],
    });
  });
});

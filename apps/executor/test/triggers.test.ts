import { defaultCatalog } from "@eyeball/catalog";
import {
  type Clock,
  MockCredentialProvider,
  type TriggerWebhookEvent,
  verifyWebhookSignature,
} from "@eyeball/core";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { createMockApp } from "../../../mocks/packages/mock-kit/dist/index.js";
import { createGmailMock } from "../../../mocks/packages/mocks-email/dist/index.js";
import {
  createExecutorApp,
  ExecutionEngine,
  WebhookDeliverer,
} from "../src/index.js";

const API_KEY = "ey_test_triggers";
const PINNED_API_KEY = "ey_test_triggers_pinned";
const OTHER_USER_API_KEY = "ey_test_triggers_other_user";
const OTHER_PROJECT_API_KEY = "ey_test_triggers_other_project";
const PROJECT_ID = "proj_triggers";
const OTHER_PROJECT_ID = "proj_triggers_other";
const USER_ID = "user_triggers";
const OTHER_USER_ID = "user_triggers_other";
const START = "2026-07-17T12:00:00.000Z";
const RECEIVER_ORIGIN = "https://receiver.example.test";
const MOCK_ORIGIN = "http://mocks.local";

class ManualTriggerClock implements Clock {
  #now = Date.parse(START);

  now(): Date {
    return new Date(this.#now);
  }

  advance(milliseconds: number): void {
    this.#now += milliseconds;
  }
}

interface ReceivedDelivery {
  event: TriggerWebhookEvent;
  signatureValid: boolean;
}

function auth(apiKey = API_KEY): Record<string, string> {
  return { Authorization: `Bearer ${apiKey}` };
}

function jsonHeaders(apiKey = API_KEY): Record<string, string> {
  return { ...auth(apiKey), "Content-Type": "application/json" };
}

function createHarness() {
  const clock = new ManualTriggerClock();
  const gmail = createGmailMock();
  const mockApp = createMockApp({ providers: [gmail] });
  const receiver = new Hono();
  const received: ReceivedDelivery[] = [];
  const endpointSecrets = new Map<string, string>();
  receiver.post("/hook", async (context) => {
    const body = await context.req.text();
    const event = JSON.parse(body) as TriggerWebhookEvent;
    const secret = endpointSecrets.get(event.type);
    received.push({
      event,
      signatureValid:
        secret !== undefined &&
        verifyWebhookSignature({
          payload: body,
          headers: context.req.raw.headers,
          secret,
          now: clock.now(),
        }),
    });
    return context.body(null, 204);
  });
  const fetchImpl = (async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) => {
    const request = new Request(input, init);
    const origin = new URL(request.url).origin;
    if (origin === MOCK_ORIGIN) return mockApp.request(request);
    if (origin === RECEIVER_ORIGIN) return receiver.request(request);
    throw new Error(`Unexpected trigger test origin: ${request.url}`);
  }) as typeof fetch;
  const credentialProvider = new MockCredentialProvider([
    {
      match: {
        projectId: PROJECT_ID,
        userId: USER_ID,
        toolkitSlug: "gmail",
        connectionId: "conn_trigger_gmail",
      },
      credential: {
        type: "oauth2",
        accessToken: "fixture:valid",
        scopes: ["https://www.googleapis.com/auth/gmail.modify"],
      },
    },
    {
      match: {
        projectId: PROJECT_ID,
        userId: USER_ID,
        toolkitSlug: "slack",
        connectionId: "conn_trigger_slack",
      },
      credential: {
        type: "oauth2",
        accessToken: "fixture:valid",
        scopes: ["channels:history"],
      },
    },
  ]);
  const webhookDeliverer = new WebhookDeliverer({
    clock,
    fetchImpl,
    retryDelaysMs: [0],
  });
  const engine = new ExecutionEngine({
    catalog: defaultCatalog,
    credentialProvider,
    clock,
    fetchImpl,
    webhookDeliverer,
    env: { EYEBALL_GMAIL_BASE_URL: `${MOCK_ORIGIN}/gmail` },
  });
  const app = createExecutorApp({
    engine,
    apiKeys: {
      [API_KEY]: PROJECT_ID,
      [PINNED_API_KEY]: { projectId: PROJECT_ID, userId: USER_ID },
      [OTHER_USER_API_KEY]: {
        projectId: PROJECT_ID,
        userId: OTHER_USER_ID,
      },
      [OTHER_PROJECT_API_KEY]: OTHER_PROJECT_ID,
    },
    requestIdFactory: () => "req_trigger_test",
  });
  return {
    app,
    clock,
    engine,
    gmail,
    received,
    webhookDeliverer,
    endpointSecrets,
  };
}

async function createEndpoint(
  harness: ReturnType<typeof createHarness>,
  trigger: "gmail.email_received" | "slack.message_received",
): Promise<{ endpointId: string; secret: string }> {
  const response = await harness.app.request("/v1/webhooks", {
    method: "POST",
    headers: jsonHeaders(),
    body: JSON.stringify({
      url: `${RECEIVER_ORIGIN}/hook`,
      events: [`trigger.${trigger}`],
    }),
  });
  expect(response.status).toBe(201);
  const endpoint = (await response.json()) as {
    endpointId: string;
    secret: string;
  };
  harness.endpointSecrets.set(`trigger.${trigger}`, endpoint.secret);
  return endpoint;
}

async function createSubscription(
  harness: ReturnType<typeof createHarness>,
  input: {
    trigger: "gmail.email_received" | "slack.message_received";
    connectionId: string;
    endpointId: string;
  },
): Promise<{
  subscriptionId: string;
  ingestUrl?: string;
  userId: string;
}> {
  const response = await harness.app.request("/v1/subscriptions", {
    method: "POST",
    headers: jsonHeaders(),
    body: JSON.stringify({
      trigger: input.trigger,
      userId: USER_ID,
      connectionId: input.connectionId,
      webhookEndpointIds: [input.endpointId],
    }),
  });
  expect(response.status).toBe(201);
  return response.json();
}

describe("trigger subscriptions", () => {
  it("creates, lists, scopes, validates connections, and deletes subscriptions", async () => {
    const harness = createHarness();
    const endpoint = await createEndpoint(harness, "slack.message_received");
    const invalidConnection = await harness.app.request("/v1/subscriptions", {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({
        trigger: "slack.message_received",
        userId: USER_ID,
        connectionId: "conn_trigger_missing",
        webhookEndpointIds: [endpoint.endpointId],
      }),
    });
    expect(invalidConnection.status).toBe(422);

    const created = await createSubscription(harness, {
      trigger: "slack.message_received",
      connectionId: "conn_trigger_slack",
      endpointId: endpoint.endpointId,
    });
    expect(created).toMatchObject({ userId: USER_ID });
    expect(created.subscriptionId).toMatch(/^trgsub_/u);
    expect(created.ingestUrl).toContain(
      `/v1/ingest/${created.subscriptionId}/trgsec_`,
    );

    const projectGet = await harness.app.request(
      `/v1/subscriptions/${created.subscriptionId}`,
      { headers: auth() },
    );
    expect(projectGet.status).toBe(200);
    await expect(projectGet.json()).resolves.toMatchObject({
      subscriptionId: created.subscriptionId,
      userId: USER_ID,
    });
    const crossProjectGet = await harness.app.request(
      `/v1/subscriptions/${created.subscriptionId}`,
      { headers: auth(OTHER_PROJECT_API_KEY) },
    );
    expect(crossProjectGet.status).toBe(404);

    const pinnedCreateForAnotherUser = await harness.app.request(
      "/v1/subscriptions",
      {
        method: "POST",
        headers: jsonHeaders(PINNED_API_KEY),
        body: JSON.stringify({
          trigger: "slack.message_received",
          userId: OTHER_USER_ID,
          connectionId: "conn_trigger_slack",
          webhookEndpointIds: [endpoint.endpointId],
        }),
      },
    );
    expect(pinnedCreateForAnotherUser.status).toBe(403);

    const projectList = await harness.app.request("/v1/subscriptions", {
      headers: auth(),
    });
    expect(projectList.status).toBe(200);
    const projectPage = (await projectList.json()) as {
      subscriptions: Array<Record<string, unknown>>;
    };
    expect(projectPage.subscriptions).toHaveLength(1);
    expect(projectPage.subscriptions[0]).not.toHaveProperty("ingestUrl");

    const pinnedList = await harness.app.request("/v1/subscriptions", {
      headers: auth(PINNED_API_KEY),
    });
    await expect(pinnedList.json()).resolves.toMatchObject({
      subscriptions: [{ subscriptionId: created.subscriptionId }],
    });
    const otherUserList = await harness.app.request("/v1/subscriptions", {
      headers: auth(OTHER_USER_API_KEY),
    });
    await expect(otherUserList.json()).resolves.toEqual({ subscriptions: [] });
    const otherProjectList = await harness.app.request("/v1/subscriptions", {
      headers: auth(OTHER_PROJECT_API_KEY),
    });
    await expect(otherProjectList.json()).resolves.toEqual({
      subscriptions: [],
    });

    const forbiddenDelete = await harness.app.request(
      `/v1/subscriptions/${created.subscriptionId}`,
      { method: "DELETE", headers: auth(OTHER_USER_API_KEY) },
    );
    expect(forbiddenDelete.status).toBe(403);
    const deleted = await harness.app.request(
      `/v1/subscriptions/${created.subscriptionId}`,
      { method: "DELETE", headers: auth() },
    );
    expect(deleted.status).toBe(204);
    const deletedGet = await harness.app.request(
      `/v1/subscriptions/${created.subscriptionId}`,
      { headers: auth() },
    );
    expect(deletedGet.status).toBe(404);
  });

  it("handles Slack URL verification and deduplicates signed push delivery", async () => {
    const harness = createHarness();
    const endpoint = await createEndpoint(harness, "slack.message_received");
    const subscription = await createSubscription(harness, {
      trigger: "slack.message_received",
      connectionId: "conn_trigger_slack",
      endpointId: endpoint.endpointId,
    });
    if (subscription.ingestUrl === undefined) {
      throw new Error("Slack push subscription omitted ingestUrl.");
    }

    const crossUserRotate = await harness.app.request(
      `/v1/subscriptions/${subscription.subscriptionId}/rotate-secret`,
      { method: "POST", headers: auth(OTHER_USER_API_KEY) },
    );
    expect(crossUserRotate.status).toBe(403);

    const rotate = await harness.app.request(
      `/v1/subscriptions/${subscription.subscriptionId}/rotate-secret`,
      { method: "POST", headers: auth(PINNED_API_KEY) },
    );
    expect(rotate.status).toBe(200);
    const rotated = (await rotate.json()) as {
      subscriptionId: string;
      ingestUrl: string;
      rotatedAt: string;
    };
    expect(rotated).toMatchObject({
      subscriptionId: subscription.subscriptionId,
      rotatedAt: START,
    });
    expect(rotated.ingestUrl).not.toBe(subscription.ingestUrl);
    const retired = await harness.app.request(subscription.ingestUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "url_verification",
        challenge: "retired-secret",
      }),
    });
    expect(retired.status).toBe(404);

    const oversized = await harness.app.request(rotated.ingestUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "x".repeat(1024 * 1024 + 1),
    });
    expect(oversized.status).toBe(413);
    await expect(oversized.json()).resolves.toMatchObject({
      error: {
        code: "invalid_input",
        message: "Trigger ingest payload exceeds the 1 MiB limit.",
      },
    });

    const challenge = await harness.app.request(rotated.ingestUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "url_verification",
        challenge: "slack-challenge",
      }),
    });
    expect(challenge.status).toBe(200);
    await expect(challenge.json()).resolves.toEqual({
      challenge: "slack-challenge",
    });
    expect(harness.received).toHaveLength(0);

    const event = {
      type: "event_callback",
      event_id: "Ev_trigger_1",
      team_id: "T_trigger",
      event: {
        type: "message",
        channel: "C_trigger",
        user: "U_trigger",
        text: "hello from Slack",
        ts: "1784289600.000001",
        client_msg_id: "msg_trigger_1",
      },
    };
    const first = await harness.app.request(rotated.ingestUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(event),
    });
    expect(first.status).toBe(202);
    await expect(first.json()).resolves.toEqual({
      kind: "accepted",
      accepted: 1,
      duplicates: 0,
    });
    await harness.webhookDeliverer.onIdle();

    const duplicate = await harness.app.request(rotated.ingestUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(event),
    });
    expect(duplicate.status).toBe(202);
    await expect(duplicate.json()).resolves.toEqual({
      kind: "accepted",
      accepted: 0,
      duplicates: 1,
    });
    await harness.webhookDeliverer.onIdle();

    expect(harness.received).toHaveLength(1);
    expect(harness.received[0]?.signatureValid).toBe(true);
    expect(harness.received[0]?.event).toMatchObject({
      type: "trigger.slack.message_received",
      projectId: PROJECT_ID,
      data: {
        subscriptionId: subscription.subscriptionId,
        trigger: "slack.message_received",
        userId: USER_ID,
        providerEventId: "Ev_trigger_1",
        payload: {
          id: "msg_trigger_1",
          from: "U_trigger",
          conversationId: "C_trigger",
          text: "hello from Slack",
          receivedAt: "2026-07-17T12:00:00.000Z",
          x_provider: {
            slack: {
              eventId: "Ev_trigger_1",
              teamId: "T_trigger",
              channelId: "C_trigger",
              eventTs: "1784289600.000001",
            },
          },
        },
      },
    });
  });

  it("polls Gmail with a durable cursor and emits only newly received mail", async () => {
    const harness = createHarness();
    await harness.gmail.seed({
      messages: [
        {
          id: "gmail_trigger_1",
          from: "sender@example.com",
          to: ["recipient@example.com"],
          subject: "First trigger",
          body: "First body",
          labelIds: ["INBOX"],
          receivedAt: "2026-07-17T11:59:00.000Z",
        },
      ],
    });
    const endpoint = await createEndpoint(harness, "gmail.email_received");
    const subscription = await createSubscription(harness, {
      trigger: "gmail.email_received",
      connectionId: "conn_trigger_gmail",
      endpointId: endpoint.endpointId,
    });
    expect(subscription.ingestUrl).toBeUndefined();
    const rotate = await harness.app.request(
      `/v1/subscriptions/${subscription.subscriptionId}/rotate-secret`,
      { method: "POST", headers: auth() },
    );
    expect(rotate.status).toBe(422);

    harness.clock.advance(60_000);
    await expect(harness.engine.triggerService.runDue()).resolves.toEqual({
      polled: 1,
      emitted: 1,
      duplicates: 0,
      failed: 0,
    });
    await harness.webhookDeliverer.onIdle();
    expect(
      await harness.engine.triggerService.stateStore.get(
        subscription.subscriptionId as `trgsub_${string}`,
      ),
    ).toMatchObject({ cursor: "1" });

    harness.clock.advance(60_000);
    await expect(harness.engine.triggerService.runDue()).resolves.toMatchObject(
      {
        polled: 1,
        emitted: 0,
        duplicates: 0,
      },
    );
    expect(harness.received).toHaveLength(1);

    await harness.gmail.seed({
      messages: [
        {
          id: "gmail_trigger_1",
          from: "sender@example.com",
          to: ["recipient@example.com"],
          subject: "First trigger",
          body: "First body",
          labelIds: ["INBOX"],
          receivedAt: "2026-07-17T11:59:00.000Z",
        },
        {
          id: "gmail_trigger_2",
          from: "new@example.com",
          to: ["recipient@example.com"],
          subject: "Second trigger",
          body: "Second body",
          labelIds: ["INBOX"],
          receivedAt: "2026-07-17T12:01:30.000Z",
        },
      ],
    });
    harness.clock.advance(60_000);
    await expect(harness.engine.triggerService.runDue()).resolves.toMatchObject(
      {
        polled: 1,
        emitted: 1,
        duplicates: 0,
        failed: 0,
      },
    );
    await harness.webhookDeliverer.onIdle();

    expect(harness.received).toHaveLength(2);
    expect(harness.received.every(({ signatureValid }) => signatureValid)).toBe(
      true,
    );
    expect(
      harness.received.map(({ event }) => event.data.providerEventId),
    ).toEqual(["gmail_trigger_1", "gmail_trigger_2"]);
    expect(harness.received[1]?.event).toMatchObject({
      type: "trigger.gmail.email_received",
      data: {
        payload: {
          id: "gmail_trigger_2",
          from: "new@example.com",
          to: ["recipient@example.com"],
          subject: "Second trigger",
          threadId: "thread_seed_000002",
          receivedAt: "2026-07-17T12:01:30.000Z",
          x_provider: {
            gmail: { historyId: "2", labelIds: ["INBOX"] },
          },
        },
      },
    });
    expect(
      await harness.engine.triggerService.stateStore.get(
        subscription.subscriptionId as `trgsub_${string}`,
      ),
    ).toMatchObject({ cursor: "2" });
  });
});

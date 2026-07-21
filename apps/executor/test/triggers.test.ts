import { defaultCatalog } from "@eyeball/catalog";
import {
  type Clock,
  MockCredentialProvider,
  type TriggerWebhookEvent,
  verifyWebhookSignature,
} from "@eyeball/core";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { createMockApp } from "../../../mocks/packages/mock-kit/dist/index.js";
import { createGmailMock } from "../../../mocks/packages/mocks-email/dist/index.js";
import {
  createExecutorApp,
  DEFAULT_TRIGGER_EVENT_RETENTION_MS,
  ExecutionEngine,
  TriggerEventPersistenceError,
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
    const challengeHistory = await harness.app.request("/v1/trigger-events", {
      headers: auth(),
    });
    await expect(challengeHistory.json()).resolves.toEqual({
      triggerEvents: [],
    });
    const unsupported = await harness.app.request(rotated.ingestUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "event_callback",
        event_id: "Ev_unsupported",
        team_id: "T_trigger",
        event: { type: "user_change" },
      }),
    });
    expect(unsupported.status).toBe(202);
    await expect(unsupported.json()).resolves.toEqual({
      kind: "accepted",
      accepted: 0,
      duplicates: 0,
    });
    await expect(
      (
        await harness.app.request("/v1/trigger-events", { headers: auth() })
      ).json(),
    ).resolves.toEqual({ triggerEvents: [] });

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
    const historyResponse = await harness.app.request(
      `/v1/trigger-events?limit=1&subscriptionId=${subscription.subscriptionId}&trigger=slack.message_received`,
      { headers: auth() },
    );
    expect(historyResponse.status).toBe(200);
    const firstHistoryPage = (await historyResponse.json()) as {
      triggerEvents: Array<Record<string, unknown>>;
      nextCursor?: string;
    };
    expect(firstHistoryPage.triggerEvents).toHaveLength(1);
    expect(firstHistoryPage.triggerEvents[0]).toMatchObject({
      subscriptionId: subscription.subscriptionId,
      trigger: "slack.message_received",
      deliveryMode: "push",
      receivedAt: START,
      dedupStatus: "duplicate",
      deliveryStatus: "not_enqueued",
      requestedWebhookEndpointIds: [endpoint.endpointId],
      deliveryTargets: [],
    });
    expect(firstHistoryPage.nextCursor).toBeTypeOf("string");
    const acceptedHistoryResponse = await harness.app.request(
      `/v1/trigger-events?limit=1&subscriptionId=${subscription.subscriptionId}&trigger=slack.message_received&cursor=${encodeURIComponent(firstHistoryPage.nextCursor ?? "")}`,
      { headers: auth() },
    );
    const acceptedHistoryPage = (await acceptedHistoryResponse.json()) as {
      triggerEvents: Array<Record<string, unknown>>;
    };
    expect(acceptedHistoryPage.triggerEvents[0]).toMatchObject({
      dedupStatus: "accepted",
      deliveryStatus: "succeeded",
      deliveryTargets: [
        {
          endpointId: endpoint.endpointId,
          status: "succeeded",
        },
      ],
    });
    expect(Object.keys(firstHistoryPage.triggerEvents[0] ?? {}).sort()).toEqual(
      [
        "arrivalId",
        "dedupStatus",
        "deliveryMode",
        "deliveryStatus",
        "deliveryTargets",
        "eventId",
        "expiresAt",
        "occurredAt",
        "receivedAt",
        "requestedWebhookEndpointIds",
        "subscriptionId",
        "trigger",
      ].sort(),
    );
    expect(
      Object.keys(
        (
          acceptedHistoryPage.triggerEvents[0]?.deliveryTargets as
            | Array<Record<string, unknown>>
            | undefined
        )?.[0] ?? {},
      ).sort(),
    ).toEqual(["deliveryId", "endpointId", "status"]);
    expect(acceptedHistoryPage.triggerEvents[0]?.eventId).toBe(
      firstHistoryPage.triggerEvents[0]?.eventId,
    );
    expect(acceptedHistoryPage.triggerEvents[0]?.arrivalId).not.toBe(
      firstHistoryPage.triggerEvents[0]?.arrivalId,
    );
    const historyJson = JSON.stringify([firstHistoryPage, acceptedHistoryPage]);
    for (const forbidden of [
      "Ev_trigger_1",
      "hello from Slack",
      "T_trigger",
      "C_trigger",
      "U_trigger",
      "trgsec_",
      "providerEventId",
      "payload",
    ]) {
      expect(historyJson).not.toContain(forbidden);
    }
    const pinnedHistory = await harness.app.request("/v1/trigger-events", {
      headers: auth(PINNED_API_KEY),
    });
    expect(pinnedHistory.status).toBe(403);
    await expect(pinnedHistory.json()).resolves.toMatchObject({
      error: {
        code: "auth_insufficient_scope",
        message:
          "Project-scoped trigger event history requires an unpinned project API key.",
      },
    });
    const otherProjectHistory = await harness.app.request(
      "/v1/trigger-events",
      { headers: auth(OTHER_PROJECT_API_KEY) },
    );
    await expect(otherProjectHistory.json()).resolves.toEqual({
      triggerEvents: [],
    });
    const foreignCursor = await harness.app.request(
      `/v1/trigger-events?limit=1&subscriptionId=${subscription.subscriptionId}&trigger=slack.message_received&cursor=${encodeURIComponent(firstHistoryPage.nextCursor ?? "")}`,
      { headers: auth(OTHER_PROJECT_API_KEY) },
    );
    expect(foreignCursor.status).toBe(422);
    const mismatchedCursor = await harness.app.request(
      `/v1/trigger-events?limit=1&subscriptionId=${subscription.subscriptionId}&trigger=gmail.email_received&cursor=${encodeURIComponent(firstHistoryPage.nextCursor ?? "")}`,
      { headers: auth() },
    );
    expect(mismatchedCursor.status).toBe(422);
    for (const query of [
      "limit=0",
      "limit=101",
      "limit=1.5",
      "cursor=",
      "cursor=not%2Bcanonical",
      "subscriptionId=",
      "subscriptionId=wrong",
      "trigger=",
      "trigger=Slack%20message",
    ]) {
      const malformed = await harness.app.request(
        `/v1/trigger-events?${query}`,
        {
          headers: auth(),
        },
      );
      expect(malformed.status, query).toBe(422);
      await expect(malformed.json()).resolves.toMatchObject({
        error: { code: "invalid_input" },
      });
    }
    const maximumPage = await harness.app.request(
      "/v1/trigger-events?limit=100",
      { headers: auth() },
    );
    expect(maximumPage.status).toBe(200);

    const deleted = await harness.app.request(
      `/v1/subscriptions/${subscription.subscriptionId}`,
      { method: "DELETE", headers: auth() },
    );
    expect(deleted.status).toBe(204);
    const retainedAfterDelete = await harness.app.request(
      `/v1/trigger-events?subscriptionId=${subscription.subscriptionId}`,
      { headers: auth() },
    );
    const retainedPage = (await retainedAfterDelete.json()) as {
      triggerEvents: Array<Record<string, unknown>>;
    };
    expect(retainedPage.triggerEvents).toHaveLength(2);
    expect(retainedPage.triggerEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          arrivalId: expect.stringMatching(/^trgevt_/u),
          subscriptionId: subscription.subscriptionId,
        }),
      ]),
    );
    harness.clock.advance(DEFAULT_TRIGGER_EVENT_RETENTION_MS);
    const expired = await harness.app.request(
      `/v1/trigger-events?subscriptionId=${subscription.subscriptionId}`,
      { headers: auth() },
    );
    await expect(expired.json()).resolves.toEqual({ triggerEvents: [] });
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
    const history = await harness.app.request(
      `/v1/trigger-events?subscriptionId=${subscription.subscriptionId}&trigger=gmail.email_received`,
      { headers: auth() },
    );
    expect(history.status).toBe(200);
    const page = (await history.json()) as {
      triggerEvents: Array<Record<string, unknown>>;
    };
    expect(page.triggerEvents).toHaveLength(2);
    expect(page.triggerEvents[0]).toMatchObject({
      subscriptionId: subscription.subscriptionId,
      trigger: "gmail.email_received",
      deliveryMode: "polling",
      receivedAt: "2026-07-17T12:03:00.000Z",
      occurredAt: "2026-07-17T12:01:30.000Z",
      dedupStatus: "accepted",
      deliveryStatus: "succeeded",
    });
    const serialized = JSON.stringify(page);
    for (const forbidden of [
      "new@example.com",
      "recipient@example.com",
      "Second trigger",
      "gmail_trigger_2",
      "thread_seed_000002",
      "INBOX",
      "historyId",
      "payload",
      "providerEventId",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }

    const reobserveAt = harness.clock.now().toISOString();
    await harness.engine.triggerService.stateStore.put({
      subscriptionId: subscription.subscriptionId as `trgsub_${string}`,
      cursor: "0",
      nextPollAt: reobserveAt,
      updatedAt: reobserveAt,
    });
    await expect(harness.engine.triggerService.runDue()).resolves.toMatchObject(
      {
        polled: 1,
        emitted: 0,
        duplicates: 2,
        failed: 0,
      },
    );
    expect(
      await harness.engine.triggerService.stateStore.get(
        subscription.subscriptionId as `trgsub_${string}`,
      ),
    ).toMatchObject({ cursor: "2" });
    const repeatedHistory = await harness.app.request(
      `/v1/trigger-events?subscriptionId=${subscription.subscriptionId}&trigger=gmail.email_received`,
      { headers: auth() },
    );
    const repeatedPage = (await repeatedHistory.json()) as {
      triggerEvents: Array<Record<string, unknown>>;
    };
    expect(repeatedPage.triggerEvents).toHaveLength(4);
    expect(repeatedPage.triggerEvents.slice(0, 2)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          deliveryMode: "polling",
          dedupStatus: "duplicate",
          deliveryStatus: "not_enqueued",
          deliveryTargets: [],
        }),
      ]),
    );
    for (const forbidden of [
      "new@example.com",
      "recipient@example.com",
      "Second trigger",
      "gmail_trigger_2",
      "thread_seed_000002",
      "INBOX",
      "historyId",
      "payload",
      "providerEventId",
    ]) {
      expect(JSON.stringify(repeatedPage)).not.toContain(forbidden);
    }
  });

  it("records failed webhook admission before rethrow and deduplicates its retry", async () => {
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
    vi.spyOn(
      harness.webhookDeliverer,
      "enqueueTriggerEvent",
    ).mockRejectedValueOnce(new Error("forced webhook admission failure"));
    const event = {
      type: "event_callback",
      event_id: "Ev_admission_failure",
      team_id: "T_admission_failure",
      event: {
        type: "message",
        channel: "C_admission_failure",
        user: "U_admission_failure",
        text: "admission failure payload sentinel",
        ts: "1784289600.000010",
      },
    };
    const first = await harness.app.request(subscription.ingestUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(event),
    });
    expect(first.status).toBe(500);
    const failedPage =
      await harness.engine.triggerService.listEvents(PROJECT_ID);
    expect(failedPage.triggerEvents).toHaveLength(1);
    expect(failedPage.triggerEvents[0]).toMatchObject({
      dedupStatus: "accepted",
      deliveryStatus: "admission_failed",
      deliveryTargets: [],
    });

    const retry = await harness.app.request(subscription.ingestUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(event),
    });
    expect(retry.status).toBe(202);
    await expect(retry.json()).resolves.toMatchObject({
      accepted: 0,
      duplicates: 1,
    });
    const retriedPage =
      await harness.engine.triggerService.listEvents(PROJECT_ID);
    expect(
      retriedPage.triggerEvents.map(({ deliveryStatus }) => deliveryStatus),
    ).toEqual(["not_enqueued", "admission_failed"]);
    expect(retriedPage.triggerEvents[0]?.eventId).toBe(
      retriedPage.triggerEvents[1]?.eventId,
    );
    expect(JSON.stringify(retriedPage)).not.toContain(
      "admission failure payload sentinel",
    );
  });

  it("surfaces history persistence failure without cancelling admitted webhook work", async () => {
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
    vi.spyOn(
      harness.engine.triggerService.eventStore,
      "append",
    ).mockRejectedValueOnce(new TriggerEventPersistenceError());
    const event = {
      type: "event_callback",
      event_id: "Ev_history_failure",
      team_id: "T_history_failure",
      event: {
        type: "message",
        channel: "C_history_failure",
        user: "U_history_failure",
        text: "history failure payload sentinel",
        ts: "1784289600.000011",
      },
    };
    const first = await harness.app.request(subscription.ingestUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(event),
    });
    expect(first.status).toBe(500);
    await expect(first.json()).resolves.toEqual({
      error: {
        code: "provider_error",
        message: "Trigger event persistence failed.",
        retryable: true,
      },
      requestId: "req_trigger_test",
    });
    await harness.webhookDeliverer.onIdle();
    expect(harness.received).toHaveLength(1);

    const retry = await harness.app.request(subscription.ingestUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(event),
    });
    expect(retry.status).toBe(202);
    await expect(retry.json()).resolves.toMatchObject({
      accepted: 0,
      duplicates: 1,
    });
    const page = await harness.engine.triggerService.listEvents(PROJECT_ID);
    expect(page.triggerEvents).toHaveLength(1);
    expect(page.triggerEvents[0]).toMatchObject({
      dedupStatus: "duplicate",
      deliveryStatus: "not_enqueued",
    });
    expect(JSON.stringify(page)).not.toContain(
      "history failure payload sentinel",
    );
  });
});

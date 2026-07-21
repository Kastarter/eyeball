import { describe, expect, it } from "vitest";
import { ExecutorApiError, ExecutorClient, type WebhookEndpoint } from "./api";
import { EXECUTOR_PROJECT_HEADER } from "./executor-key-shared";

describe("ExecutorClient", () => {
  it("reads the executor's public health response", async () => {
    let request: Request | undefined;
    const fetch: typeof globalThis.fetch = async (input, init) => {
      request = new Request(input, init);
      return Response.json({ service: "executor", status: "ok" });
    };
    const client = new ExecutorClient({
      baseUrl: "https://executor.example/",
      fetch,
    });

    await expect(client.health()).resolves.toEqual({
      service: "executor",
      status: "ok",
    });
    expect(request?.url).toBe("https://executor.example/health");
    expect(request?.headers.get("Accept")).toBe("application/json");
    expect(request?.headers.has("Authorization")).toBe(false);
  });

  it("serializes authenticated execution-list filters onto the wire API", async () => {
    let request: Request | undefined;
    const fetch: typeof globalThis.fetch = async (input, init) => {
      request = new Request(input, init);
      return Response.json({ executions: [] });
    };
    const client = new ExecutorClient({
      apiKey: "eyeball_test_key",
      baseUrl: "https://executor.example",
      fetch,
    });

    await expect(
      client.listExecutions({
        cursor: "cursor_2",
        limit: 25,
        status: "running",
        tool: "gmail.send_email",
        userId: "user_123",
      }),
    ).resolves.toEqual({ executions: [] });

    expect(request?.url).toBe(
      "https://executor.example/v1/executions?cursor=cursor_2&limit=25&status=running&tool=gmail.send_email&userId=user_123",
    );
    expect(request?.headers.get("Authorization")).toBe(
      "Bearer eyeball_test_key",
    );
  });

  it("preserves bounded execution provenance and canonical retryAfter wire data", async () => {
    const safeRecord = {
      executionId: "exe_safe_provenance",
      tool: "gmail.send_email",
      toolVersion: "1.0.0",
      catalogVersion: "2026.07.21",
      userId: "user_safe",
      status: "succeeded",
      createdAt: "2026-07-21T12:00:00.000Z",
      completedAt: "2026-07-21T12:00:00.010Z",
      latencyMs: 10,
      output: { messageId: "msg_safe" },
      replayed: true,
      source: { kind: "voice_session", sessionId: "session_safe" },
      attachments: {
        count: 2,
        fileIds: ["file_safe_one", "file_safe_two"],
      },
    };
    const fetch: typeof globalThis.fetch = async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/v1/executions") {
        return Response.json({ executions: [safeRecord] });
      }
      return Response.json({
        ...safeRecord,
        status: "failed",
        output: undefined,
        error: {
          code: "provider_rate_limited",
          message: "Retry later.",
          retryable: true,
          retryAfter: 12,
        },
      });
    };
    const client = new ExecutorClient({
      baseUrl: "https://executor.example",
      fetch,
    });

    await expect(client.listExecutions()).resolves.toMatchObject({
      executions: [
        {
          replayed: true,
          source: { kind: "voice_session", sessionId: "session_safe" },
          attachments: {
            count: 2,
            fileIds: ["file_safe_one", "file_safe_two"],
          },
        },
      ],
    });
    await expect(
      client.getExecution("exe_safe_provenance"),
    ).resolves.toMatchObject({
      status: "failed",
      error: { retryAfter: 12 },
      replayed: true,
    });
  });

  it("rejects malformed health envelopes without treating them as online", async () => {
    const fetch: typeof globalThis.fetch = async () =>
      Response.json({ service: "unknown", status: "ok" });
    const client = new ExecutorClient({
      baseUrl: "https://executor.example",
      fetch,
    });

    await expect(client.health()).rejects.toBeInstanceOf(ExecutorApiError);
  });

  it("lists, creates, and revokes dev-vault connections", async () => {
    const requests: Request[] = [];
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      if (request.method === "POST") {
        return Response.json(
          {
            connectionId: "conn_123",
            redirectUrl: null,
            status: "connected",
          },
          { status: 201 },
        );
      }
      if (request.method === "DELETE") {
        return Response.json({ connectionId: "conn_123", status: "revoked" });
      }
      return Response.json({
        connections: [
          {
            connectionId: "conn_123",
            createdAt: "2026-07-17T09:30:00.000Z",
            status: "connected",
            toolkit: "gmail",
            userId: "user_123",
          },
        ],
      });
    };
    const client = new ExecutorClient({
      baseUrl: "https://executor.example",
      fetch,
    });

    await expect(client.listConnections()).resolves.toMatchObject({
      connections: [{ connectionId: "conn_123" }],
    });
    await expect(
      client.createConnection({ toolkit: "gmail", userId: "user_123" }),
    ).resolves.toMatchObject({ connectionId: "conn_123" });
    await expect(client.revokeConnection("conn_123")).resolves.toEqual({
      connectionId: "conn_123",
      status: "revoked",
    });

    expect(requests.map(({ method, url }) => ({ method, url }))).toEqual([
      { method: "GET", url: "https://executor.example/v1/connections" },
      { method: "POST", url: "https://executor.example/v1/connections" },
      {
        method: "DELETE",
        url: "https://executor.example/v1/connections/conn_123",
      },
    ]);
    await expect(requests[1]?.json()).resolves.toEqual({
      toolkit: "gmail",
      userId: "user_123",
    });
  });

  it("posts try-it executions and preserves normalized error taxonomy", async () => {
    let request: Request | undefined;
    const fetch: typeof globalThis.fetch = async (input, init) => {
      request = new Request(input, init);
      return Response.json(
        {
          error: {
            code: "auth_missing",
            message: "Connect this user first.",
            retryable: false,
          },
          requestId: "req_try_it",
        },
        { status: 422 },
      );
    };
    const client = new ExecutorClient({
      baseUrl: "https://executor.example",
      fetch,
    });

    await expect(
      client.execute(
        {
          input: { query: "invoice" },
          mode: "sync",
          tool: "gmail.search_emails",
          userId: "user_123",
        },
        { idempotencyKey: "dashboard:try-it:1" },
      ),
    ).rejects.toMatchObject({
      code: "auth_missing",
      message: "Connect this user first.",
      requestId: "req_try_it",
      retryable: false,
      status: 422,
    });
    expect(request?.method).toBe("POST");
    expect(request?.headers.get("Content-Type")).toBe("application/json");
    expect(request?.headers.get("Idempotency-Key")).toBe("dashboard:try-it:1");
    await expect(request?.json()).resolves.toMatchObject({
      tool: "gmail.search_emails",
      userId: "user_123",
    });
  });

  it("reads execution detail and advances the dev voice-session harness", async () => {
    const requests: Request[] = [];
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      if (request.method === "POST") {
        return Response.json({
          sessionId: "session_demo",
          state: "in-progress",
          lastSequence: 4,
          terminal: false,
          advancedByMs: 1_000,
        });
      }
      return Response.json({
        executionId: "exe_detail",
        tool: "gmail.send_email",
        toolVersion: "1.0.0",
        catalogVersion: "1.1",
        userId: "user_123",
        status: "succeeded",
        createdAt: "2026-07-17T09:00:00.000Z",
        completedAt: "2026-07-17T09:00:00.100Z",
        latencyMs: 100,
        replayed: true,
        source: { kind: "voice_session", sessionId: "session_demo" },
        attachments: { count: 1, fileIds: ["file_invoice_1"] },
        output: { messageId: "msg_1" },
      });
    };
    const client = new ExecutorClient({
      baseUrl: "https://executor.example",
      fetch,
    });

    await expect(client.getExecution("exe_detail")).resolves.toMatchObject({
      replayed: true,
      source: { kind: "voice_session", sessionId: "session_demo" },
      attachments: { count: 1, fileIds: ["file_invoice_1"] },
    });
    await expect(
      client.advanceVoiceSession("session_demo", {
        userId: "user_123",
        milliseconds: 1_000,
      }),
    ).resolves.toMatchObject({ sessionId: "session_demo" });
    expect(requests.map(({ method, url }) => ({ method, url }))).toEqual([
      {
        method: "GET",
        url: "https://executor.example/v1/executions/exe_detail",
      },
      {
        method: "POST",
        url: "https://executor.example/v1/dev/voice-sessions/session_demo/advance",
      },
    ]);
  });

  it("projects the complete webhook lifecycle onto metadata-only public state", async () => {
    const requests: Request[] = [];
    const endpointId = "whe fixture/one";
    const createdSecret = "whsec_created_reveal_once_fixture";
    const rotatedSecret = "whsec_rotated_reveal_once_fixture";
    const createdAt = "2026-07-21T10:00:00.000Z";
    let endpoint: WebhookEndpoint = {
      endpointId,
      url: "https://receiver.example.test/eyeball",
      secretPrefix: "whsec_created",
      events: ["execution.completed", "trigger.gmail.email_received"],
      active: true,
      createdAt,
      updatedAt: createdAt,
    };
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      const url = new URL(request.url);
      if (request.method === "POST" && url.pathname === "/v1/webhooks") {
        return Response.json(
          {
            ...endpoint,
            secret: createdSecret,
            payload: "create-payload-sentinel",
          },
          { status: 201 },
        );
      }
      if (request.method === "GET" && url.pathname === "/v1/webhooks") {
        return Response.json({
          webhooks: [
            {
              ...endpoint,
              secret: rotatedSecret,
              body: "list-body-sentinel",
            },
          ],
          nextCursor: "endpoint_cursor_2",
        });
      }
      if (request.method === "GET" && url.pathname.endsWith("/deliveries")) {
        return Response.json({
          deliveries: [
            {
              deliveryId: "whd_fixture",
              endpointId,
              eventId: "evt_fixture",
              eventType: "execution.succeeded",
              status: "succeeded",
              attempts: [
                {
                  attempt: 1,
                  attemptedAt: "2026-07-21T10:01:00.000Z",
                  completedAt: "2026-07-21T10:01:00.125Z",
                  statusCode: 204,
                  responseBody: "attempt-response-sentinel",
                },
              ],
              createdAt: "2026-07-21T10:01:00.000Z",
              completedAt: "2026-07-21T10:01:00.125Z",
              payload: "delivery-payload-sentinel",
              responseBody: "delivery-response-sentinel",
              headers: { Authorization: "delivery-header-sentinel" },
              secret: rotatedSecret,
            },
          ],
          nextCursor: "delivery_cursor_2",
        });
      }
      if (request.method === "GET") {
        return Response.json({
          ...endpoint,
          secret: rotatedSecret,
          responseBody: "detail-response-sentinel",
        });
      }
      if (request.method === "PATCH") {
        endpoint = {
          ...endpoint,
          url: "https://receiver.example.test/updated",
          events: ["voice.transcript.ready"],
          active: false,
          updatedAt: "2026-07-21T10:02:00.000Z",
        };
        return Response.json({
          ...endpoint,
          secret: createdSecret,
          payload: "update-payload-sentinel",
        });
      }
      if (
        request.method === "POST" &&
        url.pathname.endsWith("/rotate-secret")
      ) {
        endpoint = {
          ...endpoint,
          secretPrefix: "whsec_rotated",
          updatedAt: "2026-07-21T10:03:00.000Z",
        };
        return Response.json({
          endpointId,
          secretPrefix: endpoint.secretPrefix,
          secret: rotatedSecret,
          rotatedAt: endpoint.updatedAt,
          payload: "rotate-payload-sentinel",
        });
      }
      if (request.method === "DELETE")
        return new Response(null, { status: 204 });
      return Response.json({ error: "unexpected request" }, { status: 500 });
    };
    const client = new ExecutorClient({
      baseUrl: "https://executor.example",
      fetch,
      projectId: "proj_fixture",
    });

    const created = await client.createWebhookEndpoint({
      url: endpoint.url,
      events: endpoint.events,
      active: true,
    });
    expect(created.secret).toBe(createdSecret);

    const firstList = await client.listWebhookEndpoints({
      limit: 25,
      cursor: "endpoint cursor/1",
    });
    const firstGet = await client.getWebhookEndpoint(endpointId);
    expect(JSON.stringify([firstList, firstGet])).not.toContain(createdSecret);
    expect(JSON.stringify([firstList, firstGet])).not.toContain(
      "list-body-sentinel",
    );

    const updated = await client.updateWebhookEndpoint(endpointId, {
      url: "https://receiver.example.test/updated",
      events: ["voice.transcript.ready"],
      active: false,
    });
    expect(updated).toMatchObject({
      active: false,
      events: ["voice.transcript.ready"],
    });

    const rotated = await client.rotateWebhookSecret(endpointId);
    expect(rotated.secret).toBe(rotatedSecret);
    expect(rotated.secret).not.toBe(created.secret);

    const secondGet = await client.getWebhookEndpoint(endpointId);
    const secondList = await client.listWebhookEndpoints();
    expect(secondGet.secretPrefix).toBe("whsec_rotated");
    expect(JSON.stringify([secondGet, secondList])).not.toContain(
      createdSecret,
    );
    expect(JSON.stringify([secondGet, secondList])).not.toContain(
      rotatedSecret,
    );

    const deliveries = await client.listWebhookDeliveries(endpointId, {
      limit: 10,
      cursor: "delivery cursor/1",
    });
    expect(deliveries).toMatchObject({
      deliveries: [
        {
          deliveryId: "whd_fixture",
          attempts: [{ attempt: 1, statusCode: 204 }],
        },
      ],
      nextCursor: "delivery_cursor_2",
    });
    const serializedDeliveries = JSON.stringify(deliveries);
    for (const sentinel of [
      "delivery-payload-sentinel",
      "delivery-response-sentinel",
      "delivery-header-sentinel",
      "attempt-response-sentinel",
      rotatedSecret,
    ]) {
      expect(serializedDeliveries).not.toContain(sentinel);
    }

    await expect(
      client.deleteWebhookEndpoint(endpointId),
    ).resolves.toBeUndefined();

    expect(
      requests.every(
        (request) =>
          request.headers.get(EXECUTOR_PROJECT_HEADER) === "proj_fixture" &&
          request.headers.get("Accept") === "application/json",
      ),
    ).toBe(true);
    expect(requests.map(({ method, url }) => ({ method, url }))).toEqual([
      { method: "POST", url: "https://executor.example/v1/webhooks" },
      {
        method: "GET",
        url: "https://executor.example/v1/webhooks?limit=25&cursor=endpoint+cursor%2F1",
      },
      {
        method: "GET",
        url: "https://executor.example/v1/webhooks/whe%20fixture%2Fone",
      },
      {
        method: "PATCH",
        url: "https://executor.example/v1/webhooks/whe%20fixture%2Fone",
      },
      {
        method: "POST",
        url: "https://executor.example/v1/webhooks/whe%20fixture%2Fone/rotate-secret",
      },
      {
        method: "GET",
        url: "https://executor.example/v1/webhooks/whe%20fixture%2Fone",
      },
      { method: "GET", url: "https://executor.example/v1/webhooks" },
      {
        method: "GET",
        url: "https://executor.example/v1/webhooks/whe%20fixture%2Fone/deliveries?limit=10&cursor=delivery+cursor%2F1",
      },
      {
        method: "DELETE",
        url: "https://executor.example/v1/webhooks/whe%20fixture%2Fone",
      },
    ]);
    await expect(requests[0]?.clone().json()).resolves.toEqual({
      url: "https://receiver.example.test/eyeball",
      events: ["execution.completed", "trigger.gmail.email_received"],
      active: true,
    });
    await expect(requests[3]?.clone().json()).resolves.toEqual({
      url: "https://receiver.example.test/updated",
      events: ["voice.transcript.ready"],
      active: false,
    });
    expect(requests[0]?.headers.get("Content-Type")).toBe("application/json");
    expect(requests[3]?.headers.get("Content-Type")).toBe("application/json");
  });
  it("projects the trigger subscription lifecycle onto metadata-only public state", async () => {
    const requests: Request[] = [];
    const subscriptionId = "trgsub fixture/one";
    const createdIngestUrl =
      "https://executor.example/v1/ingest/trgsub_fixture/created_reveal_once";
    const rotatedIngestUrl =
      "https://executor.example/v1/ingest/trgsub_fixture/rotated_reveal_once";
    const createdAt = "2026-07-21T11:00:00.000Z";
    const subscription = {
      subscriptionId,
      projectId: "proj_fixture",
      userId: "demo_user",
      trigger: "slack.message_received",
      connectionId: "conn_slack_fixture",
      webhookEndpointIds: ["whe_fixture"],
      status: "active",
      createdAt,
      updatedAt: createdAt,
    };
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      const url = new URL(request.url);
      if (request.method === "POST" && url.pathname === "/v1/subscriptions") {
        return Response.json(
          {
            ...subscription,
            ingestUrl: createdIngestUrl,
            providerCursor: "provider-cursor-sentinel",
          },
          { status: 201 },
        );
      }
      if (request.method === "GET" && url.pathname === "/v1/subscriptions") {
        return Response.json({
          subscriptions: [
            {
              ...subscription,
              ingestUrl: rotatedIngestUrl,
              ingestSecret: "list-ingest-secret-sentinel",
            },
          ],
          nextCursor: "subscription_cursor_2",
        });
      }
      if (
        request.method === "POST" &&
        url.pathname.endsWith("/rotate-secret")
      ) {
        return Response.json({
          subscriptionId,
          ingestUrl: rotatedIngestUrl,
          rotatedAt: "2026-07-21T11:05:00.000Z",
          ingestSecret: "rotate-ingest-secret-sentinel",
        });
      }
      if (request.method === "GET") {
        return Response.json({
          ...subscription,
          ingestUrl: rotatedIngestUrl,
        });
      }
      if (request.method === "DELETE")
        return new Response(null, { status: 204 });
      return Response.json({ error: "unexpected request" }, { status: 500 });
    };
    const client = new ExecutorClient({
      baseUrl: "https://executor.example",
      fetch,
      projectId: "proj_fixture",
    });

    const created = await client.createTriggerSubscription({
      trigger: subscription.trigger,
      userId: subscription.userId,
      connectionId: subscription.connectionId,
      webhookEndpointIds: subscription.webhookEndpointIds,
    });
    expect(created.ingestUrl).toBe(createdIngestUrl);

    const list = await client.listTriggerSubscriptions({
      limit: 25,
      cursor: "subscription cursor/1",
      userId: "demo_user",
    });
    const detail = await client.getTriggerSubscription(subscriptionId);
    const listedAndDetail = JSON.stringify([list, detail]);
    expect(listedAndDetail).not.toContain(createdIngestUrl);
    expect(listedAndDetail).not.toContain(rotatedIngestUrl);
    expect(listedAndDetail).not.toContain("list-ingest-secret-sentinel");
    expect(listedAndDetail).not.toContain("provider-cursor-sentinel");
    expect(list.nextCursor).toBe("subscription_cursor_2");

    const rotated = await client.rotateTriggerIngestSecret(subscriptionId);
    expect(rotated.ingestUrl).toBe(rotatedIngestUrl);
    expect(JSON.stringify(rotated)).not.toContain(
      "rotate-ingest-secret-sentinel",
    );

    await expect(
      client.deleteTriggerSubscription(subscriptionId),
    ).resolves.toBeUndefined();

    expect(requests.map(({ method, url }) => ({ method, url }))).toEqual([
      { method: "POST", url: "https://executor.example/v1/subscriptions" },
      {
        method: "GET",
        url: "https://executor.example/v1/subscriptions?limit=25&cursor=subscription+cursor%2F1&userId=demo_user",
      },
      {
        method: "GET",
        url: "https://executor.example/v1/subscriptions/trgsub%20fixture%2Fone",
      },
      {
        method: "POST",
        url: "https://executor.example/v1/subscriptions/trgsub%20fixture%2Fone/rotate-secret",
      },
      {
        method: "DELETE",
        url: "https://executor.example/v1/subscriptions/trgsub%20fixture%2Fone",
      },
    ]);
    await expect(requests[0]?.clone().json()).resolves.toEqual({
      trigger: "slack.message_received",
      userId: "demo_user",
      connectionId: "conn_slack_fixture",
      webhookEndpointIds: ["whe_fixture"],
    });
    expect(requests[0]?.headers.get("Content-Type")).toBe("application/json");
  });
  it("projects the staged file lifecycle onto metadata-only public state", async () => {
    const requests: Request[] = [];
    const fileId = "file_fixture";
    const contentSentinel = "cXVhcnRlcmx5" + "LXJlcG9ydA==";
    const metadata = {
      fileId,
      name: "quarterly-report.pdf",
      mimeType: "application/pdf",
      size: 12,
      expiresAt: "2026-07-21T13:00:00.000Z",
    };
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      const url = new URL(request.url);
      if (request.method === "POST" && url.pathname === "/v1/files") {
        return Response.json(
          { ...metadata, content: contentSentinel },
          { status: 201 },
        );
      }
      if (request.method === "GET" && url.pathname === "/v1/files") {
        return Response.json({
          files: [{ ...metadata, content: contentSentinel }],
          nextCursor: "file_cursor_2",
        });
      }
      return Response.json({ error: "unexpected request" }, { status: 500 });
    };
    const client = new ExecutorClient({
      baseUrl: "https://executor.example",
      fetch,
      projectId: "proj_fixture",
    });

    const staged = await client.uploadStagedFile({
      name: metadata.name,
      mimeType: metadata.mimeType,
      content: contentSentinel,
    });
    expect(staged).toEqual(metadata);
    expect(JSON.stringify(staged)).not.toContain(contentSentinel);

    const page = await client.listStagedFiles({
      limit: 25,
      cursor: "file cursor/1",
    });
    expect(page.files).toEqual([metadata]);
    expect(page.nextCursor).toBe("file_cursor_2");
    expect(JSON.stringify(page)).not.toContain(contentSentinel);

    expect(requests.map(({ method, url }) => ({ method, url }))).toEqual([
      { method: "POST", url: "https://executor.example/v1/files" },
      {
        method: "GET",
        url: "https://executor.example/v1/files?limit=25&cursor=file+cursor%2F1",
      },
    ]);
    expect(requests[0]?.headers.get("Content-Type")).toBe("application/json");
  });

  it("projects and serializes redacted project trigger-event history", async () => {
    let request: Request | undefined;
    const controller = new AbortController();
    const forbidden = {
      payload: "payload-sentinel",
      providerEventId: "provider-event-sentinel",
      rawBody: "raw-body-sentinel",
      pushSecret: "push-secret-sentinel",
      pushSecretSha256: "push-secret-hash-sentinel",
      ingestUrl: "ingest-url-sentinel",
      credentials: "credentials-sentinel",
      accessToken: "access-token-sentinel",
      providerCursor: "provider-cursor-sentinel",
      filters: "filters-sentinel",
      requestHeaders: "request-headers-sentinel",
      signature: "signature-sentinel",
      endpointUrl: "endpoint-url-sentinel",
      responseBody: "response-body-sentinel",
    };
    const fetch: typeof globalThis.fetch = async (input, init) => {
      request = new Request(input, init);
      return Response.json({
        triggerEvents: [
          {
            arrivalId: "trgevt_fixture",
            eventId: "evt_trigger_fixture",
            subscriptionId: "trgsub_fixture",
            trigger: "slack.message_received",
            deliveryMode: "push",
            receivedAt: "2026-07-21T14:00:00.000Z",
            occurredAt: "2026-07-21T13:59:58.000Z",
            dedupStatus: "accepted",
            deliveryStatus: "succeeded",
            requestedWebhookEndpointIds: ["whe_fixture"],
            deliveryTargets: [
              {
                endpointId: "whe_fixture",
                deliveryId: "whd_fixture",
                status: "succeeded",
                ...forbidden,
              },
            ],
            expiresAt: "2026-07-28T14:00:00.000Z",
            ...forbidden,
          },
        ],
        nextCursor: "trigger event cursor/2",
        ...forbidden,
      });
    };
    const client = new ExecutorClient({
      baseUrl: "https://executor.example",
      fetch,
      projectId: "proj_fixture",
    });

    const page = await client.listTriggerEvents(
      {
        limit: 20,
        cursor: "event cursor/1",
        subscriptionId: "trgsub fixture/one",
        trigger: "slack.message received",
      },
      controller.signal,
    );

    expect(request?.url).toBe(
      "https://executor.example/v1/trigger-events?limit=20&cursor=event+cursor%2F1&subscriptionId=trgsub+fixture%2Fone&trigger=slack.message+received",
    );
    expect(request?.signal.aborted).toBe(false);
    expect(page).toEqual({
      triggerEvents: [
        {
          arrivalId: "trgevt_fixture",
          eventId: "evt_trigger_fixture",
          subscriptionId: "trgsub_fixture",
          trigger: "slack.message_received",
          deliveryMode: "push",
          receivedAt: "2026-07-21T14:00:00.000Z",
          occurredAt: "2026-07-21T13:59:58.000Z",
          dedupStatus: "accepted",
          deliveryStatus: "succeeded",
          requestedWebhookEndpointIds: ["whe_fixture"],
          deliveryTargets: [
            {
              endpointId: "whe_fixture",
              deliveryId: "whd_fixture",
              status: "succeeded",
            },
          ],
          expiresAt: "2026-07-28T14:00:00.000Z",
        },
      ],
      nextCursor: "trigger event cursor/2",
    });
    const serialized = JSON.stringify(page);
    for (const [field, sentinel] of Object.entries(forbidden)) {
      expect(serialized).not.toContain(field);
      expect(serialized).not.toContain(sentinel);
    }
  });

  it("rejects malformed trigger-event response shapes", async () => {
    const client = new ExecutorClient({
      baseUrl: "https://executor.example",
      fetch: (async () =>
        Response.json({
          triggerEvents: [
            {
              arrivalId: "trgevt_fixture",
              eventId: "evt_trigger_fixture",
              subscriptionId: "trgsub_fixture",
              trigger: "slack.message_received",
              deliveryMode: "push",
              receivedAt: "2026-07-21T14:00:00.000Z",
              occurredAt: "2026-07-21T13:59:58.000Z",
              dedupStatus: "accepted",
              deliveryStatus: "succeeded",
              requestedWebhookEndpointIds: ["whe_fixture"],
              deliveryTargets: [{ status: "unknown" }],
              expiresAt: "2026-07-28T14:00:00.000Z",
            },
          ],
        })) as typeof globalThis.fetch,
    });

    await expect(client.listTriggerEvents()).rejects.toMatchObject({
      name: "ExecutorApiError",
      status: 502,
    });
  });
});

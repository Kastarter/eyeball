import { createHmac } from "node:crypto";
import { CatalogRegistry } from "@eyeball/catalog";
import {
  type CapabilityToolContract,
  JSON_SCHEMA_DRAFT_2020_12,
  type JsonValue,
  type ProviderManifest,
  type QualifiedToolName,
  TOOL_ERROR_CODES,
  VOICE_AGENT_MAX_DURATION_SECONDS,
  VOICE_SESSION_ID_HEADER,
  VOICE_WORKER_EXECUTION_ID_HEADER,
  voiceSessionExecutionId,
} from "@eyeball/core";
import { type AdapterContext, InMemoryAgentStore } from "@eyeball/toolkits";
import { describe, expect, it, vi } from "vitest";
import {
  AdapterRegistry,
  createExecutorApp,
  createExecutorJobHandlerRegistry,
  createVoiceSessionGrantAuthority,
  ExecutionEngine,
  InMemoryExecutionStore,
  InMemoryTaskQueue,
  type ToolkitAdapter,
  VOICE_SESSION_GRANT_AUDIENCE,
} from "../src/index.js";

const SECRET = "g".repeat(32);
const NOW = new Date("2026-07-21T12:00:00.000Z");
const SESSION_A = "session_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const SESSION_B = "session_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const PROJECT = "proj_shared_worker";
const USER_A = "user_a";
const USER_B = "user_b";
const TOOL_A = "echo.run" as QualifiedToolName;
const TOOL_B = "echo.admin" as QualifiedToolName;

function pointer(
  sessionId: string,
  userId: string,
  grantId: string,
  grantExpiresAt: string,
) {
  return {
    sessionId,
    projectId: PROJECT,
    userId,
    agentId: "va_shared",
    agentRevision: 1,
    callId: `call_${sessionId}`,
    createdAt: NOW.toISOString(),
    grantId,
    grantExpiresAt,
  };
}

function rawSignedToken(payloadJson: string): string {
  const payload = Buffer.from(payloadJson).toString("base64url");
  const signature = createHmac("sha256", SECRET)
    .update("eyeball.voice-session-grant.v1\0")
    .update(payload)
    .digest("base64url");
  return `evg1.${payload}.${signature}`;
}

function decodedClaims(token: string): Record<string, unknown> {
  const payload = token.split(".")[1];
  if (payload === undefined) throw new Error("Missing grant payload.");
  return JSON.parse(
    Buffer.from(payload, "base64url").toString("utf8"),
  ) as Record<string, unknown>;
}

describe("voice-session grant authority", () => {
  it("rejects weak secrets and bounds grant duration at the public ceiling", async () => {
    const store = new InMemoryAgentStore();
    expect(() =>
      createVoiceSessionGrantAuthority({
        secret: "too-short",
        store,
        clock: { now: () => NOW },
      }),
    ).toThrow("at least 32 UTF-8 bytes");

    const authority = createVoiceSessionGrantAuthority({
      secret: SECRET,
      store,
      clock: { now: () => NOW },
    });
    const boundary = await authority.issuer.issue({
      projectId: PROJECT,
      userId: USER_A,
      sessionId: SESSION_A,
      maxDurationSeconds: VOICE_AGENT_MAX_DURATION_SECONDS,
      allowedTools: [TOOL_A],
    });
    const claims = decodedClaims(boundary.token);
    expect(Number(claims.exp) - Number(claims.iat)).toBe(
      VOICE_AGENT_MAX_DURATION_SECONDS + 60,
    );
    await expect(
      authority.issuer.issue({
        projectId: PROJECT,
        userId: USER_A,
        sessionId: SESSION_B,
        maxDurationSeconds: VOICE_AGENT_MAX_DURATION_SECONDS + 1,
        allowedTools: [TOOL_A],
      }),
    ).rejects.toThrow("invalid scope");
  });

  it("issues canonical, tool-normalized HMAC grants with fresh identifiers", async () => {
    const store = new InMemoryAgentStore();
    let entropy = 0;
    const authority = createVoiceSessionGrantAuthority({
      secret: SECRET,
      store,
      clock: { now: () => NOW },
      randomBytes: (size) => new Uint8Array(size).fill(++entropy),
    });
    const first = await authority.issuer.issue({
      projectId: PROJECT,
      userId: USER_A,
      sessionId: SESSION_A,
      maxDurationSeconds: 300,
      allowedTools: [TOOL_B, TOOL_A, TOOL_A],
    });
    const second = await authority.issuer.issue({
      projectId: PROJECT,
      userId: USER_A,
      sessionId: SESSION_B,
      maxDurationSeconds: 300,
      allowedTools: [TOOL_A],
    });

    expect(first.grantId).not.toBe(second.grantId);
    expect(decodedClaims(first.token)).toEqual({
      aud: VOICE_SESSION_GRANT_AUDIENCE,
      exp: Math.floor(NOW.getTime() / 1_000) + 360,
      iat: Math.floor(NOW.getTime() / 1_000),
      jti: first.grantId,
      projectId: PROJECT,
      sessionId: SESSION_A,
      tools: [TOOL_B, TOOL_A].sort(),
      userId: USER_A,
    });
    await store.rememberSession(
      pointer(SESSION_A, USER_A, first.grantId, first.expiresAt),
    );
    await expect(authority.verifier.verify(first.token)).resolves.toMatchObject(
      {
        status: "valid",
        principal: { userId: USER_A, sessionId: SESSION_A },
      },
    );
  });

  it("rejects tampering, malformed encodings, oversized tokens, and noncanonical claims", async () => {
    const store = new InMemoryAgentStore();
    const authority = createVoiceSessionGrantAuthority({
      secret: SECRET,
      store,
      clock: { now: () => NOW },
    });
    const issued = await authority.issuer.issue({
      projectId: PROJECT,
      userId: USER_A,
      sessionId: SESSION_A,
      maxDurationSeconds: 60,
      allowedTools: [TOOL_A],
    });
    const [prefix, payload, signature] = issued.token.split(".");
    expect(
      await authority.verifier.verify(`${prefix}.${payload}x.${signature}`),
    ).toEqual({ status: "invalid" });
    expect(
      await authority.verifier.verify(
        `${prefix}.${payload}.${signature?.slice(0, -1)}x`,
      ),
    ).toEqual({ status: "invalid" });
    expect(await authority.verifier.verify("evg1.bad=.bad=")).toEqual({
      status: "invalid",
    });
    expect(
      await authority.verifier.verify(`evg1.${"a".repeat(8_200)}.x`),
    ).toEqual({ status: "invalid" });

    const claims = decodedClaims(issued.token);
    expect(
      await authority.verifier.verify(
        rawSignedToken(JSON.stringify({ ...claims, unexpected: true })),
      ),
    ).toEqual({ status: "invalid" });
    const reordered = JSON.stringify({
      userId: claims.userId,
      aud: claims.aud,
      exp: claims.exp,
      iat: claims.iat,
      jti: claims.jti,
      projectId: claims.projectId,
      sessionId: claims.sessionId,
      tools: claims.tools,
    });
    expect(await authority.verifier.verify(rawSignedToken(reordered))).toEqual({
      status: "invalid",
    });
    const duplicateKey = rawSignedToken(
      JSON.stringify(claims).replace(
        `"aud":"${VOICE_SESSION_GRANT_AUDIENCE}"`,
        `"aud":"${VOICE_SESSION_GRANT_AUDIENCE}","aud":"${VOICE_SESSION_GRANT_AUDIENCE}"`,
      ),
    );
    expect(await authority.verifier.verify(duplicateKey)).toEqual({
      status: "invalid",
    });
  });

  it("applies audience, skew, expiry, durable identity, and immediate revocation", async () => {
    const store = new InMemoryAgentStore();
    let now = NOW;
    const authority = createVoiceSessionGrantAuthority({
      secret: SECRET,
      store,
      clock: { now: () => now },
    });
    const issued = await authority.issuer.issue({
      projectId: PROJECT,
      userId: USER_A,
      sessionId: SESSION_A,
      maxDurationSeconds: 60,
      allowedTools: [TOOL_A],
    });
    const claims = decodedClaims(issued.token);
    const wrongAudience = rawSignedToken(
      JSON.stringify({
        aud: "another.executor.audience",
        exp: claims.exp,
        iat: claims.iat,
        jti: claims.jti,
        projectId: claims.projectId,
        sessionId: claims.sessionId,
        tools: claims.tools,
        userId: claims.userId,
      }),
    );
    expect(await authority.verifier.verify(wrongAudience)).toEqual({
      status: "insufficient_scope",
    });
    expect(await authority.verifier.verify(issued.token)).toEqual({
      status: "expired",
    });
    await store.rememberSession(
      pointer(SESSION_A, USER_A, issued.grantId, issued.expiresAt),
    );
    now = new Date(NOW.getTime() - 30_000);
    expect((await authority.verifier.verify(issued.token)).status).toBe(
      "valid",
    );
    now = new Date(NOW.getTime() - 31_000);
    expect(await authority.verifier.verify(issued.token)).toEqual({
      status: "expired",
    });
    now = new Date(new Date(issued.expiresAt).getTime() + 30_000);
    expect((await authority.verifier.verify(issued.token)).status).toBe(
      "valid",
    );
    now = new Date(new Date(issued.expiresAt).getTime() + 31_000);
    expect(await authority.verifier.verify(issued.token)).toEqual({
      status: "expired",
    });
    now = NOW;
    await store.revokeSessionGrant({
      projectId: PROJECT,
      userId: USER_A,
      sessionId: SESSION_A,
      grantId: issued.grantId,
      revokedAt: NOW.toISOString(),
    });
    expect(await authority.verifier.verify(issued.token)).toEqual({
      status: "expired",
    });
  });

  it("maps grant-store failures to unavailable without positive caching", async () => {
    const backing = new InMemoryAgentStore();
    let unavailable = false;
    const store: InMemoryAgentStore = new Proxy(backing, {
      get(target, property, receiver) {
        if (property === "getSession" && unavailable) {
          return async () => {
            throw new Error("store unavailable");
          };
        }
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const authority = createVoiceSessionGrantAuthority({
      secret: SECRET,
      store,
      clock: { now: () => NOW },
    });
    const issued = await authority.issuer.issue({
      projectId: PROJECT,
      userId: USER_A,
      sessionId: SESSION_A,
      maxDurationSeconds: 60,
      allowedTools: [TOOL_A],
    });
    await backing.rememberSession(
      pointer(SESSION_A, USER_A, issued.grantId, issued.expiresAt),
    );
    expect((await authority.verifier.verify(issued.token)).status).toBe(
      "valid",
    );
    unavailable = true;
    expect(await authority.verifier.verify(issued.token)).toEqual({
      status: "unavailable",
    });
  });
});

function contract(name: "run" | "admin"): CapabilityToolContract {
  return {
    capability: "ai_media_utilities",
    name,
    description: `Execute ${name}.`,
    inputSchema: {
      $schema: JSON_SCHEMA_DRAFT_2020_12,
      $id: `urn:eyeball:test:grant:${name}:input:1.0.0`,
      type: "object",
      additionalProperties: false,
      required: ["message"],
      properties: { message: { type: "string", minLength: 1 } },
    },
    outputSchema: {
      $schema: JSON_SCHEMA_DRAFT_2020_12,
      $id: `urn:eyeball:test:grant:${name}:output:1.0.0`,
      type: "object",
      additionalProperties: false,
      required: ["ok"],
      properties: { ok: { type: "boolean" } },
    },
    annotations: {
      readOnly: true,
      destructive: false,
      idempotent: true,
      async: false,
    },
    version: "1.0.0",
  };
}

function manifest(): ProviderManifest {
  return {
    schemaVersion: "1.0",
    catalogVersion: "2.0",
    toolkit: {
      slug: "echo",
      displayName: "Echo",
      source: "native",
      tier: "P0",
    },
    auth: { class: "none", requiredScopes: [] },
    endpoint: { baseUrl: "https://unused.example.test" },
    implements: [
      {
        capability: "ai_media_utilities",
        canonicalTool: "run",
        canonicalVersion: "1.0.0",
        operationId: "echo.run",
      },
      {
        capability: "ai_media_utilities",
        canonicalTool: "admin",
        canonicalVersion: "1.0.0",
        operationId: "echo.admin",
      },
    ],
  };
}

class EchoAdapter implements ToolkitAdapter {
  readonly toolkitSlug = "echo";
  readonly execute = vi.fn(
    async (_context: AdapterContext): Promise<JsonValue> => ({
      ok: true,
    }),
  );
}

async function routeHarness() {
  const catalog = new CatalogRegistry({
    catalogVersion: "2.0",
    contracts: [contract("run"), contract("admin")],
    manifests: [manifest()],
  });
  const adapter = new EchoAdapter();
  const executionStore = new InMemoryExecutionStore();
  const queue = new InMemoryTaskQueue();
  const engine = new ExecutionEngine({
    catalog,
    adapters: new AdapterRegistry([adapter]),
    store: executionStore,
    queue,
  });
  queue.bindHandlers(
    createExecutorJobHandlerRegistry({
      engine,
      webhookDeliverer: engine.webhookDeliverer,
    }),
  );
  queue.start();
  const grantStore = new InMemoryAgentStore();
  const authority = createVoiceSessionGrantAuthority({
    secret: SECRET,
    store: grantStore,
    clock: { now: () => NOW },
  });
  const staticVerify = vi.fn(async (token: string) =>
    token === "static-pinned-a"
      ? { valid: true as const, projectId: PROJECT, userId: USER_A }
      : { valid: false as const },
  );
  const app = createExecutorApp({
    engine,
    apiKeyAuthenticator: { verify: staticVerify },
    voiceSessionGrantVerifier: authority.verifier,
    requestIdFactory: () => "req_voice_grant_test",
  });

  async function grant(
    sessionId: string,
    userId: string,
    tools: readonly QualifiedToolName[],
  ) {
    const issued = await authority.issuer.issue({
      projectId: PROJECT,
      userId,
      sessionId,
      maxDurationSeconds: 300,
      allowedTools: tools,
    });
    await grantStore.rememberSession(
      pointer(sessionId, userId, issued.grantId, issued.expiresAt),
    );
    return issued;
  }
  return {
    adapter,
    app,
    authority,
    engine,
    grant,
    grantStore,
    staticVerify,
  };
}

function executeRequest(input: {
  token: string;
  sessionId: string;
  sequence?: number;
  userId: string;
  tool: QualifiedToolName;
  trustedUserId?: string;
  mode?: "sync" | "async";
  executionId?: string;
}): Request {
  const sequence = input.sequence ?? 1;
  return new Request("http://executor.test/v1/execute", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${input.token}`,
      "Content-Type": "application/json",
      "Idempotency-Key": `voice-session:${input.sessionId}:event:${sequence}`,
      [VOICE_SESSION_ID_HEADER]: input.sessionId,
      [VOICE_WORKER_EXECUTION_ID_HEADER]:
        input.executionId ??
        voiceSessionExecutionId(input.sessionId, `test:event:${sequence}`),
      ...(input.trustedUserId === undefined
        ? {}
        : { "X-Eyeball-User-Id": input.trustedUserId }),
    },
    body: JSON.stringify({
      tool: input.tool,
      userId: input.userId,
      input: { message: "hello" },
      mode: input.mode ?? "sync",
    }),
  });
}

describe("voice-session grant route confinement", () => {
  it("proves two users on one worker cannot cross user, session, or tool scope", async () => {
    const harness = await routeHarness();
    const grantA = await harness.grant(SESSION_A, USER_A, [TOOL_A]);
    const grantB = await harness.grant(SESSION_B, USER_B, [TOOL_B]);

    const allowedA = await harness.app.request(
      executeRequest({
        token: grantA.token,
        sessionId: SESSION_A,
        userId: USER_A,
        tool: TOOL_A,
      }),
    );
    expect(allowedA.status).toBe(200);
    const allowedABody = (await allowedA.json()) as { executionId: string };
    await expect(
      harness.engine.getExecution(PROJECT, allowedABody.executionId),
    ).resolves.toMatchObject({
      source: { kind: "voice_session", sessionId: SESSION_A },
    });
    const allocationsAfterA = harness.adapter.execute.mock.calls.length;

    for (const request of [
      executeRequest({
        token: grantA.token,
        sessionId: SESSION_A,
        userId: USER_B,
        tool: TOOL_A,
      }),
      executeRequest({
        token: grantA.token,
        sessionId: SESSION_B,
        userId: USER_A,
        tool: TOOL_A,
      }),
      executeRequest({
        token: grantA.token,
        sessionId: SESSION_A,
        userId: USER_A,
        tool: TOOL_B,
      }),
      executeRequest({
        token: grantA.token,
        sessionId: SESSION_A,
        userId: USER_A,
        trustedUserId: USER_B,
        tool: TOOL_A,
      }),
    ]) {
      const response = await harness.app.request(request);
      expect(response.status).toBe(403);
      expect((await response.json()).error.code).toBe(
        TOOL_ERROR_CODES.AUTH_INSUFFICIENT_SCOPE,
      );
    }
    expect(harness.adapter.execute).toHaveBeenCalledTimes(allocationsAfterA);

    const allowedB = await harness.app.request(
      executeRequest({
        token: grantB.token,
        sessionId: SESSION_B,
        userId: USER_B,
        tool: TOOL_B,
      }),
    );
    expect(allowedB.status).toBe(200);
    const bRecords = await harness.engine.listExecutions(PROJECT, {
      userId: USER_B,
    });
    expect(bRecords.executions).toHaveLength(1);
    expect(bRecords.executions[0]?.userId).toBe(USER_B);
    expect(bRecords.executions[0]?.source).toEqual({
      kind: "voice_session",
      sessionId: SESSION_B,
    });

    await harness.grantStore.revokeSessionGrant({
      projectId: PROJECT,
      userId: USER_A,
      sessionId: SESSION_A,
      grantId: grantA.grantId,
      revokedAt: NOW.toISOString(),
    });
    const revokedA = await harness.app.request(
      executeRequest({
        token: grantA.token,
        sessionId: SESSION_A,
        sequence: 2,
        userId: USER_A,
        tool: TOOL_A,
      }),
    );
    expect(revokedA.status).toBe(401);
    expect((await revokedA.json()).error.code).toBe(
      TOOL_ERROR_CODES.AUTH_EXPIRED,
    );
    const stillAllowedB = await harness.app.request(
      executeRequest({
        token: grantB.token,
        sessionId: SESSION_B,
        sequence: 2,
        userId: USER_B,
        tool: TOOL_B,
      }),
    );
    expect(stillAllowedB.status).toBe(200);
    expect(harness.staticVerify).not.toHaveBeenCalledWith(grantA.token);
  });

  it("confines grants to the exact child request shape and route", async () => {
    const harness = await routeHarness();
    const issued = await harness.grant(SESSION_A, USER_A, [TOOL_A]);
    const base = executeRequest({
      token: issued.token,
      sessionId: SESSION_A,
      userId: USER_A,
      tool: TOOL_A,
    });
    const withoutIdempotency = executeRequest({
      token: issued.token,
      sessionId: SESSION_A,
      userId: USER_A,
      tool: TOOL_A,
    });
    withoutIdempotency.headers.delete("Idempotency-Key");
    const crossSessionRetryKey = executeRequest({
      token: issued.token,
      sessionId: SESSION_A,
      userId: USER_A,
      tool: TOOL_A,
    });
    crossSessionRetryKey.headers.set(
      "Idempotency-Key",
      `voice-session:${SESSION_B}:event:1`,
    );
    const nonPositiveSequence = executeRequest({
      token: issued.token,
      sessionId: SESSION_A,
      userId: USER_A,
      tool: TOOL_A,
    });
    nonPositiveSequence.headers.set(
      "Idempotency-Key",
      `voice-session:${SESSION_A}:event:0`,
    );
    const malformedSequence = executeRequest({
      token: issued.token,
      sessionId: SESSION_A,
      userId: USER_A,
      tool: TOOL_A,
    });
    malformedSequence.headers.set(
      "Idempotency-Key",
      `voice-session:${SESSION_A}:event:01`,
    );
    const mutations: Request[] = [
      new Request(base, {
        headers: new Headers(
          [...base.headers].filter(
            ([name]) => name !== VOICE_SESSION_ID_HEADER.toLowerCase(),
          ),
        ),
      }),
      executeRequest({
        token: issued.token,
        sessionId: SESSION_A,
        userId: USER_A,
        tool: TOOL_A,
        mode: "async",
      }),
      executeRequest({
        token: issued.token,
        sessionId: SESSION_A,
        userId: USER_A,
        tool: TOOL_A,
        executionId: "not-an-execution-id",
      }),
      withoutIdempotency,
      crossSessionRetryKey,
      nonPositiveSequence,
      malformedSequence,
    ];
    for (const request of mutations) {
      const response = await harness.app.request(request);
      expect(response.status).toBe(403);
    }
    const wrongRoute = await harness.app.request("/v1/executions", {
      headers: { Authorization: `Bearer ${issued.token}` },
    });
    expect(wrongRoute.status).toBe(403);
    const cancelRoute = await harness.app.request(
      "/v1/executions/exe_voice_grant_cancel/cancel",
      {
        method: "POST",
        headers: { Authorization: `Bearer ${issued.token}` },
      },
    );
    expect(cancelRoute.status).toBe(403);
    expect(harness.adapter.execute).not.toHaveBeenCalled();
    await expect(harness.engine.listExecutions(PROJECT)).resolves.toEqual({
      executions: [],
    });
  });

  it("prevents one grant from preclaiming another session's execution ID", async () => {
    const harness = await routeHarness();
    const grantA = await harness.grant(SESSION_A, USER_A, [TOOL_A]);
    const grantB = await harness.grant(SESSION_B, USER_A, [TOOL_A]);
    const sessionBExecutionId = voiceSessionExecutionId(
      SESSION_B,
      "future:event:1",
    );

    const preclaim = await harness.app.request(
      executeRequest({
        token: grantA.token,
        sessionId: SESSION_A,
        userId: USER_A,
        tool: TOOL_A,
        executionId: sessionBExecutionId,
      }),
    );
    expect(preclaim.status).toBe(403);
    expect(harness.adapter.execute).not.toHaveBeenCalled();
    await expect(harness.engine.listExecutions(PROJECT)).resolves.toEqual({
      executions: [],
    });

    const legitimate = await harness.app.request(
      executeRequest({
        token: grantB.token,
        sessionId: SESSION_B,
        userId: USER_A,
        tool: TOOL_A,
        executionId: sessionBExecutionId,
      }),
    );
    expect(legitimate.status).toBe(200);
    const legitimateBody = await legitimate.json();
    expect(legitimateBody).toMatchObject({
      executionId: sessionBExecutionId,
    });
  });

  it("preserves the dedicated static pinned-key path", async () => {
    const harness = await routeHarness();
    const allowed = await harness.app.request(
      executeRequest({
        token: "static-pinned-a",
        sessionId: SESSION_A,
        userId: USER_A,
        tool: TOOL_A,
      }),
    );
    expect(allowed.status).toBe(200);
    const allowedBody = (await allowed.json()) as { executionId: string };
    await expect(
      harness.engine.getExecution(PROJECT, allowedBody.executionId),
    ).resolves.toMatchObject({
      source: { kind: "voice_session", sessionId: SESSION_A },
    });
    const crossUser = executeRequest({
      token: "static-pinned-a",
      sessionId: SESSION_A,
      sequence: 2,
      userId: USER_B,
      tool: TOOL_A,
    });
    const missingSessionHeader = executeRequest({
      token: "static-pinned-a",
      sessionId: SESSION_A,
      sequence: 3,
      userId: USER_A,
      tool: TOOL_A,
    });
    missingSessionHeader.headers.delete(VOICE_SESSION_ID_HEADER);
    const crossSessionId = executeRequest({
      token: "static-pinned-a",
      sessionId: SESSION_A,
      sequence: 4,
      userId: USER_A,
      tool: TOOL_A,
      executionId: voiceSessionExecutionId(SESSION_B, "test:event:4"),
    });
    const mismatchedKey = executeRequest({
      token: "static-pinned-a",
      sessionId: SESSION_A,
      sequence: 5,
      userId: USER_A,
      tool: TOOL_A,
    });
    mismatchedKey.headers.set(
      "Idempotency-Key",
      `voice-session:${SESSION_B}:event:5`,
    );
    for (const request of [
      crossUser,
      missingSessionHeader,
      crossSessionId,
      mismatchedKey,
    ]) {
      const denied = await harness.app.request(request);
      expect(denied.status).toBe(403);
    }
    await expect(
      harness.engine.getExecution(PROJECT, allowedBody.executionId),
    ).resolves.toMatchObject({
      userId: USER_A,
      source: { kind: "voice_session", sessionId: SESSION_A },
    });
    await expect(harness.engine.listExecutions(PROJECT)).resolves.toMatchObject(
      {
        executions: [
          {
            executionId: allowedBody.executionId,
            source: { kind: "voice_session", sessionId: SESSION_A },
          },
        ],
      },
    );
  });

  it("authenticates an exact grant-looking static key before grant or Cloud dispatch", async () => {
    const harness = await routeHarness();
    const grantVerify = vi.fn(async () => ({ status: "invalid" as const }));
    const cloudVerify = vi.fn(async () =>
      Response.json({ valid: false }, { status: 200 }),
    );
    const token = "evg1.legacy-worker";
    const app = createExecutorApp({
      engine: harness.engine,
      env: {
        EYEBALL_API_KEYS: `${token}:${PROJECT}:${USER_A}`,
        EYEBALL_KEY_VERIFY_URL:
          "https://cloud.example.test/internal/keys/verify",
        EYEBALL_INTERNAL_API_SECRET: "i".repeat(32),
      },
      fetchImpl: cloudVerify,
      voiceSessionGrantVerifier: { verify: grantVerify },
      requestIdFactory: () => "req_grant_looking_static_key",
    });

    const response = await app.request(
      executeRequest({
        token,
        sessionId: SESSION_A,
        userId: USER_A,
        tool: TOOL_A,
      }),
    );
    expect(response.status).toBe(200);
    expect(grantVerify).not.toHaveBeenCalled();
    expect(cloudVerify).not.toHaveBeenCalled();
  });
});

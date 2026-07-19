import {
  type AdapterContext,
  createFileId,
  type JsonValue,
  MockCredentialProvider,
  type ToolkitAdapter,
} from "@eyeball/core";
import { describe, expect, it } from "vitest";
import {
  AdapterRegistry,
  createExecutorApp,
  ExecutionEngine,
} from "../src/index.js";

const KEY_A = "ey_files_project_a";
const KEY_B = "ey_files_project_b";
const KEY_PINNED = "ey_files_pinned";
const PROJECT_A = "proj_files_a";
const PROJECT_B = "proj_files_b";

class ResolvingAttachmentAdapter implements ToolkitAdapter {
  readonly toolkitSlug = "gmail";

  async execute(context: AdapterContext): Promise<JsonValue> {
    const attachment = Array.isArray(context.canonicalInput.attachments)
      ? context.canonicalInput.attachments[0]
      : undefined;
    if (
      typeof attachment !== "object" ||
      attachment === null ||
      Array.isArray(attachment) ||
      typeof attachment.fileId !== "string"
    ) {
      throw new Error("Test fixture attachment is missing.");
    }
    await context.files.resolve(attachment.fileId as `file_${string}`);
    return {
      messageId: "unexpected_success",
      acceptedRecipients: ["recipient@example.com"],
    };
  }
}

function createHarness(
  options: {
    ttlMs?: number;
    maxFileSizeBytes?: number;
    withAdapter?: boolean;
  } = {},
) {
  let now = Date.parse("2026-07-17T12:00:00.000Z");
  let fileIndex = 0;
  const clock = { now: () => new Date(now) };
  const credentialProvider = new MockCredentialProvider([
    {
      match: {
        projectId: PROJECT_B,
        userId: "user_b",
        toolkitSlug: "gmail",
      },
      credential: {
        type: "oauth2",
        accessToken: "fixture:gmail",
        scopes: ["https://www.googleapis.com/auth/gmail.modify"],
      },
    },
  ]);
  const engine = new ExecutionEngine({
    clock,
    credentialProvider,
    adapters: new AdapterRegistry(
      options.withAdapter === true ? [new ResolvingAttachmentAdapter()] : [],
    ),
    ...(options.ttlMs === undefined ? {} : { fileTtlMs: options.ttlMs }),
    ...(options.maxFileSizeBytes === undefined
      ? {}
      : { maxFileSizeBytes: options.maxFileSizeBytes }),
    fileIdFactory: () => {
      fileIndex += 1;
      return createFileId(`test_${fileIndex}`);
    },
  });
  const app = createExecutorApp({
    engine,
    apiKeys: {
      [KEY_A]: PROJECT_A,
      [KEY_B]: PROJECT_B,
      [KEY_PINNED]: { projectId: PROJECT_A, userId: "user_pinned" },
    },
    requestIdFactory: () => "req_files",
  });
  return {
    app,
    engine,
    advance(milliseconds: number) {
      now += milliseconds;
    },
  };
}

function authorization(key: string): Record<string, string> {
  return {
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
  };
}

async function stage(
  app: ReturnType<typeof createExecutorApp>,
  key: string,
  options: { name?: string; mimeType?: string; content?: Buffer } = {},
) {
  return app.request("/v1/files", {
    method: "POST",
    headers: authorization(key),
    body: JSON.stringify({
      name: options.name ?? "greeting.txt",
      mimeType: options.mimeType ?? "text/plain",
      content: (options.content ?? Buffer.from("hello", "utf8")).toString(
        "base64",
      ),
    }),
  });
}

describe.sequential("staged files", () => {
  it("stages bytes and returns project-scoped metadata without exposing content", async () => {
    const { app, engine } = createHarness();
    const uploaded = await stage(app, KEY_A);
    expect(uploaded.status).toBe(201);
    const metadata = await uploaded.json();
    expect(metadata).toEqual({
      fileId: "file_test_1",
      name: "greeting.txt",
      mimeType: "text/plain",
      size: 5,
      expiresAt: "2026-07-17T13:00:00.000Z",
    });

    const fetched = await app.request(`/v1/files/${metadata.fileId}`, {
      headers: authorization(KEY_A),
    });
    expect(fetched.status).toBe(200);
    await expect(fetched.json()).resolves.toEqual(metadata);
    const internal = await engine.getFile(PROJECT_A, metadata.fileId);
    expect(Buffer.from(internal.content).toString("utf8")).toBe("hello");
  });

  it("expires files according to the injected clock", async () => {
    const harness = createHarness({ ttlMs: 1_000 });
    const uploaded = await stage(harness.app, KEY_A);
    const metadata = await uploaded.json();
    harness.advance(1_000);

    const expired = await harness.app.request(`/v1/files/${metadata.fileId}`, {
      headers: authorization(KEY_A),
    });
    expect(expired.status).toBe(404);
    await expect(expired.json()).resolves.toMatchObject({
      error: { code: "not_found" },
    });
  });

  it("rejects decoded content over the configured size limit", async () => {
    const { app } = createHarness({ maxFileSizeBytes: 3 });
    const oversized = await stage(app, KEY_A, {
      content: Buffer.from([0, 1, 2, 3]),
    });
    expect(oversized.status).toBe(413);
    await expect(oversized.json()).resolves.toMatchObject({
      error: { code: "invalid_input" },
    });
  });

  it("rejects an oversized upload body before JSON parsing", async () => {
    const { app } = createHarness({ maxFileSizeBytes: 3 });
    const oversized = await app.request("/v1/files", {
      method: "POST",
      headers: authorization(KEY_A),
      body: JSON.stringify({
        name: "x".repeat(17 * 1_024),
        content: "",
      }),
    });
    expect(oversized.status).toBe(413);
    await expect(oversized.json()).resolves.toMatchObject({
      error: { code: "invalid_input" },
    });
  });

  it("hides files across projects from both HTTP and adapter resolution", async () => {
    const { app } = createHarness({ withAdapter: true });
    const uploaded = await stage(app, KEY_A);
    const metadata = await uploaded.json();

    const crossProject = await app.request(`/v1/files/${metadata.fileId}`, {
      headers: authorization(KEY_B),
    });
    expect(crossProject.status).toBe(404);

    const execution = await app.request("/v1/execute", {
      method: "POST",
      headers: {
        ...authorization(KEY_B),
        "Idempotency-Key": "cross-project-file",
      },
      body: JSON.stringify({
        tool: "gmail.send_email",
        userId: "user_b",
        mode: "sync",
        input: {
          to: ["recipient@example.com"],
          subject: "Isolation",
          body: "This must fail before provider I/O.",
          attachments: [{ fileId: metadata.fileId }],
        },
      }),
    });
    expect(execution.status).toBe(200);
    await expect(execution.json()).resolves.toMatchObject({
      status: "failed",
      error: { code: "not_found" },
    });
  });

  it("requires API-key auth and enforces pinned-user headers", async () => {
    const { app } = createHarness();
    const missing = await app.request("/v1/files", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "x", content: "" }),
    });
    expect(missing.status).toBe(401);

    const conflicting = await app.request("/v1/files", {
      method: "POST",
      headers: {
        ...authorization(KEY_PINNED),
        "X-Eyeball-User-Id": "another_user",
      },
      body: JSON.stringify({ name: "x", content: "" }),
    });
    expect(conflicting.status).toBe(403);
    await expect(conflicting.json()).resolves.toMatchObject({
      error: { code: "auth_insufficient_scope" },
    });
  });
});

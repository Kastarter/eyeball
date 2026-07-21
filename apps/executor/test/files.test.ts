import {
  type AdapterContext,
  createFileId,
  type JsonValue,
  MockCredentialProvider,
  type ToolkitAdapter,
} from "@eyeball/core";
import { describe, expect, it, vi } from "vitest";
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
  it("lists an empty project as a metadata-only page", async () => {
    const { app } = createHarness();
    const response = await app.request("/v1/files", {
      headers: authorization(KEY_A),
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ files: [] });
  });

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

  it("lists newest files first and paginates from the last live metadata row", async () => {
    const { app } = createHarness();
    const uploaded = [];
    for (const name of ["oldest.txt", "middle.txt", "newest.txt"]) {
      const response = await stage(app, KEY_A, { name });
      expect(response.status).toBe(201);
      uploaded.push(await response.json());
    }

    const first = await app.request("/v1/files?limit=2", {
      headers: authorization(KEY_A),
    });
    expect(first.status).toBe(200);
    const firstPage = (await first.json()) as {
      files: Record<string, unknown>[];
      nextCursor?: string;
    };
    expect(firstPage.files).toEqual([uploaded[2], uploaded[1]]);
    expect(firstPage.nextCursor).toBeTypeOf("string");
    for (const metadata of firstPage.files) {
      expect(Object.keys(metadata).sort()).toEqual(
        ["expiresAt", "fileId", "mimeType", "name", "size"].sort(),
      );
      for (const forbidden of [
        "content",
        "bytes",
        "body",
        "payload",
        "storageKey",
        "objectStoreKey",
      ]) {
        expect(metadata).not.toHaveProperty(forbidden);
      }
    }

    const second = await app.request(
      `/v1/files?limit=2&cursor=${encodeURIComponent(firstPage.nextCursor ?? "")}`,
      { headers: authorization(KEY_A) },
    );
    expect(second.status).toBe(200);
    await expect(second.json()).resolves.toEqual({ files: [uploaded[0]] });
  });

  it("serves single metadata and list routes without invoking the byte read path", async () => {
    const { app, engine } = createHarness();
    const uploaded = await stage(app, KEY_A);
    const metadata = (await uploaded.json()) as { fileId: string };
    const byteRead = vi
      .spyOn(engine.fileStore, "get")
      .mockRejectedValue(new Error("metadata routes must not load bytes"));
    try {
      const single = await app.request(`/v1/files/${metadata.fileId}`, {
        headers: authorization(KEY_A),
      });
      const list = await app.request("/v1/files", {
        headers: authorization(KEY_A),
      });
      expect(single.status).toBe(200);
      expect(list.status).toBe(200);
      expect(byteRead).not.toHaveBeenCalled();
    } finally {
      byteRead.mockRestore();
    }
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
    const listed = await harness.app.request("/v1/files", {
      headers: authorization(KEY_A),
    });
    await expect(listed.json()).resolves.toEqual({ files: [] });
  });

  it("continues from an expired cursor anchor while the row remains unswept", async () => {
    const harness = createHarness();
    await harness.engine.fileStore.put(PROJECT_A, {
      createdAt: "2026-07-17T11:59:00.000Z",
      meta: {
        fileId: createFileId("older_live"),
        name: "older.txt",
        mimeType: "text/plain",
        size: 5,
        expiresAt: "2026-07-17T13:00:00.000Z",
      },
      content: Uint8Array.from(Buffer.from("older")),
    });
    await harness.engine.fileStore.put(PROJECT_A, {
      createdAt: "2026-07-17T12:00:00.000Z",
      meta: {
        fileId: createFileId("expiring_anchor"),
        name: "anchor.txt",
        mimeType: "text/plain",
        size: 6,
        expiresAt: "2026-07-17T12:00:01.000Z",
      },
      content: Uint8Array.from(Buffer.from("anchor")),
    });
    const first = await harness.app.request("/v1/files?limit=1", {
      headers: authorization(KEY_A),
    });
    const page = (await first.json()) as {
      files: { fileId: string }[];
      nextCursor: string;
    };
    expect(page.files.map(({ fileId }) => fileId)).toEqual([
      "file_expiring_anchor",
    ]);
    harness.advance(1_000);
    const continuation = await harness.app.request(
      `/v1/files?limit=1&cursor=${encodeURIComponent(page.nextCursor)}`,
      { headers: authorization(KEY_A) },
    );
    expect(continuation.status).toBe(200);
    await expect(continuation.json()).resolves.toMatchObject({
      files: [{ fileId: "file_older_live" }],
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

    const ownPage = await app.request("/v1/files?limit=1", {
      headers: authorization(KEY_A),
    });
    const ownList = (await ownPage.json()) as {
      files: unknown[];
      nextCursor?: string;
    };
    expect(ownList.files).toHaveLength(1);
    const otherList = await app.request("/v1/files", {
      headers: authorization(KEY_B),
    });
    await expect(otherList.json()).resolves.toEqual({ files: [] });

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

  it("rejects malformed, unknown, and cross-project cursors", async () => {
    const { app } = createHarness();
    await stage(app, KEY_A, { name: "older.txt" });
    await stage(app, KEY_A, { name: "newer.txt" });
    const first = await app.request("/v1/files?limit=1", {
      headers: authorization(KEY_A),
    });
    const page = (await first.json()) as { nextCursor: string };
    const unknown = Buffer.from(
      JSON.stringify({ after: "file_unknown_cursor" }),
    ).toString("base64url");
    for (const request of [
      "/v1/files?cursor=not-valid!",
      `/v1/files?cursor=${unknown}`,
      `/v1/files?cursor=${encodeURIComponent(page.nextCursor)}`,
    ]) {
      const key = request.includes(page.nextCursor) ? KEY_B : KEY_A;
      const response = await app.request(request, {
        headers: authorization(key),
      });
      expect(response.status).toBe(422);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: "invalid_input" },
      });
    }
  });

  it("rejects invalid file list limits and empty cursors", async () => {
    const { app } = createHarness();
    for (const query of [
      "limit=0",
      "limit=101",
      "limit=1.5",
      "limit=NaN",
      "limit=",
      "cursor=",
    ]) {
      const response = await app.request(`/v1/files?${query}`, {
        headers: authorization(KEY_A),
      });
      expect(response.status).toBe(422);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: "invalid_input" },
      });
    }
  });

  it("accepts only canonical padded base64 upload content", async () => {
    const { app } = createHarness();
    const canonical = await stage(app, KEY_A);
    expect(canonical.status).toBe(201);
    for (const content of ["aGVsbG8", "_w=="]) {
      const response = await app.request("/v1/files", {
        method: "POST",
        headers: authorization(KEY_A),
        body: JSON.stringify({
          name: "invalid.bin",
          mimeType: "application/octet-stream",
          content,
        }),
      });
      expect(response.status).toBe(422);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: "invalid_input" },
      });
    }
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

    const pinnedUpload = await stage(app, KEY_PINNED);
    expect(pinnedUpload.status).toBe(201);
    const pinnedMetadata = (await pinnedUpload.json()) as { fileId: string };
    const pinnedSingle = await app.request(
      `/v1/files/${pinnedMetadata.fileId}`,
      { headers: authorization(KEY_PINNED) },
    );
    expect(pinnedSingle.status).toBe(200);
    const pinnedList = await app.request("/v1/files", {
      headers: authorization(KEY_PINNED),
    });
    expect(pinnedList.status).toBe(403);
    await expect(pinnedList.json()).resolves.toMatchObject({
      error: {
        code: "auth_insufficient_scope",
        message:
          "Project-scoped file listing requires an unpinned project API key.",
      },
    });
  });
});

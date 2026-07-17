import type {
  AdapterContext,
  CapabilitySlug,
  FetchImplementation,
  JsonValue,
  ResolvedCredential,
  ToolDefinition,
} from "@eyeball/core";
import { JSON_SCHEMA_DRAFT_2020_12, validateInput } from "@eyeball/core";
import nock from "nock";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  createMockApp,
  type ProviderMock,
} from "../../../mocks/packages/mock-kit/dist/index.js";
import { createGmailMock } from "../../../mocks/packages/mocks-email/dist/gmail.js";
import { createSlackMock } from "../../../mocks/packages/mocks-messaging/dist/slack.js";
import { createAirtableMock } from "../../../mocks/packages/mocks-productivity/dist/airtable.js";
import {
  type ActivepiecesAction,
  type ActivepiecesPiece,
  type ActivepiecesProperty,
  type ActivepiecesPropertyContext,
  ActivepiecesToolkitAdapter,
  actionToToolDefinition,
  executePieceAction,
  generateIntrospectionReport,
  getSpikePiece,
  normalizePieceOutput,
  type PieceExecutionBoundary,
  type PieceExecutionBoundaryContext,
  propertyToJsonSchema,
  propsToJsonSchema,
  resolveDynamicPropertySchema,
  rewritePieceUrl,
  spikePieces,
} from "../src/index.js";

const NODE_HTTP_METHODS = [
  "DELETE",
  "GET",
  "HEAD",
  "OPTIONS",
  "PATCH",
  "POST",
  "PUT",
] as const;

const PROPERTY_SCHEMA_CASES: readonly {
  readonly propertyType: ActivepiecesProperty["type"];
  readonly schemaType:
    | "array"
    | "boolean"
    | "number"
    | "object"
    | "string"
    | undefined;
  readonly expected?: Readonly<Record<string, unknown>>;
}[] = [
  { propertyType: "SHORT_TEXT", schemaType: "string" },
  { propertyType: "LONG_TEXT", schemaType: "string" },
  { propertyType: "MARKDOWN", schemaType: "string" },
  { propertyType: "SECRET_TEXT", schemaType: "string" },
  { propertyType: "COLOR", schemaType: "string" },
  { propertyType: "NUMBER", schemaType: "number" },
  { propertyType: "CHECKBOX", schemaType: "boolean" },
  {
    propertyType: "DATE_TIME",
    schemaType: "string",
    expected: { format: "date-time" },
  },
  {
    propertyType: "STATIC_DROPDOWN",
    schemaType: undefined,
    expected: { enum: ["first", "second"] },
  },
  {
    propertyType: "STATIC_MULTI_SELECT_DROPDOWN",
    schemaType: "array",
    expected: { items: { enum: ["first", "second"] } },
  },
  {
    propertyType: "DROPDOWN",
    schemaType: undefined,
    expected: {
      description:
        "Example property. Activepieces resolves this property for the selected connection after these inputs are known: workspace.",
    },
  },
  {
    propertyType: "MULTI_SELECT_DROPDOWN",
    schemaType: "array",
    expected: { items: {} },
  },
  {
    propertyType: "DYNAMIC",
    schemaType: "object",
    expected: { additionalProperties: true },
  },
  {
    propertyType: "ARRAY",
    schemaType: "array",
    expected: {
      items: {
        type: "object",
        properties: {
          value: { title: "Value", type: "string" },
        },
        required: ["value"],
        additionalProperties: false,
      },
    },
  },
  {
    propertyType: "OBJECT",
    schemaType: "object",
    expected: { additionalProperties: true },
  },
  {
    propertyType: "JSON",
    schemaType: "object",
    expected: { additionalProperties: true },
  },
  {
    propertyType: "FILE",
    schemaType: "object",
    expected: {
      required: ["filename", "base64"],
      additionalProperties: false,
    },
  },
  {
    propertyType: "BASIC_AUTH",
    schemaType: "object",
    expected: {
      required: ["username", "password"],
      additionalProperties: false,
    },
  },
  {
    propertyType: "CUSTOM_AUTH",
    schemaType: "object",
    expected: { additionalProperties: true },
  },
  {
    propertyType: "OAUTH2",
    schemaType: "object",
    expected: { additionalProperties: true },
  },
  {
    propertyType: "OIDC",
    schemaType: "object",
    expected: { additionalProperties: true },
  },
  { propertyType: "CUSTOM", schemaType: undefined },
] as const;

function bodyForForwarding(
  method: string,
  body: unknown,
  headers: Headers,
): BodyInit | undefined {
  if (method === "GET" || method === "HEAD" || body === undefined) {
    return undefined;
  }
  if (headers.get("content-type")?.includes("x-www-form-urlencoded")) {
    headers.set("content-type", "application/json");
    return JSON.stringify(
      typeof body === "string"
        ? Object.fromEntries(new URLSearchParams(body))
        : body,
    );
  }
  return typeof body === "string" ? body : JSON.stringify(body);
}

/** Test-only seam for SDKs that use node:http instead of global fetch. */
class NockPieceBoundary implements PieceExecutionBoundary {
  async run<T>(
    context: PieceExecutionBoundaryContext,
    operation: () => Promise<T>,
  ): Promise<T> {
    for (const route of context.routes) {
      const sourceOrigin = new URL(route.fromOrigin).origin;
      const scope = nock(sourceOrigin).persist();
      for (const method of NODE_HTTP_METHODS) {
        scope.intercept(/.*/u, method).reply(async function reply(path, body) {
          const headers = new Headers(this.req.headers);
          headers.delete("content-length");
          headers.delete("host");
          const forwardedBody = bodyForForwarding(method, body, headers);
          const response = await context.fetchImpl(
            rewritePieceUrl(`${sourceOrigin}${path}`, context.routes),
            {
              method,
              headers,
              ...(forwardedBody === undefined ? {} : { body: forwardedBody }),
            },
          );
          return [
            response.status,
            await response.text(),
            Object.fromEntries(response.headers.entries()),
          ] as const;
        });
      }
    }

    try {
      return await operation();
    } finally {
      nock.cleanAll();
    }
  }
}

function requirePiece(slug: string) {
  const entry = getSpikePiece(slug);
  if (entry === undefined) {
    throw new Error(`Missing spike piece: ${slug}`);
  }
  return entry.piece;
}

function requireAction(slug: string, actionName: string) {
  const action = requirePiece(slug).getAction(actionName);
  if (action === undefined) {
    throw new Error(`Missing spike action: ${slug}.${actionName}`);
  }
  return action;
}

function mockFetch(provider: ProviderMock): FetchImplementation {
  const app = createMockApp({ providers: [provider] });
  return (async (input, init) => {
    const request = new Request(input, init);
    return app.request(request);
  }) as FetchImplementation;
}

function airtableFetch(provider: ProviderMock): FetchImplementation {
  const providerFetch = mockFetch(provider);
  return (async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.pathname === "/airtable/v0/meta/bases/app_fixture_000001/tables") {
      expect(request.headers.get("authorization")).toBe(
        "Bearer fixture:airtable-token",
      );
      return Response.json({
        tables: [
          {
            id: "Tasks",
            name: "Tasks",
            fields: [
              { id: "Name", name: "Name", type: "singleLineText" },
              {
                id: "Status",
                name: "Status",
                type: "singleSelect",
                options: {
                  choices: [
                    { id: "todo", name: "Todo" },
                    { id: "done", name: "Done" },
                  ],
                },
              },
              { id: "Complete", name: "Complete", type: "checkbox" },
            ],
          },
        ],
      });
    }
    return providerFetch(request);
  }) as FetchImplementation;
}

function toolFor(
  toolkit: string,
  canonicalName: string,
  capability: CapabilitySlug,
  actionName: string,
): ToolDefinition {
  return actionToToolDefinition(requireAction(toolkit, actionName), {
    toolkit,
    canonicalName,
    capability,
    annotations: {
      readOnly: false,
      destructive: false,
      idempotent: false,
      async: false,
    },
  });
}

function adapterContext(options: {
  tool: ToolDefinition;
  input: Readonly<Record<string, JsonValue>>;
  credential: ResolvedCredential;
  baseUrl: string;
  fetchImpl: FetchImplementation;
}): AdapterContext {
  return {
    projectId: "proj_bridge_spike",
    userId: "user_bridge_spike",
    tool: options.tool,
    canonicalInput: options.input,
    credential: options.credential,
    baseUrl: options.baseUrl,
    fetchImpl: options.fetchImpl,
    clock: { now: () => new Date("2026-07-17T00:00:00.000Z") },
    logger: {
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    },
  };
}

beforeAll(() => {
  nock.disableNetConnect();
});

afterEach(() => {
  nock.cleanAll();
});

afterAll(() => {
  nock.enableNetConnect();
});

describe.sequential("Activepieces compatibility spike", () => {
  it("introspects all five pinned pieces deterministically", () => {
    const report = generateIntrospectionReport(spikePieces);

    expect(report.totals).toEqual({
      pieces: 5,
      actions: 67,
      triggers: 23,
      props: 351,
      dynamicProps: 13,
    });
    expect(report.pieces.map((piece) => piece.slug)).toEqual([
      "gmail",
      "airtable",
      "slack",
      "discord",
      "typeform",
    ]);
    expect(report.pieces.find((piece) => piece.slug === "gmail")?.auth).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "OAUTH2" }),
        expect.objectContaining({ type: "CUSTOM_AUTH" }),
      ]),
    );
  });

  it.each(
    PROPERTY_SCHEMA_CASES,
  )("maps $propertyType to its JSON Schema prototype", ({
    propertyType,
    schemaType,
    expected,
  }) => {
    const property: ActivepiecesProperty = {
      type: propertyType,
      displayName: "Example",
      description: "Example property.",
      required: false,
      refreshers: ["workspace"],
      options: {
        options: [
          { label: "First", value: "first" },
          { label: "Second", value: "second" },
        ],
      },
      properties: {
        value: {
          type: "SHORT_TEXT",
          displayName: "Value",
          required: true,
        },
      },
    };

    const schema = propertyToJsonSchema(property);

    expect(schema.type).toBe(schemaType);
    if (expected !== undefined) {
      expect(schema).toEqual(expect.objectContaining(expected));
    }
  });

  it("transforms real action props into a closed Draft 2020-12 schema", () => {
    const gmailAction = requireAction("gmail", "send_email");
    const inputSchema = propsToJsonSchema(gmailAction);
    const definition = actionToToolDefinition(gmailAction, {
      toolkit: "gmail",
      capability: "email",
      annotations: {
        readOnly: false,
        destructive: false,
        idempotent: false,
        async: false,
      },
    });

    expect(inputSchema.additionalProperties).toBe(false);
    expect(inputSchema.required).toEqual([
      "receiver",
      "subject",
      "body_type",
      "body",
      "draft",
    ]);
    expect(inputSchema.properties?.body_type).toEqual(
      expect.objectContaining({ enum: ["plain_text", "html"] }),
    );
    expect(definition).toEqual(
      expect.objectContaining({
        name: "gmail.send_email",
        toolkit: "gmail",
        capability: "email",
        inputSchema: expect.objectContaining({
          $schema: JSON_SCHEMA_DRAFT_2020_12,
          type: "object",
        }),
      }),
    );
    expect(
      validateInput(definition, {
        receiver: ["recipient@acme.example"],
        subject: "Bridge schema",
        body_type: "plain_text",
        body: "The generated schema compiles in strict mode.",
        draft: false,
      }),
    ).toEqual(expect.objectContaining({ ok: true }));
  });

  it("compiles every transformed action schema with the strict core profile", () => {
    const failures: string[] = [];
    let transformed = 0;

    for (const entry of spikePieces) {
      for (const action of Object.values(entry.piece.actions())) {
        transformed += 1;
        try {
          const definition = actionToToolDefinition(action, {
            toolkit: entry.slug,
            capability: "ai_media_utilities",
            annotations: {
              readOnly: false,
              destructive: false,
              idempotent: false,
              async: false,
            },
          });
          const result = validateInput(definition, {});
          if (
            !result.ok &&
            result.errors.some((issue) => issue.keyword === "schema_profile")
          ) {
            failures.push(`${entry.slug}.${action.name}`);
          }
        } catch (error) {
          failures.push(
            `${entry.slug}.${action.name}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
    }

    expect(transformed).toBe(67);
    expect(failures).toEqual([]);
  });

  it("rejects circular arrays at the JSON output boundary", () => {
    const output: unknown[] = [];
    output.push(output);

    expect(() => normalizePieceOutput(output)).toThrow(
      "Activepieces returned a circular value that cannot cross the JSON boundary.",
    );
  });

  it("fails closed for unsupported engine context APIs", async () => {
    let capturedContext: Readonly<Record<string, unknown>> | undefined;
    const action: ActivepiecesAction = {
      name: "capture_context",
      displayName: "Capture context",
      description: "Captures the experimental context for boundary assertions.",
      props: {},
      run: async (context) => {
        capturedContext = context;
        return null;
      },
    };
    const piece: ActivepiecesPiece = {
      displayName: "Context fixture",
      description: "No-auth fixture for unsupported context APIs.",
      actions: () => ({ capture_context: action }),
      triggers: () => ({}),
      getAction: (name) => (name === action.name ? action : undefined),
      getTrigger: () => undefined,
    };
    const fetchImpl = (async () => {
      throw new Error("The context fixture must not use the network.");
    }) as FetchImplementation;

    await executePieceAction({
      piece,
      action,
      credential: { type: "none" },
      propsValue: {},
      fetchImpl,
    });
    if (capturedContext === undefined) {
      throw new Error("The fixture action did not receive its context.");
    }

    const context = capturedContext;
    const operations: ReadonlyArray<readonly [string, () => unknown]> = [
      [
        "connections.get",
        () =>
          (context.connections as { get(key: string): Promise<unknown> }).get(
            "other-connection",
          ),
      ],
      [
        "files.write",
        () =>
          (context.files as { write(value: unknown): Promise<unknown> }).write({
            fileName: "fixture.txt",
          }),
      ],
      [
        "flows.list",
        () => (context.flows as { list(): Promise<unknown> }).list(),
      ],
      ["tags.add", () => (context.tags as { add(): Promise<unknown> }).add()],
      [
        "output.update",
        () =>
          (
            context.output as { update(value: unknown): Promise<unknown> }
          ).update({}),
      ],
      ["run.stop", () => (context.run as { stop(): unknown }).stop()],
      [
        "run.respond",
        () => (context.run as { respond(value: unknown): unknown }).respond({}),
      ],
      [
        "run.createWaitpoint",
        () =>
          (
            context.run as { createWaitpoint(): Promise<unknown> }
          ).createWaitpoint(),
      ],
      [
        "run.waitForWaitpoint",
        () =>
          (context.run as { waitForWaitpoint(): unknown }).waitForWaitpoint(),
      ],
      [
        "agent.tools",
        () => (context.agent as { tools(): Promise<unknown> }).tools(),
      ],
    ];

    for (const [name, operation] of operations) {
      await expect(Promise.resolve().then(operation)).rejects.toThrow(
        `Activepieces ${name} is not supported by the experimental bridge.`,
      );
    }
  });

  it("fails closed for unsupported dynamic-property context APIs", async () => {
    let capturedContext: ActivepiecesPropertyContext | undefined;
    const dynamicProperty = {
      type: "DYNAMIC",
      displayName: "Fields",
      required: true,
      props: async (
        _propsValue: Readonly<Record<string, unknown>>,
        context: ActivepiecesPropertyContext,
      ) => {
        capturedContext = context;
        return {};
      },
    } as const;
    const action: ActivepiecesAction = {
      name: "dynamic_context",
      displayName: "Dynamic context",
      description: "Captures the dynamic-property context for assertions.",
      props: { fields: dynamicProperty },
      run: async () => null,
    };
    const piece: ActivepiecesPiece = {
      displayName: "Dynamic context fixture",
      description: "No-auth fixture for unsupported property context APIs.",
      actions: () => ({ dynamic_context: action }),
      triggers: () => ({}),
      getAction: (name) => (name === action.name ? action : undefined),
      getTrigger: () => undefined,
    };

    await resolveDynamicPropertySchema({
      piece,
      actionName: action.name,
      propertyName: "fields",
      credential: { type: "none" },
      propsValue: {},
      fetchImpl: (async () => {
        throw new Error(
          "The dynamic context fixture must not use the network.",
        );
      }) as FetchImplementation,
    });
    if (capturedContext === undefined) {
      throw new Error("The fixture resolver did not receive its context.");
    }

    await expect(capturedContext.connections.get("other")).rejects.toThrow(
      "Activepieces connections.get is not supported by the experimental bridge.",
    );
    await expect(capturedContext.flows.list()).rejects.toThrow(
      "Activepieces flows.list is not supported by the experimental bridge.",
    );
  });

  it("hydrates Airtable's real dynamic fields at connection time", async () => {
    const provider = createAirtableMock();
    const schema = await resolveDynamicPropertySchema({
      piece: requirePiece("airtable"),
      actionName: "airtable_create_record",
      propertyName: "fields",
      credential: {
        type: "api_key",
        values: { personalAccessToken: "fixture:airtable-token" },
      },
      propsValue: { base: "app_fixture_000001", tableId: "Tasks" },
      fetchImpl: airtableFetch(provider),
      routes: [
        {
          fromOrigin: "https://api.airtable.com",
          toBaseUrl: "http://mocks.local/airtable",
        },
      ],
    });

    expect(schema).toEqual(
      expect.objectContaining({
        type: "object",
        additionalProperties: false,
        properties: {
          Name: expect.objectContaining({ type: "string", title: "Name" }),
          Status: expect.objectContaining({ enum: ["todo", "done"] }),
          Complete: expect.objectContaining({ type: "boolean" }),
        },
      }),
    );
  });

  it("executes Airtable through the fetch-based in-process mock", async () => {
    const provider = createAirtableMock();
    const adapter = new ActivepiecesToolkitAdapter({
      toolkitSlug: "airtable",
      piece: requirePiece("airtable"),
      actionMap: { create_row: "airtable_create_record" },
      sourceOrigins: ["https://api.airtable.com"],
    });
    const output = await adapter.execute(
      adapterContext({
        tool: toolFor(
          "airtable",
          "create_row",
          "spreadsheets_databases",
          "airtable_create_record",
        ),
        input: {
          base: "app_fixture_000001",
          tableId: "Tasks",
          fields: { Name: "Bridge spike", Status: "done" },
        },
        credential: {
          type: "api_key",
          values: { personalAccessToken: "fixture:airtable-token" },
        },
        baseUrl: "http://mocks.local/airtable",
        fetchImpl: airtableFetch(provider),
      }),
    );

    expect(output).toEqual(
      expect.objectContaining({
        id: expect.stringMatching(/^airtable_rec_/u),
        fields: { Name: "Bridge spike", Status: "done" },
      }),
    );
  });

  it("executes Gmail through a node:http boundary and the in-process mock", async () => {
    const provider = createGmailMock();
    const adapter = new ActivepiecesToolkitAdapter({
      toolkitSlug: "gmail",
      piece: requirePiece("gmail"),
      actionMap: { send_email: "send_email" },
      sourceOrigins: ["https://gmail.googleapis.com"],
      boundary: new NockPieceBoundary(),
    });
    const output = await adapter.execute(
      adapterContext({
        tool: toolFor("gmail", "send_email", "email", "send_email"),
        input: {
          receiver: ["recipient@acme.example"],
          subject: "Bridge spike",
          body_type: "plain_text",
          body: "Sent through the in-process Gmail mock.",
          from: "sender@acme.example",
          draft: false,
        },
        credential: {
          type: "oauth2",
          accessToken: "fixture:gmail-token",
          scopes: ["https://www.googleapis.com/auth/gmail.send"],
        },
        baseUrl: "http://mocks.local/gmail",
        fetchImpl: mockFetch(provider),
      }),
    );

    expect(output).toEqual(
      expect.objectContaining({
        id: expect.stringMatching(/^gmail_msg_/u),
        threadId: expect.stringMatching(/^gmail_thread_/u),
        labelIds: ["SENT"],
      }),
    );
  });

  it("executes Slack through a node:http boundary and the in-process mock", async () => {
    const provider = createSlackMock();
    const adapter = new ActivepiecesToolkitAdapter({
      toolkitSlug: "slack",
      piece: requirePiece("slack"),
      actionMap: { send_message: "send_channel_message" },
      sourceOrigins: ["https://slack.com"],
      boundary: new NockPieceBoundary(),
    });
    const output = await adapter.execute(
      adapterContext({
        tool: toolFor(
          "slack",
          "send_message",
          "messaging_chat",
          "send_channel_message",
        ),
        input: {
          channel: "C_GENERAL",
          text: "Sent through the bridge spike.",
          sendAsBot: true,
        },
        credential: {
          type: "oauth2",
          accessToken: "fixture:slack-token",
          scopes: ["chat:write"],
        },
        baseUrl: "http://mocks.local/slack",
        fetchImpl: mockFetch(provider),
      }),
    );

    expect(output).toEqual(
      expect.objectContaining({
        ok: true,
        channel: "C_GENERAL",
        message: expect.objectContaining({
          text: "Sent through the bridge spike.",
        }),
      }),
    );
  });
});

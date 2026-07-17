import { randomBytes, randomUUID } from "node:crypto";
import type {
  CreatedWebhookEndpoint,
  RotatedWebhookSecret,
  WebhookEndpoint,
  WebhookEndpointPage,
} from "@eyeball/core";
import { and, desc, eq, lt, or, type SQL } from "drizzle-orm";
import type { PgQueryResultHKT } from "drizzle-orm/pg-core";
import {
  type CreateWebhookEndpointInput,
  endpointCursorAfter,
  endpointIdFromCursor,
  type InMemoryWebhookEndpointStoreOptions,
  InvalidWebhookCursorError,
  type ListWebhookEndpointsInput,
  normalizedUrl,
  publicEndpoint,
  type StoredWebhookEndpoint,
  secretPrefix,
  type UpdateWebhookEndpointInput,
  validateEvents,
  validateListInput,
  validTimestamp,
  WebhookEndpointInputError,
  type WebhookEndpointStore,
} from "../../webhooks/endpoint-store.js";
import type { EyeballPostgresDatabase } from "./database.js";
import { webhookEndpoints } from "./schema.js";

export type PostgresWebhookEndpointStoreOptions =
  InMemoryWebhookEndpointStoreOptions;

function copy<T>(value: T): T {
  return structuredClone(value);
}

function generatedEndpointId(): string {
  return `whe_${randomUUID().replaceAll("-", "")}`;
}

function generatedSecret(): string {
  return `whsec_${randomBytes(32).toString("base64url")}`;
}

function endpointWhere(projectId: string, endpointId: string) {
  return and(
    eq(webhookEndpoints.projectId, projectId),
    eq(webhookEndpoints.endpointId, endpointId),
  );
}

function isoTimestamp(value: string): string {
  return new Date(value).toISOString();
}

function storedEndpoint(
  row: typeof webhookEndpoints.$inferSelect,
): StoredWebhookEndpoint {
  return {
    endpointId: row.endpointId,
    url: row.url,
    secret: row.secret,
    secretPrefix: row.secretPrefix,
    events: copy(row.events),
    active: row.active,
    createdAt: isoTimestamp(row.createdAt),
    updatedAt: isoTimestamp(row.updatedAt),
  };
}

export class PostgresWebhookEndpointStore<
  TQueryResult extends PgQueryResultHKT = PgQueryResultHKT,
> implements WebhookEndpointStore
{
  readonly #database: EyeballPostgresDatabase<TQueryResult>;
  readonly #endpointIdFactory: () => string;
  readonly #secretFactory: () => string;
  readonly #allowInsecureHttp: boolean;
  readonly #allowPrivateNetwork: boolean;

  constructor(
    database: EyeballPostgresDatabase<TQueryResult>,
    options: PostgresWebhookEndpointStoreOptions = {},
  ) {
    this.#database = database;
    this.#endpointIdFactory = options.endpointIdFactory ?? generatedEndpointId;
    this.#secretFactory = options.secretFactory ?? generatedSecret;
    this.#allowInsecureHttp = options.allowInsecureHttp ?? false;
    this.#allowPrivateNetwork = options.allowPrivateNetwork ?? false;
  }

  async create(
    projectId: string,
    input: CreateWebhookEndpointInput,
  ): Promise<CreatedWebhookEndpoint> {
    if (projectId.trim().length === 0) {
      throw new WebhookEndpointInputError(
        "Webhook project ID must not be empty.",
      );
    }
    validateEvents(input.events);
    validTimestamp(input.createdAt, "Webhook endpoint createdAt");
    const url = normalizedUrl(input.url, {
      allowInsecureHttp: this.#allowInsecureHttp,
      allowPrivateNetwork: this.#allowPrivateNetwork,
    });
    const endpointId = this.#endpointIdFactory();
    if (endpointId.trim().length === 0) {
      throw new Error("Webhook endpoint ID factory returned an empty value.");
    }
    const secret = this.#newSecret();
    const endpoint: StoredWebhookEndpoint = {
      endpointId,
      url,
      secret,
      secretPrefix: secretPrefix(secret),
      events: [...input.events],
      active: input.active,
      createdAt: input.createdAt,
      updatedAt: input.createdAt,
    };
    const inserted = await this.#database
      .insert(webhookEndpoints)
      .values({
        projectId,
        endpointId,
        url,
        secret,
        secretPrefix: endpoint.secretPrefix,
        events: endpoint.events,
        active: endpoint.active,
        createdAt: endpoint.createdAt,
        updatedAt: endpoint.updatedAt,
      })
      .onConflictDoNothing()
      .returning({ endpointId: webhookEndpoints.endpointId });
    if (inserted.length === 0) {
      throw new Error(`Duplicate webhook endpoint ID: ${endpointId}`);
    }
    return copy({ ...publicEndpoint(endpoint), secret });
  }

  async get(
    projectId: string,
    endpointId: string,
  ): Promise<WebhookEndpoint | undefined> {
    const endpoint = await this.getForDelivery(projectId, endpointId);
    return endpoint === undefined ? undefined : publicEndpoint(endpoint);
  }

  async getForDelivery(
    projectId: string,
    endpointId: string,
  ): Promise<StoredWebhookEndpoint | undefined> {
    const [row] = await this.#database
      .select()
      .from(webhookEndpoints)
      .where(endpointWhere(projectId, endpointId))
      .limit(1);
    return row === undefined ? undefined : storedEndpoint(row);
  }

  async list(
    projectId: string,
    input: ListWebhookEndpointsInput,
  ): Promise<WebhookEndpointPage> {
    validateListInput(input);
    const predicates: SQL[] = [eq(webhookEndpoints.projectId, projectId)];
    if (input.cursor !== undefined) {
      const after = endpointIdFromCursor(input.cursor);
      const [anchor] = await this.#database
        .select({
          createdAt: webhookEndpoints.createdAt,
          sequence: webhookEndpoints.sequence,
        })
        .from(webhookEndpoints)
        .where(and(...predicates, eq(webhookEndpoints.endpointId, after)))
        .limit(1);
      if (anchor === undefined) throw new InvalidWebhookCursorError();
      predicates.push(
        or(
          lt(webhookEndpoints.createdAt, anchor.createdAt),
          and(
            eq(webhookEndpoints.createdAt, anchor.createdAt),
            lt(webhookEndpoints.sequence, anchor.sequence),
          ),
        ) as SQL,
      );
    }
    const rows = await this.#database
      .select()
      .from(webhookEndpoints)
      .where(and(...predicates))
      .orderBy(
        desc(webhookEndpoints.createdAt),
        desc(webhookEndpoints.sequence),
      )
      .limit(input.limit + 1);
    const hasMore = rows.length > input.limit;
    const webhooks = rows
      .slice(0, input.limit)
      .map((row) => publicEndpoint(storedEndpoint(row)));
    const last = webhooks.at(-1);
    return {
      webhooks,
      ...(hasMore && last !== undefined
        ? { nextCursor: endpointCursorAfter(last.endpointId) }
        : {}),
    };
  }

  async listForDelivery(
    projectId: string,
  ): Promise<readonly StoredWebhookEndpoint[]> {
    const rows = await this.#database
      .select()
      .from(webhookEndpoints)
      .where(eq(webhookEndpoints.projectId, projectId))
      .orderBy(webhookEndpoints.sequence);
    return rows.map(storedEndpoint);
  }

  async update(
    projectId: string,
    endpointId: string,
    input: UpdateWebhookEndpointInput,
  ): Promise<WebhookEndpoint | undefined> {
    return this.#database.transaction(async (transaction) => {
      const [row] = await transaction
        .select()
        .from(webhookEndpoints)
        .where(endpointWhere(projectId, endpointId))
        .for("update")
        .limit(1);
      if (row === undefined) return undefined;
      if (
        input.url === undefined &&
        input.events === undefined &&
        input.active === undefined
      ) {
        throw new WebhookEndpointInputError(
          "Webhook update must change url, events, or active.",
        );
      }
      validTimestamp(input.updatedAt, "Webhook endpoint updatedAt");
      if (input.events !== undefined) validateEvents(input.events);
      const endpoint = storedEndpoint(row);
      const updated: StoredWebhookEndpoint = {
        ...endpoint,
        ...(input.url === undefined
          ? {}
          : {
              url: normalizedUrl(input.url, {
                allowInsecureHttp: this.#allowInsecureHttp,
                allowPrivateNetwork: this.#allowPrivateNetwork,
              }),
            }),
        ...(input.events === undefined ? {} : { events: [...input.events] }),
        ...(input.active === undefined ? {} : { active: input.active }),
        updatedAt: input.updatedAt,
      };
      await transaction
        .update(webhookEndpoints)
        .set({
          url: updated.url,
          events: updated.events,
          active: updated.active,
          updatedAt: updated.updatedAt,
        })
        .where(endpointWhere(projectId, endpointId));
      return publicEndpoint(copy(updated));
    });
  }

  async rotateSecret(
    projectId: string,
    endpointId: string,
    rotatedAt: string,
  ): Promise<RotatedWebhookSecret | undefined> {
    return this.#database.transaction(async (transaction) => {
      const [existing] = await transaction
        .select({ endpointId: webhookEndpoints.endpointId })
        .from(webhookEndpoints)
        .where(endpointWhere(projectId, endpointId))
        .for("update")
        .limit(1);
      if (existing === undefined) return undefined;
      validTimestamp(rotatedAt, "Webhook secret rotatedAt");
      const secret = this.#newSecret();
      const prefix = secretPrefix(secret);
      await transaction
        .update(webhookEndpoints)
        .set({ secret, secretPrefix: prefix, updatedAt: rotatedAt })
        .where(endpointWhere(projectId, endpointId));
      return { endpointId, secretPrefix: prefix, secret, rotatedAt };
    });
  }

  async delete(projectId: string, endpointId: string): Promise<boolean> {
    const deleted = await this.#database
      .delete(webhookEndpoints)
      .where(endpointWhere(projectId, endpointId))
      .returning({ endpointId: webhookEndpoints.endpointId });
    return deleted.length > 0;
  }

  #newSecret(): string {
    const secret = this.#secretFactory();
    if (secret.trim().length === 0) {
      throw new Error("Webhook secret factory returned an empty value.");
    }
    return secret;
  }
}

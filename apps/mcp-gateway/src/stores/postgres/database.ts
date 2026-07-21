import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import type { McpGatewayPostgresSchema } from "./schema.js";

export type McpGatewayPostgresDatabase<
  TQueryResult extends PgQueryResultHKT = PgQueryResultHKT,
> = PgDatabase<TQueryResult, McpGatewayPostgresSchema>;

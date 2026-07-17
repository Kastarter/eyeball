import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import type { PostgresSchema } from "./schema.js";

export type EyeballPostgresDatabase<
  TQueryResult extends PgQueryResultHKT = PgQueryResultHKT,
> = PgDatabase<TQueryResult, PostgresSchema>;

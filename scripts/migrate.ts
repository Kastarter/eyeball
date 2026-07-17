import { createPgStoreBundle } from "../apps/executor/src/stores/postgres/factory.js";

const connectionString = process.env.EYEBALL_DATABASE_URL?.trim();
if (connectionString === undefined || connectionString.length === 0) {
  throw new Error("EYEBALL_DATABASE_URL is required to run migrations.");
}

const bundle = await createPgStoreBundle({ connectionString });
await bundle.close();
console.log("Eyeball Postgres migrations are current.");

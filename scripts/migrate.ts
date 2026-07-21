import { createPgStoreBundle } from "../apps/executor/src/stores/postgres/factory.js";
import { createPgMcpGatewayStoreBundle } from "../apps/mcp-gateway/src/stores/postgres/factory.js";

const connectionString = process.env.EYEBALL_DATABASE_URL?.trim();
if (connectionString === undefined || connectionString.length === 0) {
  throw new Error("EYEBALL_DATABASE_URL is required to run migrations.");
}

let executorBundle: Awaited<ReturnType<typeof createPgStoreBundle>> | undefined;
try {
  executorBundle = await createPgStoreBundle({ connectionString });
} finally {
  await executorBundle?.close();
}

let gatewayBundle:
  | Awaited<ReturnType<typeof createPgMcpGatewayStoreBundle>>
  | undefined;
try {
  gatewayBundle = await createPgMcpGatewayStoreBundle({ connectionString });
} finally {
  await gatewayBundle?.close();
}

console.log("Eyeball executor and MCP gateway migrations are current.");

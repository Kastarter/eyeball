import { serve } from "@hono/node-server";
import { app } from "./index.js";

const port = Number(process.env.PORT ?? 3000);

serve({ fetch: app.fetch, port }, ({ port: listeningPort }) => {
  console.log(`mcp-gateway listening on http://localhost:${listeningPort}`);
});

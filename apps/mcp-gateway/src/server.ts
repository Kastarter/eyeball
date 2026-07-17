import { serve } from "@hono/node-server";
import { app } from "./index.js";

const port = Number(process.env.PORT ?? 3001);
const hostname = process.env.HOST ?? "127.0.0.1";

serve({ fetch: app.fetch, hostname, port }, ({ port: listeningPort }) => {
  console.log(`mcp-gateway listening on http://${hostname}:${listeningPort}`);
});

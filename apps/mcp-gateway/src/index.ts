import { Hono } from "hono";

export const app = new Hono();

app.get("/health", (context) =>
  context.json({ status: "ok", service: "mcp-gateway" }),
);

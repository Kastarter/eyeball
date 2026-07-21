import { serve } from "@hono/node-server";
import { createMcpGatewayRuntime } from "./index.js";

const port = Number(process.env.PORT ?? 3001);
const hostname = process.env.HOST ?? "127.0.0.1";

async function start(): Promise<void> {
  const runtime = await createMcpGatewayRuntime({ env: process.env });
  let server: ReturnType<typeof serve>;
  try {
    server = serve(
      { fetch: runtime.app.fetch, hostname, port },
      ({ port: listeningPort }) => {
        console.log(
          `mcp-gateway listening on http://${hostname}:${listeningPort}`,
        );
      },
    );
  } catch (error) {
    await runtime.close();
    throw error;
  }

  let closing = false;
  const close = (signal: NodeJS.Signals): void => {
    if (closing) return;
    closing = true;
    server.close((serverError) => {
      void runtime
        .close()
        .then(() => {
          if (serverError !== undefined) throw serverError;
          console.log(`mcp-gateway stopped after ${signal}`);
        })
        .catch(() => {
          console.error("mcp-gateway shutdown failed.");
          process.exitCode = 1;
        });
    });
    runtime.dispose();
  };

  process.once("SIGINT", close);
  process.once("SIGTERM", close);
}

await start().catch(() => {
  console.error("mcp-gateway startup failed.");
  process.exitCode = 1;
});

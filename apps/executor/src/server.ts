import { serve } from "@hono/node-server";
import {
  app,
  engine,
  executorRuntime,
  triggerPollingScheduler,
} from "./index.js";

const port = Number(process.env.PORT ?? 3000);

triggerPollingScheduler.start();
const server = serve({ fetch: app.fetch, port }, ({ port: listeningPort }) => {
  engine.telemetry.logger.info("executor.ready", { port: listeningPort });
});

let closing = false;
const close = (signal: NodeJS.Signals): void => {
  if (closing) return;
  closing = true;
  triggerPollingScheduler.stop();
  engine.telemetry.logger.info("executor.shutdown_started", { signal });
  server.close((serverError) => {
    void executorRuntime
      .close()
      .then(() => {
        if (serverError !== undefined) throw serverError;
        engine.telemetry.logger.info("executor.shutdown_completed", { signal });
      })
      .catch((error: unknown) => {
        engine.telemetry.logger.error("executor.shutdown_failed", {
          signal,
          error,
        });
        process.exitCode = 1;
      });
  });
};

process.once("SIGINT", close);
process.once("SIGTERM", close);

import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import type { Hono } from "hono";
import type { ClockAdvanceResult } from "./clock.js";
import { type CreateMockAppOptions, createMockApp } from "./composition.js";
import type { ProviderMock } from "./provider.js";

export type SeedInput =
  | { bundle: string }
  | { providers: Record<string, unknown> };

export interface StartMockServerOptions {
  providers: readonly ProviderMock[];
  host?: "127.0.0.1";
  port?: number;
  bundles?: CreateMockAppOptions["bundles"];
}

export interface MockServer {
  readonly app: Hono;
  readonly baseUrls: Readonly<Record<string, string>>;
  readonly port: number;
  reset(options?: { providers?: readonly string[] }): Promise<void>;
  seed(input: SeedInput): Promise<void>;
  advanceClock(milliseconds: number): Promise<ClockAdvanceResult>;
  stop(): Promise<void>;
  close(): Promise<void>;
}

function assertPort(port: number): void {
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error("Mock server port must be an integer from 0 through 65535");
  }
}

export async function startMockServer(
  options: StartMockServerOptions,
): Promise<MockServer> {
  const host = options.host ?? "127.0.0.1";
  const requestedPort = options.port ?? 0;
  assertPort(requestedPort);

  const app = createMockApp({
    providers: options.providers,
    ...(options.bundles === undefined ? {} : { bundles: options.bundles }),
  });
  const server = serve({
    fetch: app.fetch,
    hostname: host,
    port: requestedPort,
  });

  await new Promise<void>((resolve, reject) => {
    if (server.listening) {
      resolve();
      return;
    }
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
  });

  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("Mock server did not expose a TCP address");
  }
  const port = (address as AddressInfo).port;
  const origin = `http://${host}:${port}`;
  const baseUrls = Object.freeze(
    Object.fromEntries(
      options.providers.map((provider) => [
        provider.slug,
        `${origin}/${provider.slug}`,
      ]),
    ),
  );

  async function requestControl<T>(path: string, body: unknown): Promise<T> {
    const response = await fetch(`${origin}/_mock/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(
        `Mock control request failed (${response.status}): ${text || response.statusText}`,
      );
    }
    return JSON.parse(text) as T;
  }

  let stopped = false;
  async function stop(): Promise<void> {
    if (stopped) {
      return;
    }
    stopped = true;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error === undefined) {
          resolve();
        } else {
          reject(error);
        }
      });
    });
  }

  return {
    app,
    baseUrls,
    port,
    async reset(resetOptions = {}) {
      await requestControl("reset", resetOptions);
    },
    async seed(input) {
      await requestControl("seed", input);
    },
    async advanceClock(milliseconds) {
      return requestControl<ClockAdvanceResult>("clock/advance", {
        milliseconds,
      });
    },
    stop,
    close: stop,
  };
}

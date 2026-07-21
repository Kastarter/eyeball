import { describe, expect, it } from "vitest";
import { executorKeyCookieName, executorKeySetCookie } from "./executor-key";
import {
  handleExecutorKeyGet,
  handleExecutorKeyPost,
} from "./executor-key-route";
import {
  EXECUTOR_KEY_SETTINGS_HEADER,
  EXECUTOR_PROJECT_HEADER,
} from "./executor-key-shared";
import {
  configuredServerExecutorUrl,
  proxyExecutorRequest,
} from "./executor-proxy";

const cloudEnvironment = {
  EYEBALL_API_KEY: "server-env-key-must-not-win-in-cloud-mode",
  EYEBALL_EXECUTOR_URL: "https://executor.example.test",
  NEXT_PUBLIC_EYEBALL_MODE: "cloud",
};

describe("dashboard executor key settings", () => {
  it("stores a project key in a Secure HttpOnly session cookie without echoing it", async () => {
    const key = "eyb_live_project_secret_fixture";
    const request = new Request(
      "https://dashboard.example.test/api/dashboard/executor-key",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://dashboard.example.test",
          [EXECUTOR_KEY_SETTINGS_HEADER]: "1",
        },
        body: JSON.stringify({ projectId: "proj_fixture", key }),
      },
    );
    const response = await handleExecutorKeyPost(request, cloudEnvironment);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      configured: true,
      projectId: "proj_fixture",
    });
    const setCookie = response.headers.get("Set-Cookie") ?? "";
    expect(setCookie).toContain(executorKeyCookieName("proj_fixture"));
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Strict");
    expect(setCookie).toContain("Secure");
  });

  it("rejects missing anti-CSRF intent and cross-origin settings requests", async () => {
    const missingHeader = await handleExecutorKeyPost(
      new Request("https://dashboard.example.test/api/dashboard/executor-key", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId: "proj_fixture",
          key: "eyb_live_fixture",
        }),
      }),
      cloudEnvironment,
    );
    expect(missingHeader.status).toBe(403);

    const crossOrigin = await handleExecutorKeyPost(
      new Request("https://dashboard.example.test/api/dashboard/executor-key", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://attacker.example.test",
          [EXECUTOR_KEY_SETTINGS_HEADER]: "1",
        },
        body: JSON.stringify({
          projectId: "proj_fixture",
          key: "eyb_live_fixture",
        }),
      }),
      cloudEnvironment,
    );
    expect(crossOrigin.status).toBe(403);
  });

  it("reports only whether a project key is configured", async () => {
    const cookie =
      executorKeySetCookie({
        key: "eyb_live_fixture_secret",
        projectId: "proj_fixture",
        secure: true,
      }).split(";", 1)[0] ?? "";
    const response = await handleExecutorKeyGet(
      new Request(
        "https://dashboard.example.test/api/dashboard/executor-key?projectId=proj_fixture",
        {
          headers: {
            Cookie: cookie,
            [EXECUTOR_KEY_SETTINGS_HEADER]: "1",
          },
        },
      ),
      cloudEnvironment,
    );
    const serialized = JSON.stringify(await response.json());
    expect(serialized).toContain('"configured":true');
    expect(serialized).not.toContain("eyb_live_fixture_secret");
  });
});

describe("executor proxy cloud credential selection", () => {
  it("requires HTTPS except for an explicit loopback executor", () => {
    expect(
      configuredServerExecutorUrl({
        EYEBALL_EXECUTOR_URL: "http://executor.example.test",
      }),
    ).toBeUndefined();
    expect(
      configuredServerExecutorUrl({
        EYEBALL_EXECUTOR_URL: "http://localhost:8787/",
      }),
    ).toBe("http://localhost:8787");
    expect(
      configuredServerExecutorUrl({
        EYEBALL_EXECUTOR_URL: "https://user:secret@executor.example.test",
      }),
    ).toBeUndefined();
  });

  it("does not expose non-public executor routes", async () => {
    let called = false;
    const response = await proxyExecutorRequest(
      new Request(
        "https://dashboard.example.test/api/executor/internal/health",
      ),
      { params: Promise.resolve({ path: ["internal", "health"] }) },
      cloudEnvironment,
      async () => {
        called = true;
        return Response.json({ ok: true });
      },
    );
    expect(response.status).toBe(400);
    expect(called).toBe(false);
  });

  it("uses only the route-selected project cookie in cloud mode", async () => {
    const projectKey = "eyb_live_selected_project_key";
    const cookie =
      executorKeySetCookie({
        key: projectKey,
        projectId: "proj_selected",
        secure: true,
      }).split(";", 1)[0] ?? "";
    let observedHeaders = new Headers();
    const fetchImpl: typeof globalThis.fetch = async (_input, init) => {
      observedHeaders = new Headers(init?.headers);
      return Response.json({ executions: [] });
    };
    const response = await proxyExecutorRequest(
      new Request("https://dashboard.example.test/api/executor/v1/executions", {
        headers: {
          Cookie: cookie,
          [EXECUTOR_PROJECT_HEADER]: "proj_selected",
        },
      }),
      { params: Promise.resolve({ path: ["v1", "executions"] }) },
      cloudEnvironment,
      fetchImpl,
    );

    expect(response.status).toBe(200);
    expect(observedHeaders.get("Authorization")).toBe(`Bearer ${projectKey}`);
    expect(observedHeaders.get(EXECUTOR_PROJECT_HEADER)).toBeNull();
    expect(observedHeaders.get("Cookie")).toBeNull();
    expect(JSON.stringify([...observedHeaders.entries()])).not.toContain(
      cloudEnvironment.EYEBALL_API_KEY,
    );
    expect(await response.json()).toEqual({ executions: [] });
  });

  it.each([
    { status: 200, remaining: "47", retryAfter: "9" },
    { status: 429, remaining: "0", retryAfter: "31" },
  ])("forwards only the explicit executor response allowlist for HTTP $status", async ({
    status,
    remaining,
    retryAfter,
  }) => {
    const fetchImpl: typeof globalThis.fetch = async () =>
      new Response(JSON.stringify({ status }), {
        status,
        headers: {
          "content-TYPE": "application/problem+json",
          "ratelimit-LIMIT": "60",
          "RateLimit-remaining": remaining,
          "RATELIMIT-RESET": "2026-07-21T18:00:00.000Z",
          "retry-AFTER": retryAfter,
          Location: "https://attacker.example.test/collect",
          "Set-Cookie": "session=private; Secure",
          Authorization: "Bearer private-response-token",
          "RateLimit-Provider-Bucket": "private-provider-bucket",
          "X-Internal-Trace": "private-trace",
          "X-Provider-Request-Id": "private-provider-request",
        },
      });
    const response = await proxyExecutorRequest(
      new Request("https://dashboard.example.test/api/executor/v1/executions"),
      { params: Promise.resolve({ path: ["v1", "executions"] }) },
      {
        EYEBALL_API_KEY: "demo-key",
        EYEBALL_EXECUTOR_URL: "https://executor.example.test",
      },
      fetchImpl,
    );

    expect(response.status).toBe(status);
    expect(response.headers.get("Content-Type")).toBe(
      "application/problem+json",
    );
    expect(response.headers.get("RateLimit-Limit")).toBe("60");
    expect(response.headers.get("RateLimit-Remaining")).toBe(remaining);
    expect(response.headers.get("RateLimit-Reset")).toBe(
      "2026-07-21T18:00:00.000Z",
    );
    expect(response.headers.get("Retry-After")).toBe(retryAfter);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    for (const forbidden of [
      "Location",
      "Set-Cookie",
      "Authorization",
      "RateLimit-Provider-Bucket",
      "X-Internal-Trace",
      "X-Provider-Request-Id",
    ]) {
      expect(response.headers.get(forbidden)).toBeNull();
    }
  });

  it("exports only endpoint-update PATCH requests with the selected cloud key", async () => {
    const projectKey = "eyb_live_webhook_project_key";
    const cookie =
      executorKeySetCookie({
        key: projectKey,
        projectId: "proj_selected",
        secure: true,
      }).split(";", 1)[0] ?? "";
    let upstreamUrl = "";
    let upstreamMethod = "";
    let upstreamHeaders = new Headers();
    let upstreamBody = "";
    const fetchImpl: typeof globalThis.fetch = async (input, init) => {
      upstreamUrl = String(input);
      upstreamMethod = init?.method ?? "GET";
      upstreamHeaders = new Headers(init?.headers);
      upstreamBody = await new Response(init?.body).text();
      return Response.json({ endpointId: "whe_fixture", active: false });
    };
    const response = await proxyExecutorRequest(
      new Request(
        "https://dashboard.example.test/api/executor/v1/webhooks/whe_fixture",
        {
          method: "PATCH",
          headers: {
            Cookie: cookie,
            "Content-Type": "application/json",
            [EXECUTOR_PROJECT_HEADER]: "proj_selected",
          },
          body: JSON.stringify({ active: false }),
        },
      ),
      {
        params: Promise.resolve({
          path: ["v1", "webhooks", "whe_fixture"],
        }),
      },
      cloudEnvironment,
      fetchImpl,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(upstreamMethod).toBe("PATCH");
    expect(upstreamUrl).toBe(
      "https://executor.example.test/v1/webhooks/whe_fixture",
    );
    expect(upstreamHeaders.get("Content-Type")).toBe("application/json");
    expect(upstreamHeaders.get("Authorization")).toBe(`Bearer ${projectKey}`);
    expect(upstreamHeaders.get("Cookie")).toBeNull();
    expect(upstreamHeaders.get(EXECUTOR_PROJECT_HEADER)).toBeNull();
    expect(upstreamBody).toBe(JSON.stringify({ active: false }));
  });

  it("rejects every PATCH shape except one webhook endpoint update", async () => {
    const rejectedPaths = [
      ["v1", "connections", "conn_fixture"],
      ["v1", "webhooks", "whe_fixture", "rotate-secret"],
      ["v1", "webhooks", "whe_fixture", "deliveries"],
      ["v1", "webhooks"],
    ] as const;

    for (const path of rejectedPaths) {
      let called = false;
      const response = await proxyExecutorRequest(
        new Request(
          `https://dashboard.example.test/api/executor/${path.join("/")}`,
          {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ active: false }),
          },
        ),
        { params: Promise.resolve({ path: [...path] }) },
        cloudEnvironment,
        async () => {
          called = true;
          return Response.json({ ok: true });
        },
      );

      expect(response.status).toBe(404);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      await expect(response.json()).resolves.toMatchObject({
        error: { code: "executor_route_not_allowed" },
      });
      expect(called).toBe(false);
    }
  });

  it("does not follow executor redirects with the selected bearer token", async () => {
    const projectKey = "eyb_live_redirect_fixture";
    const cookie =
      executorKeySetCookie({
        key: projectKey,
        projectId: "proj_selected",
        secure: true,
      }).split(";", 1)[0] ?? "";
    let redirect: RequestRedirect | undefined;
    const fetchImpl: typeof globalThis.fetch = async (_input, init) => {
      redirect = init?.redirect;
      return new Response(null, {
        status: 302,
        headers: { Location: "https://attacker.example.test/collect" },
      });
    };
    const response = await proxyExecutorRequest(
      new Request("https://dashboard.example.test/api/executor/v1/executions", {
        headers: {
          Cookie: cookie,
          [EXECUTOR_PROJECT_HEADER]: "proj_selected",
        },
      }),
      { params: Promise.resolve({ path: ["v1", "executions"] }) },
      cloudEnvironment,
      fetchImpl,
    );
    expect(redirect).toBe("manual");
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBeNull();
  });

  it("keeps the existing server environment key behavior in demo mode", async () => {
    let authorization: string | null = null;
    const fetchImpl: typeof globalThis.fetch = async (_input, init) => {
      authorization = new Headers(init?.headers).get("Authorization");
      return Response.json({ status: "ok", service: "executor" });
    };
    await proxyExecutorRequest(
      new Request("https://dashboard.example.test/api/executor/health"),
      { params: Promise.resolve({ path: ["health"] }) },
      {
        EYEBALL_API_KEY: "existing-demo-server-key",
        EYEBALL_EXECUTOR_URL: "https://executor.example.test",
      },
      fetchImpl,
    );
    expect(authorization).toBe("Bearer existing-demo-server-key");
  });
});

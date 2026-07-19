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
import { proxyExecutorRequest } from "./executor-proxy";

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
    expect(JSON.stringify([...observedHeaders.entries()])).not.toContain(
      cloudEnvironment.EYEBALL_API_KEY,
    );
    expect(await response.json()).toEqual({ executions: [] });
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

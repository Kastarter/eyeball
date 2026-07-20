import { describe, expect, it } from "vitest";
import { CLOUD_CSRF_HEADER } from "./cloud-api";
import { configuredCloudControlUrl, proxyCloudRequest } from "./cloud-proxy";

const environment = {
  EYEBALL_CLOUD_URL: "https://control.example.test/control/",
  EYEBALL_INTERNAL_API_SECRET: "internal-secret-never-forward",
  NEXT_PUBLIC_EYEBALL_MODE: "cloud",
};

describe("dashboard cloud proxy", () => {
  it("requires explicit cloud mode and an HTTPS or loopback control-plane URL", () => {
    expect(
      configuredCloudControlUrl({
        EYEBALL_CLOUD_URL: "https://control.example.test/",
      }),
    ).toBeUndefined();
    expect(configuredCloudControlUrl(environment)).toBe(
      "https://control.example.test/control",
    );
    expect(
      configuredCloudControlUrl({
        EYEBALL_CLOUD_URL:
          "https://control.example.test/control/?secret=hidden#fragment",
        NEXT_PUBLIC_EYEBALL_MODE: "cloud",
      }),
    ).toBeUndefined();
    expect(
      configuredCloudControlUrl({
        EYEBALL_CLOUD_URL: "https://user:password@control.example.test",
        NEXT_PUBLIC_EYEBALL_MODE: "cloud",
      }),
    ).toBeUndefined();
    expect(
      configuredCloudControlUrl({
        EYEBALL_CLOUD_URL: "file:///private/control.sock",
        NEXT_PUBLIC_EYEBALL_MODE: "cloud",
      }),
    ).toBeUndefined();
    expect(
      configuredCloudControlUrl({
        EYEBALL_CLOUD_URL: "http://control.example.test",
        NEXT_PUBLIC_EYEBALL_MODE: "cloud",
      }),
    ).toBeUndefined();
    expect(
      configuredCloudControlUrl({
        EYEBALL_CLOUD_URL: "http://127.0.0.1:8790/",
        NEXT_PUBLIC_EYEBALL_MODE: "cloud",
      }),
    ).toBe("http://127.0.0.1:8790");
  });

  it("forwards only cloud session cookies, content type, and the CSRF header", async () => {
    let observedUrl = "";
    let observedInit: RequestInit | undefined;
    const fetchImpl: typeof globalThis.fetch = async (input, init) => {
      observedUrl = String(input);
      observedInit = init;
      const headers = new Headers({ "Content-Type": "application/json" });
      headers.append(
        "Set-Cookie",
        "eyeball_cloud_session=fresh; Path=/; HttpOnly; SameSite=Lax",
      );
      headers.append(
        "Set-Cookie",
        "eyeball_executor_key_deadbeef=attacker; Path=/; HttpOnly",
      );
      return new Response(JSON.stringify({ ok: true }), {
        status: 201,
        headers,
      });
    };
    const request = new Request(
      "https://dashboard.example.test/api/cloud/v1/orgs?limit=10",
      {
        method: "POST",
        headers: {
          Authorization: "Bearer browser-supplied-secret",
          "Content-Type": "application/json",
          Cookie:
            "eyeball_cloud_session=session; eyeball_cloud_csrf=csrf; eyeball_executor_key_deadbeef=executor-secret; unrelated=value",
          [CLOUD_CSRF_HEADER]: "csrf",
          "X-Eyeball-Internal-Secret": "browser-internal-secret",
        },
        body: JSON.stringify({ name: "Acme" }),
      },
    );
    const response = await proxyCloudRequest(
      request,
      { params: Promise.resolve({ path: ["v1", "orgs"] }) },
      environment,
      fetchImpl,
    );

    expect(observedUrl).toBe(
      "https://control.example.test/control/v1/orgs?limit=10",
    );
    const headers = new Headers(observedInit?.headers);
    expect(headers.get("Cookie")).toBe(
      "eyeball_cloud_session=session; eyeball_cloud_csrf=csrf",
    );
    expect(headers.get(CLOUD_CSRF_HEADER)).toBe("csrf");
    expect(headers.get("Content-Type")).toBe("application/json");
    expect(headers.get("Authorization")).toBeNull();
    expect(headers.get("X-Eyeball-Internal-Secret")).toBeNull();
    expect(JSON.stringify([...headers.entries()])).not.toContain(
      environment.EYEBALL_INTERNAL_API_SECRET,
    );
    expect(observedInit?.redirect).toBe("manual");
    expect(response.status).toBe(201);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Set-Cookie")).toContain(
      "eyeball_cloud_session=fresh",
    );
    expect(response.headers.get("Set-Cookie")).not.toContain(
      "eyeball_executor_key_deadbeef",
    );
    expect(await response.json()).toEqual({ ok: true });
    expect(JSON.stringify([...response.headers.entries()])).not.toContain(
      "control.example.test",
    );
  });

  it("rejects non-public and traversal paths without contacting the control plane", async () => {
    let calls = 0;
    const fetchImpl: typeof globalThis.fetch = async () => {
      calls += 1;
      return new Response();
    };
    const response = await proxyCloudRequest(
      new Request("https://dashboard.example.test/api/cloud/internal"),
      { params: Promise.resolve({ path: ["internal", "health"] }) },
      environment,
      fetchImpl,
    );
    expect(response.status).toBe(400);
    expect(calls).toBe(0);
  });

  it("forwards member PATCH mutations through the explicit allowlist", async () => {
    let observedInit: RequestInit | undefined;
    const fetchImpl: typeof globalThis.fetch = async (_input, init) => {
      observedInit = init;
      return Response.json({ membership: { role: "admin" } });
    };
    const response = await proxyCloudRequest(
      new Request(
        "https://dashboard.example.test/api/cloud/v1/orgs/org_fixture/members/usr_member",
        {
          body: JSON.stringify({ role: "admin" }),
          headers: {
            "Content-Type": "application/json",
            [CLOUD_CSRF_HEADER]: "csrf",
          },
          method: "PATCH",
        },
      ),
      {
        params: Promise.resolve({
          path: ["v1", "orgs", "org_fixture", "members", "usr_member"],
        }),
      },
      environment,
      fetchImpl,
    );

    expect(observedInit?.method).toBe("PATCH");
    expect(
      JSON.parse(new TextDecoder().decode(observedInit?.body as ArrayBuffer)),
    ).toEqual({ role: "admin" });
    expect(response.status).toBe(200);
  });

  it("blocks unrelated versioned routes without contacting the control plane", async () => {
    let calls = 0;
    const fetchImpl: typeof globalThis.fetch = async () => {
      calls += 1;
      return new Response();
    };
    const response = await proxyCloudRequest(
      new Request(
        "https://dashboard.example.test/api/cloud/v1/orgs/org_fixture/tools/export",
      ),
      {
        params: Promise.resolve({
          path: ["v1", "orgs", "org_fixture", "tools", "export"],
        }),
      },
      environment,
      fetchImpl,
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({
      error: { code: "cloud_route_not_allowed" },
    });
    expect(calls).toBe(0);
  });
});

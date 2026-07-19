import { describe, expect, it } from "vitest";
import {
  DASHBOARD_CONTEXT_HEADER,
  DASHBOARD_ORGANIZATION_COOKIE,
  DASHBOARD_PROJECT_COOKIE,
  persistDashboardCloudContext,
} from "./cloud-api";
import { handleDashboardContextPost } from "./dashboard-context-route";

const cloudEnvironment = { NEXT_PUBLIC_EYEBALL_MODE: "cloud" };

describe("dashboard cloud context persistence", () => {
  it("stores validated organization and project selections in HttpOnly cookies", async () => {
    const response = await handleDashboardContextPost(
      new Request("https://dashboard.example.test/api/dashboard/context", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://dashboard.example.test",
          [DASHBOARD_CONTEXT_HEADER]: "1",
        },
        body: JSON.stringify({
          organizationId: "org_fixture",
          projectId: "proj_fixture",
        }),
      }),
      cloudEnvironment,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ persisted: true });
    const cookies = response.headers.get("Set-Cookie") ?? "";
    expect(cookies).toContain(`${DASHBOARD_ORGANIZATION_COOKIE}=org_fixture`);
    expect(cookies).toContain(`${DASHBOARD_PROJECT_COOKIE}=proj_fixture`);
    expect(cookies.match(/HttpOnly/gu)).toHaveLength(2);
    expect(cookies).toContain("SameSite=Lax");
    expect(cookies).toContain("Secure");
  });

  it("rejects cross-origin, unmarked, malformed, and demo-mode writes", async () => {
    const request = (headers: HeadersInit, organizationId = "org_fixture") =>
      new Request("https://dashboard.example.test/api/dashboard/context", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify({ organizationId }),
      });

    expect(
      (
        await handleDashboardContextPost(
          request({ Origin: "https://attacker.example.test" }),
          cloudEnvironment,
        )
      ).status,
    ).toBe(403);
    expect(
      (await handleDashboardContextPost(request({}), cloudEnvironment)).status,
    ).toBe(403);
    expect(
      (
        await handleDashboardContextPost(
          request({ [DASHBOARD_CONTEXT_HEADER]: "1" }, "../escape"),
          cloudEnvironment,
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await handleDashboardContextPost(
          request({ [DASHBOARD_CONTEXT_HEADER]: "1" }),
          {},
        )
      ).status,
    ).toBe(404);
  });

  it("uses only the same-origin dashboard route from the browser helper", async () => {
    let observedUrl = "";
    let observedInit: RequestInit | undefined;
    const fetchImpl: typeof globalThis.fetch = async (input, init) => {
      observedUrl = String(input);
      observedInit = init;
      return Response.json({ persisted: true });
    };

    await persistDashboardCloudContext(
      { organizationId: "org_fixture", projectId: "proj_fixture" },
      fetchImpl,
    );

    expect(observedUrl).toBe("/api/dashboard/context");
    expect(observedInit?.credentials).toBe("same-origin");
    expect(
      new Headers(observedInit?.headers).get(DASHBOARD_CONTEXT_HEADER),
    ).toBe("1");
    expect(JSON.parse(String(observedInit?.body))).toEqual({
      organizationId: "org_fixture",
      projectId: "proj_fixture",
    });
  });
});

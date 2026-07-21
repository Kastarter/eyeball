import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { type ConnectionRecord, ExecutorApiError } from "@/src/lib/api";
import type { CatalogToolkitSummary } from "@/src/lib/catalog";
import type { CloudConnection } from "@/src/lib/cloud-api";
import {
  type CloudConnectionListModel,
  CloudConnectionLoadBanner,
  cloudConnectionListReducer,
} from "./cloud-connections-screen";
import {
  connectionDrawerUrl,
  parseConnectionDrawerQuery,
} from "./connection-drawer-state";
import {
  ConnectionLoadBanner,
  ConnectionsScreen,
  classifyConnectionExecutorFailure,
} from "./connections-screen";

const toolkit: CatalogToolkitSummary = {
  authClass: "oauth2",
  authFields: [],
  capabilities: [{ label: "Email", slug: "email" }],
  displayName: "Gmail",
  slug: "gmail",
  sourceLabel: "native",
  tier: "P0",
  toolCount: 8,
};

const executorConnection: ConnectionRecord = {
  connectionId: "conn_fixture",
  createdAt: "2026-07-21T09:00:00.000Z",
  status: "connected",
  toolkit: "gmail",
  userId: "user_fixture",
};

const cloudConnection: CloudConnection = {
  authType: "oauth2",
  createdAt: "2026-07-21T09:00:00.000Z",
  externalUserId: "user_fixture",
  id: "cloud_conn_fixture",
  oauthAppId: null,
  organizationId: "org_fixture",
  projectId: "proj_fixture",
  providerAccountLabel: "Primary Gmail",
  revokedAt: null,
  status: "active",
  toolkit: "gmail",
  updatedAt: "2026-07-21T09:05:00.000Z",
};

describe("executor connections fidelity", () => {
  it("classifies load failures without losing normalized diagnostics", () => {
    expect(
      classifyConnectionExecutorFailure(new ExecutorApiError("Missing", 401))
        .state,
    ).toBe("unconfigured");
    expect(
      classifyConnectionExecutorFailure(
        new ExecutorApiError("Scope", 403, {
          code: "auth_insufficient_scope",
        }),
      ).state,
    ).toBe("forbidden");
    expect(
      classifyConnectionExecutorFailure(new ExecutorApiError("Offline", 502))
        .state,
    ).toBe("offline");
    expect(
      classifyConnectionExecutorFailure(
        new ExecutorApiError("Missing URL", 503, {
          code: "executor_not_configured",
        }),
      ).state,
    ).toBe("not_configured");

    const generic = classifyConnectionExecutorFailure(
      new ExecutorApiError("Unexpected envelope", 500, {
        code: "invalid_response",
      }),
    );
    expect(generic).toEqual({
      error: { code: "invalid_response", message: "Unexpected envelope" },
      state: "error",
    });
  });

  it("renders specific setup, scope, offline, URL, and generic guidance", () => {
    const markup = renderToStaticMarkup(
      <div>
        <ConnectionLoadBanner
          cloud={false}
          onRetry={() => undefined}
          project="demo"
          state="unconfigured"
        />
        <ConnectionLoadBanner
          cloud
          onRetry={() => undefined}
          project="proj_fixture"
          state="forbidden"
        />
        <ConnectionLoadBanner
          cloud={false}
          onRetry={() => undefined}
          project="demo"
          state="offline"
        />
        <ConnectionLoadBanner
          cloud={false}
          onRetry={() => undefined}
          project="demo"
          state="not_configured"
        />
        <ConnectionLoadBanner
          cloud={false}
          error={{ code: "invalid_response", message: "Bad response" }}
          onRetry={() => undefined}
          project="demo"
          state="error"
        />
      </div>,
    );

    expect(markup).toContain("EYEBALL_API_KEY");
    expect(markup).toContain("Unpinned project key required");
    expect(markup).toContain("Executor offline");
    expect(markup).toContain("EYEBALL_EXECUTOR_URL");
    expect(markup).toContain("invalid_response");
    expect(markup.match(/Retry/g)).toHaveLength(5);
  });

  it("renders the true empty state only from a confirmed initial response", () => {
    const empty = renderToStaticMarkup(
      <ConnectionsScreen
        initialConnections={[]}
        project="proj_fixture"
        toolkits={[toolkit]}
      />,
    );
    const populated = renderToStaticMarkup(
      <ConnectionsScreen
        initialConnections={[executorConnection]}
        project="proj_fixture"
        toolkits={[toolkit]}
      />,
    );

    expect(empty).toContain("No connected accounts");
    expect(populated).toContain("user_fixture");
    expect(populated).not.toContain("No connected accounts");
  });

  it("parses command-palette drawer deep links without retaining stale state", () => {
    const deepLink = new URL(
      "https://dashboard.example.test/demo/connections?status=active&new=true#accounts",
    );
    expect(parseConnectionDrawerQuery(deepLink)).toEqual({
      newConnectionOpen: true,
    });

    const closedPath = connectionDrawerUrl(deepLink, false);
    expect(closedPath).toBe("/demo/connections?status=active#accounts");
    expect(
      parseConnectionDrawerQuery(
        new URL(closedPath, "https://dashboard.example.test"),
      ),
    ).toEqual({ newConnectionOpen: false });

    expect(
      connectionDrawerUrl(
        new URL(closedPath, "https://dashboard.example.test"),
        true,
      ),
    ).toBe("/demo/connections?status=active&new=true#accounts");
  });
});

describe("cloud connections list state", () => {
  it("keeps populated rows visible across failure, then clears the error on retry success", () => {
    const initial: CloudConnectionListModel = {
      connections: [cloudConnection],
      state: "ready",
    };
    const loading = cloudConnectionListReducer(initial, {
      type: "refresh_started",
    });
    const failed = cloudConnectionListReducer(loading, {
      error: { code: "cloud_unavailable", message: "Cloud unavailable" },
      type: "refresh_failed",
    });
    const retrying = cloudConnectionListReducer(failed, {
      type: "refresh_started",
    });
    const ready = cloudConnectionListReducer(retrying, {
      connections: [cloudConnection],
      type: "refresh_succeeded",
    });

    expect(failed.connections).toEqual([cloudConnection]);
    expect(failed.state).toBe("error");
    expect(retrying).toEqual({
      connections: [cloudConnection],
      state: "loading",
    });
    expect(ready).toEqual({ connections: [cloudConnection], state: "ready" });
  });

  it("does not turn an empty failed request into a confirmed empty project", () => {
    const failed = cloudConnectionListReducer(
      { connections: [], state: "loading" },
      {
        error: { code: "cloud_unavailable", message: "Cloud unavailable" },
        type: "refresh_failed",
      },
    );
    const ready = cloudConnectionListReducer(
      cloudConnectionListReducer(failed, { type: "refresh_started" }),
      { connections: [], type: "refresh_succeeded" },
    );

    expect(failed).toMatchObject({ connections: [], state: "error" });
    expect(ready).toEqual({ connections: [], state: "ready" });
  });

  it("gives list failures their own retry banner", () => {
    const markup = renderToStaticMarkup(
      <CloudConnectionLoadBanner
        error={{ code: "cloud_unavailable", message: "Cloud unavailable" }}
        onRetry={() => undefined}
      />,
    );

    expect(markup).toContain("Cloud connection refresh failed");
    expect(markup).toContain("cloud_unavailable");
    expect(markup.match(/Retry/g)).toHaveLength(1);
  });
});

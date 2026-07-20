export const DASHBOARD_CLOUD_PROXY_BASE_URL = "/api/cloud";
export const CLOUD_SESSION_COOKIE = "eyeball_cloud_session";
export const CLOUD_CSRF_COOKIE = "eyeball_cloud_csrf";
export const CLOUD_CSRF_HEADER = "X-CSRF-Token";
export const DASHBOARD_CONTEXT_HEADER = "X-Eyeball-Dashboard-Context";
export const DASHBOARD_PROJECT_COOKIE = "eyeball_dashboard_project";
export const DASHBOARD_ORGANIZATION_COOKIE = "eyeball_dashboard_organization";

export type CloudMembershipRole = "admin" | "member" | "owner";
export type CloudProjectEnvironment = "dev" | "prod";
export type CloudConnectionStatus =
  | "active"
  | "expired"
  | "needs_reauth"
  | "pending"
  | "revoked";

export interface CloudUser {
  createdAt?: string;
  email: string;
  id: string;
}

export interface CloudSession {
  csrfCookie: string;
  csrfHeader: string;
  expiresAt: string;
  user: CloudUser;
}

export interface CloudOrganization {
  createdAt: string;
  id: string;
  name: string;
  oauthRedirectOrigins: readonly string[];
  role: CloudMembershipRole;
  slug: string;
  updatedAt: string;
}

export interface CloudProject {
  createdAt: string;
  environment: CloudProjectEnvironment;
  id: string;
  name: string;
  organizationId: string;
  slug: string;
  updatedAt: string;
}

export interface CloudApiKey {
  createdAt: string;
  createdByUserId: string;
  id: string;
  lastUsedAt: string | null;
  name: string;
  pinnedUserId: string | null;
  prefix: string;
  projectId: string;
  revokedAt: string | null;
}

export interface CloudConnection {
  authType: "api_key" | "oauth2";
  createdAt: string;
  externalUserId: string;
  id: string;
  oauthAppId: string | null;
  organizationId: string;
  projectId: string;
  providerAccountLabel: string | null;
  revokedAt: string | null;
  status: CloudConnectionStatus;
  toolkit: string;
  updatedAt: string;
}

export interface CloudAuditEvent {
  action: string;
  actorUserId: string | null;
  createdAt: string;
  id?: string;
  metadata: Readonly<Record<string, unknown>> | null;
  organizationId: string | null;
  sequence: number;
  targetId: string | null;
  targetType: string;
}

export interface CloudOrganizationMember {
  createdAt: string;
  email: string;
  organizationId: string;
  role: CloudMembershipRole;
  updatedAt: string;
  userId: string;
}

export interface CloudOAuthApp {
  clientId: string;
  createdAt: string;
  hasClientSecret: boolean;
  id: string;
  kind: "byo" | "shared";
  organizationId: string | null;
  redirectBase: string;
  scopes: readonly string[];
  toolkit: string;
  updatedAt: string;
}

export type CloudBillingStatus = "active" | "canceled" | "free" | "past_due";

export interface CloudBillingPlan {
  baseMonthlyCents: number | null;
  hardLimits: boolean;
  included: {
    connections: number | null;
    executions: number | null;
    projects: number | null;
  };
  key: "enterprise" | "free" | "pro" | "scale";
  name: string;
  overage: {
    connections: { unitCents: number; unitSize: number } | null;
    executions: { unitCents: number; unitSize: number } | null;
  };
  selfServe: boolean;
  version: number;
}

export interface CloudUsageOverage {
  connections: { cents: number; quantity: number; units: number };
  executions: { cents: number; quantity: number; units: number };
  totalCents: number;
}

export interface CloudUsageView {
  limits: {
    connections: number | null;
    executions: number | null;
    projects: number | null;
  };
  month: string;
  percentage: {
    connections: number | null;
    executions: number | null;
    projects: number | null;
  };
  plan: CloudBillingPlan;
  projected: {
    connectionsPeak: number;
    executions: number;
    overage: CloudUsageOverage;
  };
  totals: {
    connectionsPeak: number;
    executions: number;
    projects: number;
  };
}

export interface CloudBillingView {
  currentPeriod: { end: string; start: string };
  graceEndsAt: string | null;
  hasPaymentPortal: boolean;
  limits: {
    connections: number | null;
    executions: number | null;
    projects: number | null;
  };
  pastDueSince: string | null;
  plan: CloudBillingPlan;
  restrictions: {
    credentialResolves: boolean;
    existingKeys: boolean;
    newApiKeys: boolean;
    newConnections: boolean;
  };
  status: CloudBillingStatus;
  usage: {
    month: string;
    percentage: CloudUsageView["percentage"];
    projected: CloudUsageView["projected"];
    totals: CloudUsageView["totals"];
  };
}

export interface PutCloudOAuthAppRequest {
  clientId: string;
  clientSecret?: string;
  redirectBase: string;
  scopes: readonly string[];
  toolkit: string;
}

export type CreateCloudConnectionRequest =
  | {
      authType: "api_key";
      externalUserId: string;
      fields: Readonly<Record<string, string>>;
      providerAccountLabel?: string;
      toolkit: string;
    }
  | {
      authType: "oauth2";
      externalUserId: string;
      oauthAppId?: string;
      providerAccountLabel?: string;
      returnUrl?: string;
      toolkit: string;
    };

export type CreateCloudConnectionResponse =
  | { connection: CloudConnection }
  | {
      connection: CloudConnection;
      expiresAt: string;
      redirectUrl: string;
    };

export interface ReauthorizeCloudConnectionRequest {
  oauthAppId?: string;
  returnUrl?: string;
}

export interface CloudClientOptions {
  baseUrl?: string;
  csrfToken?: () => string | undefined;
  fetch?: typeof globalThis.fetch;
}

export class CloudApiError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(message: string, status: number, code = "cloud_request_failed") {
    super(message);
    this.name = "CloudApiError";
    this.code = code;
    this.status = status;
  }
}

function cookieValue(cookieHeader: string, name: string): string | undefined {
  for (const part of cookieHeader.split(";")) {
    const [candidate, ...rest] = part.trim().split("=");
    if (candidate !== name) continue;
    const value = rest.join("=");
    try {
      return decodeURIComponent(value);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export function cloudControlCookieHeader(
  cookieHeader: string | null,
): string | undefined {
  if (cookieHeader === null) return undefined;
  const allowed = new Set([CLOUD_SESSION_COOKIE, CLOUD_CSRF_COOKIE]);
  const selected = cookieHeader
    .split(";")
    .map((part) => part.trim())
    .filter((part) => allowed.has(part.split("=", 1)[0] ?? ""));
  return selected.length === 0 ? undefined : selected.join("; ");
}

export function browserCloudCsrfToken(): string | undefined {
  return typeof document === "undefined"
    ? undefined
    : cookieValue(document.cookie, CLOUD_CSRF_COOKIE);
}

function cloudError(
  value: unknown,
): { code: string; message: string } | undefined {
  if (typeof value !== "object" || value === null || !("error" in value)) {
    return undefined;
  }
  const error = value.error;
  if (
    typeof error !== "object" ||
    error === null ||
    !("code" in error) ||
    !("message" in error) ||
    typeof error.code !== "string" ||
    typeof error.message !== "string"
  ) {
    return undefined;
  }
  return { code: error.code, message: error.message };
}

export class CloudClient {
  readonly #baseUrl: string;
  readonly #csrfToken: () => string | undefined;
  readonly #fetch: typeof globalThis.fetch;

  constructor({
    baseUrl = DASHBOARD_CLOUD_PROXY_BASE_URL,
    csrfToken = browserCloudCsrfToken,
    fetch: fetchImpl = globalThis.fetch,
  }: CloudClientOptions = {}) {
    if (typeof fetchImpl !== "function") {
      throw new TypeError("CloudClient requires a fetch implementation.");
    }
    this.#baseUrl = baseUrl.replace(/\/$/u, "");
    this.#csrfToken = csrfToken;
    this.#fetch = fetchImpl;
  }

  login(input: { email: string; password: string }) {
    return this.#request<{ csrfToken: string; user: CloudUser }>(
      "/v1/auth/login",
      { method: "POST", body: JSON.stringify(input) },
    );
  }

  signup(input: { email: string; password: string }) {
    return this.#request<{ csrfToken: string; user: CloudUser }>(
      "/v1/auth/signup",
      { method: "POST", body: JSON.stringify(input) },
    );
  }

  session(signal?: AbortSignal) {
    return this.#request<CloudSession>(
      "/v1/auth/session",
      signal === undefined ? {} : { signal },
    );
  }

  logout() {
    return this.#request<void>("/v1/auth/logout", { method: "POST" });
  }

  listOrganizations(signal?: AbortSignal) {
    return this.#request<{ organizations: readonly CloudOrganization[] }>(
      "/v1/orgs",
      signal === undefined ? {} : { signal },
    );
  }

  createOrganization(input: { name: string; slug: string }) {
    return this.#request<{
      organization: Omit<CloudOrganization, "role">;
      role: CloudMembershipRole;
    }>("/v1/orgs", { method: "POST", body: JSON.stringify(input) });
  }

  listProjects(organizationId: string, signal?: AbortSignal) {
    return this.#request<{ projects: readonly CloudProject[] }>(
      `/v1/orgs/${encodeURIComponent(organizationId)}/projects`,
      signal === undefined ? {} : { signal },
    );
  }

  organization(organizationId: string, signal?: AbortSignal) {
    return this.#request<{
      membership: Omit<CloudOrganizationMember, "email">;
      organization: Omit<CloudOrganization, "role">;
    }>(
      `/v1/orgs/${encodeURIComponent(organizationId)}`,
      signal === undefined ? {} : { signal },
    );
  }

  updateOrganization(
    organizationId: string,
    input: {
      name?: string;
      oauthRedirectOrigins?: readonly string[];
      slug?: string;
    },
  ) {
    return this.#request<{
      organization: Omit<CloudOrganization, "role">;
    }>(`/v1/orgs/${encodeURIComponent(organizationId)}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    });
  }

  billing(organizationId: string, signal?: AbortSignal) {
    return this.#request<{ billing: CloudBillingView }>(
      `/v1/orgs/${encodeURIComponent(organizationId)}/billing`,
      signal === undefined ? {} : { signal },
    );
  }

  usage(organizationId: string, signal?: AbortSignal) {
    return this.#request<{ usage: CloudUsageView }>(
      `/v1/orgs/${encodeURIComponent(organizationId)}/usage`,
      signal === undefined ? {} : { signal },
    );
  }

  billingPlans(organizationId: string, signal?: AbortSignal) {
    return this.#request<{ plans: readonly CloudBillingPlan[] }>(
      `/v1/orgs/${encodeURIComponent(organizationId)}/billing/plans`,
      signal === undefined ? {} : { signal },
    );
  }

  createBillingCheckout(organizationId: string, plan: "pro" | "scale") {
    return this.#request<{ checkout: { id: string; url: string } }>(
      `/v1/orgs/${encodeURIComponent(organizationId)}/billing/checkout`,
      { method: "POST", body: JSON.stringify({ plan }) },
    );
  }

  createBillingPortal(organizationId: string) {
    return this.#request<{ url: string }>(
      `/v1/orgs/${encodeURIComponent(organizationId)}/billing/portal`,
      { method: "POST", body: JSON.stringify({}) },
    );
  }

  listOrganizationMembers(organizationId: string, signal?: AbortSignal) {
    return this.#request<{ members: readonly CloudOrganizationMember[] }>(
      `/v1/orgs/${encodeURIComponent(organizationId)}/members`,
      signal === undefined ? {} : { signal },
    );
  }

  addOrganizationMember(
    organizationId: string,
    input: { email: string; role: Exclude<CloudMembershipRole, "owner"> },
  ) {
    return this.#request<{
      membership: Omit<CloudOrganizationMember, "email">;
      user: CloudUser;
    }>(`/v1/orgs/${encodeURIComponent(organizationId)}/members`, {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  updateOrganizationMember(
    organizationId: string,
    userId: string,
    role: Exclude<CloudMembershipRole, "owner">,
  ) {
    return this.#request<{
      membership: Omit<CloudOrganizationMember, "email">;
    }>(
      `/v1/orgs/${encodeURIComponent(organizationId)}/members/${encodeURIComponent(userId)}`,
      { method: "PATCH", body: JSON.stringify({ role }) },
    );
  }

  removeOrganizationMember(organizationId: string, userId: string) {
    return this.#request<void>(
      `/v1/orgs/${encodeURIComponent(organizationId)}/members/${encodeURIComponent(userId)}`,
      { method: "DELETE" },
    );
  }

  listOAuthApps(organizationId: string, signal?: AbortSignal) {
    return this.#request<{ oauthApps: readonly CloudOAuthApp[] }>(
      `/v1/orgs/${encodeURIComponent(organizationId)}/oauth-apps`,
      signal === undefined ? {} : { signal },
    );
  }

  putOAuthApp(organizationId: string, input: PutCloudOAuthAppRequest) {
    return this.#request<{ oauthApp: CloudOAuthApp }>(
      `/v1/orgs/${encodeURIComponent(organizationId)}/oauth-apps`,
      { method: "POST", body: JSON.stringify(input) },
    );
  }

  createProject(
    organizationId: string,
    input: {
      environment: CloudProjectEnvironment;
      name: string;
      slug: string;
    },
  ) {
    return this.#request<{ project: CloudProject }>(
      `/v1/orgs/${encodeURIComponent(organizationId)}/projects`,
      { method: "POST", body: JSON.stringify(input) },
    );
  }

  listApiKeys(projectId: string, signal?: AbortSignal) {
    return this.#request<{ apiKeys: readonly CloudApiKey[] }>(
      `/v1/projects/${encodeURIComponent(projectId)}/api-keys`,
      signal === undefined ? {} : { signal },
    );
  }

  createApiKey(
    projectId: string,
    input: { name: string; pinnedUserId?: string },
  ) {
    return this.#request<{ apiKey: CloudApiKey; key: string }>(
      `/v1/projects/${encodeURIComponent(projectId)}/api-keys`,
      { method: "POST", body: JSON.stringify(input) },
    );
  }

  revokeApiKey(projectId: string, apiKeyId: string) {
    return this.#request<{ apiKey: CloudApiKey }>(
      `/v1/projects/${encodeURIComponent(projectId)}/api-keys/${encodeURIComponent(apiKeyId)}`,
      { method: "DELETE" },
    );
  }

  listConnections(projectId: string, signal?: AbortSignal) {
    return this.#request<{ connections: readonly CloudConnection[] }>(
      `/v1/projects/${encodeURIComponent(projectId)}/connections`,
      signal === undefined ? {} : { signal },
    );
  }

  createConnection(projectId: string, input: CreateCloudConnectionRequest) {
    return this.#request<CreateCloudConnectionResponse>(
      `/v1/projects/${encodeURIComponent(projectId)}/connections`,
      { method: "POST", body: JSON.stringify(input) },
    );
  }

  revokeConnection(projectId: string, connectionId: string) {
    return this.#request<{ connection: CloudConnection }>(
      `/v1/projects/${encodeURIComponent(projectId)}/connections/${encodeURIComponent(connectionId)}`,
      { method: "DELETE" },
    );
  }

  reauthorizeConnection(
    projectId: string,
    connectionId: string,
    input: ReauthorizeCloudConnectionRequest = {},
  ) {
    return this.#request<
      Extract<CreateCloudConnectionResponse, { redirectUrl: string }>
    >(
      `/v1/projects/${encodeURIComponent(projectId)}/connections/${encodeURIComponent(connectionId)}/reauthorize`,
      { method: "POST", body: JSON.stringify(input) },
    );
  }

  listAuditEvents(
    organizationId: string,
    options: { limit?: number; signal?: AbortSignal } = {},
  ) {
    const query = new URLSearchParams();
    if (options.limit !== undefined) query.set("limit", String(options.limit));
    const suffix = query.size === 0 ? "" : `?${query.toString()}`;
    return this.#request<{ events: readonly CloudAuditEvent[] }>(
      `/v1/orgs/${encodeURIComponent(organizationId)}/audit-log${suffix}`,
      options.signal === undefined ? {} : { signal: options.signal },
    );
  }

  async #request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set("Accept", "application/json");
    if (init.body !== undefined)
      headers.set("Content-Type", "application/json");
    if (init.method !== undefined && init.method !== "GET") {
      const token = this.#csrfToken();
      if (token !== undefined && token.length > 0) {
        headers.set(CLOUD_CSRF_HEADER, token);
      }
    }
    const response = await this.#fetch(`${this.#baseUrl}${path}`, {
      ...init,
      headers,
      credentials: "same-origin",
      cache: "no-store",
    });
    const contentType = response.headers.get("Content-Type") ?? "";
    const value = contentType.includes("json")
      ? await response.json().catch(() => undefined)
      : undefined;
    if (!response.ok) {
      const error = cloudError(value);
      throw new CloudApiError(
        error?.message ?? `Cloud request failed with HTTP ${response.status}.`,
        response.status,
        error?.code,
      );
    }
    return value as T;
  }
}

export function dashboardCloudClient(): CloudClient {
  return new CloudClient();
}

export async function persistDashboardCloudContext(
  input: { organizationId: string; projectId?: string },
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): Promise<void> {
  const response = await fetchImpl("/api/dashboard/context", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      [DASHBOARD_CONTEXT_HEADER]: "1",
    },
    body: JSON.stringify(input),
    credentials: "same-origin",
    cache: "no-store",
  });
  if (!response.ok) {
    throw new CloudApiError(
      "The dashboard could not persist the selected cloud context.",
      response.status,
      "context_persistence_failed",
    );
  }
}

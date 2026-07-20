import { cookies } from "next/headers";
import {
  CLOUD_CSRF_COOKIE,
  CloudApiError,
  type CloudApiKey,
  type CloudAuditEvent,
  type CloudBillingView,
  CloudClient,
  type CloudConnection,
  type CloudOrganization,
  type CloudProject,
  type CloudSession,
  cloudControlCookieHeader,
  DASHBOARD_ORGANIZATION_COOKIE,
  DASHBOARD_PROJECT_COOKIE,
} from "./cloud-api";
import { isCloudMode } from "./runtime-config";

export interface CloudOrganizationContext {
  organization: CloudOrganization;
  projects: readonly CloudProject[];
}

export interface CloudShellContext {
  organizations: readonly CloudOrganizationContext[];
  selectedOrganization: CloudOrganization;
  selectedProject: CloudProject;
  session: CloudSession;
}

function configuredCloudUrl(): string {
  const value = process.env.EYEBALL_CLOUD_URL?.trim();
  if (!isCloudMode() || value === undefined || value.length === 0) {
    throw new CloudApiError(
      "Cloud mode requires a server-only EYEBALL_CLOUD_URL.",
      503,
      "cloud_not_configured",
    );
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new CloudApiError(
      "EYEBALL_CLOUD_URL must be a valid HTTP(S) URL.",
      503,
      "cloud_not_configured",
    );
  }
  if (
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    url.username.length > 0 ||
    url.password.length > 0
  ) {
    throw new CloudApiError(
      "EYEBALL_CLOUD_URL must be an HTTP(S) URL without embedded credentials.",
      503,
      "cloud_not_configured",
    );
  }
  return value.replace(/\/$/u, "");
}

async function serverCloudClient(): Promise<CloudClient> {
  const cookieStore = await cookies();
  const cookieHeader =
    cloudControlCookieHeader(
      cookieStore
        .getAll()
        .map(({ name, value }) => `${name}=${encodeURIComponent(value)}`)
        .join("; "),
    ) ?? "";
  const csrfToken = cookieStore.get(CLOUD_CSRF_COOKIE)?.value;
  const fetchWithSession: typeof globalThis.fetch = async (input, init) => {
    const headers = new Headers(init?.headers);
    if (cookieHeader.length > 0) headers.set("Cookie", cookieHeader);
    return fetch(input, { ...init, headers, cache: "no-store" });
  };
  return new CloudClient({
    baseUrl: configuredCloudUrl(),
    csrfToken: () => csrfToken,
    fetch: fetchWithSession,
  });
}

export async function loadCloudSession(): Promise<CloudSession | undefined> {
  const client = await serverCloudClient();
  try {
    return await client.session();
  } catch (error) {
    if (error instanceof CloudApiError && error.status === 401)
      return undefined;
    throw error;
  }
}

export async function loadCloudOrganizations(): Promise<{
  session: CloudSession;
  organizations: readonly CloudOrganizationContext[];
}> {
  const client = await serverCloudClient();
  const [session, organizationPage] = await Promise.all([
    client.session(),
    client.listOrganizations(),
  ]);
  const projectPages = await Promise.all(
    organizationPage.organizations.map((organization) =>
      client.listProjects(organization.id),
    ),
  );
  return {
    session,
    organizations: organizationPage.organizations.map(
      (organization, index) => ({
        organization,
        projects: projectPages[index]?.projects ?? [],
      }),
    ),
  };
}

export async function loadCloudShellContext(
  requestedProjectId?: string,
): Promise<CloudShellContext | undefined> {
  const context = await loadCloudOrganizations();
  const available = context.organizations.flatMap(
    ({ organization, projects }) =>
      projects.map((project) => ({ organization, project })),
  );
  if (available.length === 0) return undefined;

  const cookieStore = await cookies();
  const persistedProjectId = cookieStore.get(DASHBOARD_PROJECT_COOKIE)?.value;
  const persistedOrganizationId = cookieStore.get(
    DASHBOARD_ORGANIZATION_COOKIE,
  )?.value;
  const selected =
    available.find(({ project }) => project.id === requestedProjectId) ??
    available.find(({ project }) => project.id === persistedProjectId) ??
    available.find(
      ({ organization }) => organization.id === persistedOrganizationId,
    ) ??
    available[0];
  if (selected === undefined) return undefined;

  return {
    organizations: context.organizations,
    selectedOrganization: selected.organization,
    selectedProject: selected.project,
    session: context.session,
  };
}

export async function loadCloudConnections(
  projectId: string,
): Promise<readonly CloudConnection[]> {
  return (await (await serverCloudClient()).listConnections(projectId))
    .connections;
}

export async function loadCloudApiKeys(
  projectId: string,
): Promise<readonly CloudApiKey[]> {
  return (await (await serverCloudClient()).listApiKeys(projectId)).apiKeys;
}

export async function loadCloudAuditEvents(
  organizationId: string,
): Promise<readonly CloudAuditEvent[]> {
  return (
    await (
      await serverCloudClient()
    ).listAuditEvents(organizationId, {
      limit: 200,
    })
  ).events;
}

export async function loadCloudBilling(
  organizationId: string,
): Promise<CloudBillingView> {
  return (await (await serverCloudClient()).billing(organizationId)).billing;
}

import { cookies } from "next/headers";
import { cache } from "react";
import {
  CLOUD_CSRF_COOKIE,
  CloudApiError,
  type CloudApiKey,
  type CloudAuditEvent,
  type CloudBillingPlan,
  type CloudBillingView,
  CloudClient,
  type CloudConnection,
  type CloudOAuthApp,
  type CloudOrganization,
  type CloudOrganizationMember,
  type CloudProject,
  type CloudSession,
  type CloudUsageView,
  cloudControlCookieHeader,
  DASHBOARD_ORGANIZATION_COOKIE,
  DASHBOARD_PROJECT_COOKIE,
} from "./cloud-api";
import { configuredCloudControlUrl } from "./cloud-proxy";

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
  // Reuse the strict control-plane validator that the browser proxy already
  // enforces (apps/dashboard/src/lib/cloud-proxy.ts). The server rendering path
  // in serverCloudClient() copies the session and CSRF cookies into an outbound
  // Cookie header, so an insecure origin here would leak authenticated cookies
  // in cleartext. This shared validator permits https:, allows http: only for
  // loopback development hosts, and rejects embedded credentials, query, and
  // fragment.
  const url = configuredCloudControlUrl();
  if (url === undefined) {
    throw new CloudApiError(
      "Cloud mode requires a valid server-only EYEBALL_CLOUD_URL (HTTPS, or loopback HTTP for development, without embedded credentials, query, or fragment).",
      503,
      "cloud_not_configured",
    );
  }
  return url;
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

export const loadCloudOrganizations = cache(
  async function loadOrganizations(): Promise<{
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
  },
);

async function selectCloudShellContext(
  requestedProjectId?: string,
  requestedOrganizationId?: string,
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
    (requestedOrganizationId === undefined
      ? undefined
      : available.find(
          ({ organization, project }) =>
            organization.id === requestedOrganizationId &&
            project.id === persistedProjectId,
        )) ??
    (requestedOrganizationId === undefined
      ? undefined
      : available.find(
          ({ organization }) => organization.id === requestedOrganizationId,
        )) ??
    (requestedOrganizationId === undefined
      ? available.find(({ project }) => project.id === persistedProjectId)
      : undefined) ??
    (requestedOrganizationId === undefined
      ? available.find(
          ({ organization }) => organization.id === persistedOrganizationId,
        )
      : undefined) ??
    (requestedOrganizationId === undefined ? available[0] : undefined);
  if (selected === undefined) return undefined;

  return {
    organizations: context.organizations,
    selectedOrganization: selected.organization,
    selectedProject: selected.project,
    session: context.session,
  };
}

export const loadCloudShellContext = cache(async function loadShellContext(
  requestedProjectId?: string,
): Promise<CloudShellContext | undefined> {
  return selectCloudShellContext(requestedProjectId);
});

export const loadCloudShellContextForOrganization = cache(
  async function loadShellContextForOrganization(
    requestedOrganizationId?: string,
  ): Promise<CloudShellContext | undefined> {
    return selectCloudShellContext(undefined, requestedOrganizationId);
  },
);

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

export async function loadCloudUsage(
  organizationId: string,
): Promise<CloudUsageView> {
  return (await (await serverCloudClient()).usage(organizationId)).usage;
}

export async function loadCloudBillingPlans(
  organizationId: string,
): Promise<readonly CloudBillingPlan[]> {
  return (await (await serverCloudClient()).billingPlans(organizationId)).plans;
}

export async function loadCloudOrganizationMembers(
  organizationId: string,
): Promise<readonly CloudOrganizationMember[]> {
  return (
    await (await serverCloudClient()).listOrganizationMembers(organizationId)
  ).members;
}

export async function loadCloudOAuthApps(
  organizationId: string,
): Promise<readonly CloudOAuthApp[]> {
  return (await (await serverCloudClient()).listOAuthApps(organizationId))
    .oauthApps;
}

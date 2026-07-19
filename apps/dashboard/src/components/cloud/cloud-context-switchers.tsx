"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect } from "react";
import {
  type CloudOrganization,
  type CloudProject,
  persistDashboardCloudContext,
} from "@/src/lib/cloud-api";

export interface CloudSwitcherOrganization {
  organization: CloudOrganization;
  projects: readonly CloudProject[];
}

export function CloudContextSwitchers({
  organizations,
  selectedOrganizationId,
  selectedProjectId,
}: {
  organizations: readonly CloudSwitcherOrganization[];
  selectedOrganizationId: string;
  selectedProjectId: string;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const selectedOrganization = organizations.find(
    ({ organization }) => organization.id === selectedOrganizationId,
  );
  const pageSegment = pathname.split("/").filter(Boolean)[1] ?? "overview";

  useEffect(() => {
    void persistDashboardCloudContext({
      organizationId: selectedOrganizationId,
      projectId: selectedProjectId,
    }).catch(() => undefined);
  }, [selectedOrganizationId, selectedProjectId]);

  async function selectProject(projectId: string) {
    const project = organizations
      .flatMap(({ projects }) => projects)
      .find((candidate) => candidate.id === projectId);
    if (project === undefined) return;
    try {
      await persistDashboardCloudContext({
        organizationId: project.organizationId,
        projectId: project.id,
      });
    } finally {
      router.push(`/${encodeURIComponent(project.id)}/${pageSegment}`);
      router.refresh();
    }
  }

  async function selectOrganization(organizationId: string) {
    const selection = organizations.find(
      ({ organization }) => organization.id === organizationId,
    );
    const firstProject = selection?.projects[0];
    if (firstProject === undefined) {
      await persistDashboardCloudContext({ organizationId }).catch(
        () => undefined,
      );
      router.push("/onboarding");
      router.refresh();
      return;
    }
    try {
      await persistDashboardCloudContext({
        organizationId,
        projectId: firstProject.id,
      });
    } finally {
      router.push(`/${encodeURIComponent(firstProject.id)}/${pageSegment}`);
      router.refresh();
    }
  }

  return (
    <fieldset aria-label="Cloud context" className="cloud-switchers">
      <label>
        <span>Organization</span>
        <select
          aria-label="Organization"
          onChange={(event) => {
            void selectOrganization(event.currentTarget.value);
          }}
          value={selectedOrganizationId}
        >
          {organizations.map(({ organization }) => (
            <option key={organization.id} value={organization.id}>
              {organization.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span>Project</span>
        <select
          aria-label="Project"
          onChange={(event) => {
            void selectProject(event.currentTarget.value);
          }}
          value={selectedProjectId}
        >
          {(selectedOrganization?.projects ?? []).map((project) => (
            <option key={project.id} value={project.id}>
              {project.name}
            </option>
          ))}
        </select>
      </label>
    </fieldset>
  );
}

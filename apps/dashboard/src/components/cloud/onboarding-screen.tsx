"use client";

import type { FormEvent } from "react";
import { useState } from "react";
import { ApertureLogo } from "@/src/components/shell/aperture-logo";
import { Button } from "@/src/components/ui/button";
import { Input, Select } from "@/src/components/ui/form-controls";
import { SecretRevealDialog } from "@/src/components/ui/secret-reveal-dialog";
import {
  CloudApiError,
  type CloudOrganization,
  type CloudProjectEnvironment,
  dashboardCloudClient,
  persistDashboardCloudContext,
} from "@/src/lib/cloud-api";

export function cloudSlug(value: string): string {
  const normalized = value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 63)
    .replace(/-+$/u, "");
  return normalized.length > 0 ? normalized : "workspace";
}

export function OnboardingScreen({
  existingOrganization,
}: {
  existingOrganization?: CloudOrganization;
}) {
  const [organizationName, setOrganizationName] = useState(
    existingOrganization?.name ?? "",
  );
  const [projectName, setProjectName] = useState("Production");
  const [environment, setEnvironment] =
    useState<CloudProjectEnvironment>("prod");
  const [submitting, setSubmitting] = useState(false);
  const [organizationId, setOrganizationId] = useState(
    existingOrganization?.id,
  );
  const [projectId, setProjectId] = useState<string>();
  const [created, setCreated] = useState<{
    organizationId: string;
    projectId: string;
    key: string;
  }>();
  const [error, setError] = useState<{ code: string; message: string }>();

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError(undefined);
    try {
      const client = dashboardCloudClient();
      let nextOrganizationId = organizationId;
      if (nextOrganizationId === undefined) {
        const result = await client.createOrganization({
          name: organizationName.trim(),
          slug: cloudSlug(organizationName),
        });
        nextOrganizationId = result.organization.id;
        setOrganizationId(nextOrganizationId);
      }
      let nextProjectId = projectId;
      if (nextProjectId === undefined) {
        const result = await client.createProject(nextOrganizationId, {
          name: projectName.trim(),
          slug: cloudSlug(projectName),
          environment,
        });
        nextProjectId = result.project.id;
        setProjectId(nextProjectId);
      }
      const keyResult = await client.createApiKey(nextProjectId, {
        name: "Initial project key",
      });
      await persistDashboardCloudContext({
        organizationId: nextOrganizationId,
        projectId: nextProjectId,
      });
      setCreated({
        organizationId: nextOrganizationId,
        projectId: nextProjectId,
        key: keyResult.key,
      });
    } catch (caught) {
      const apiError = caught instanceof CloudApiError ? caught : undefined;
      setError({
        code: apiError?.code ?? "cloud_unavailable",
        message:
          apiError?.message ??
          "The workspace could not be created. Your session is still safe; retry when the control plane is available.",
      });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="onboarding-canvas">
      <section className="onboarding-card surface surface--raised">
        <div className="auth-brand">
          <ApertureLogo size={34} watching />
          <span>eyeball cloud</span>
        </div>
        <p className="eyebrow">First-run setup</p>
        <h1>
          {existingOrganization
            ? "Create the first project."
            : "Create your workspace."}
        </h1>
        <p className="auth-card__lede">
          {existingOrganization
            ? `${existingOrganization.name} is ready. Add its first project and store the reveal-once key.`
            : "One short setup creates your organization, its first project, and a project key for trusted server-side execution."}
        </p>
        <form className="onboarding-form" onSubmit={submit}>
          <Input
            disabled={organizationId !== undefined}
            label="Organization name"
            onChange={(event) => setOrganizationName(event.currentTarget.value)}
            required
            value={organizationName}
          />
          <Input
            disabled={projectId !== undefined}
            label="First project"
            onChange={(event) => setProjectName(event.currentTarget.value)}
            required
            value={projectName}
          />
          <Select
            disabled={projectId !== undefined}
            label="Environment"
            onChange={(event) =>
              setEnvironment(
                event.currentTarget.value as CloudProjectEnvironment,
              )
            }
            options={[
              { label: "Production", value: "prod" },
              { label: "Development", value: "dev" },
            ]}
            value={environment}
          />
          {error ? (
            <div className="inline-error" role="alert">
              <span className="taxonomy-badge taxonomy-badge--error">
                {error.code}
              </span>
              <p>{error.message}</p>
            </div>
          ) : null}
          <Button disabled={submitting} type="submit" variant="primary">
            {submitting ? "Creating workspace…" : "Create workspace"}
          </Button>
        </form>
      </section>
      {created ? (
        <SecretRevealDialog
          onClose={() =>
            window.location.assign(
              `/${encodeURIComponent(created.projectId)}/overview`,
            )
          }
          secret={created.key}
          title="Store your first project key now"
        />
      ) : null}
    </main>
  );
}

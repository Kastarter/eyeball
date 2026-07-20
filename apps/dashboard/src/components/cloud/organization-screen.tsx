"use client";

import Link from "next/link";
import { type FormEvent, useMemo, useState } from "react";
import { PageHeader } from "@/src/components/pages/page-header";
import { Button } from "@/src/components/ui/button";
import { Input, Select } from "@/src/components/ui/form-controls";
import { Icon } from "@/src/components/ui/icon";
import { TableShell } from "@/src/components/ui/table";
import type { CatalogToolkitSummary } from "@/src/lib/catalog";
import {
  CloudApiError,
  type CloudMembershipRole,
  type CloudOAuthApp,
  type CloudOrganization,
  type CloudOrganizationMember,
  dashboardCloudClient,
  type PutCloudOAuthAppRequest,
} from "@/src/lib/cloud-api";
import { cn } from "@/src/lib/cn";

type AssignableRole = Exclude<CloudMembershipRole, "owner">;

type OrganizationMemberMutationClient = Pick<
  ReturnType<typeof dashboardCloudClient>,
  | "addOrganizationMember"
  | "removeOrganizationMember"
  | "updateOrganizationMember"
>;

export interface OrganizationMemberPolicy {
  canAdd: boolean;
  canGrantAdmin: boolean;
  canManageTarget: boolean;
}

export function organizationMemberPolicy(
  actorRole: CloudMembershipRole,
  targetRole?: CloudMembershipRole,
): OrganizationMemberPolicy {
  return {
    canAdd: actorRole === "owner" || actorRole === "admin",
    canGrantAdmin: actorRole === "owner",
    canManageTarget:
      actorRole === "owner" &&
      targetRole !== undefined &&
      targetRole !== "owner",
  };
}

export function confirmOrganizationMemberRoleChange(
  member: CloudOrganizationMember,
  role: AssignableRole,
  confirm: (message: string) => boolean,
): boolean {
  if (member.role === "owner" || member.role === role) return false;
  return confirm(`Change ${member.email} from ${member.role} to ${role}?`);
}

export function confirmOrganizationMemberRemoval(
  member: CloudOrganizationMember,
  confirm: (message: string) => boolean,
): boolean {
  if (member.role === "owner") return false;
  return confirm(
    `Remove ${member.email} from this organization? Their project access will end immediately.`,
  );
}

export function requestOrganizationMemberAddition(
  organizationId: string,
  input: { email: string; role: AssignableRole },
  client: OrganizationMemberMutationClient = dashboardCloudClient(),
) {
  return client.addOrganizationMember(organizationId, input);
}

export function requestOrganizationMemberRoleChange(
  organizationId: string,
  userId: string,
  role: AssignableRole,
  client: OrganizationMemberMutationClient = dashboardCloudClient(),
) {
  return client.updateOrganizationMember(organizationId, userId, role);
}

export function requestOrganizationMemberRemoval(
  organizationId: string,
  userId: string,
  client: OrganizationMemberMutationClient = dashboardCloudClient(),
) {
  return client.removeOrganizationMember(organizationId, userId);
}

export function oauthAppRequest(input: {
  clientId: string;
  clientSecret: string;
  redirectBase: string;
  scopes: string;
  toolkit: string;
}): PutCloudOAuthAppRequest {
  const scopes = [
    ...new Set(
      input.scopes
        .split(/[\n,]/u)
        .map((scope) => scope.trim())
        .filter(Boolean),
    ),
  ];
  return {
    toolkit: input.toolkit,
    clientId: input.clientId.trim(),
    ...(input.clientSecret.length === 0
      ? {}
      : { clientSecret: input.clientSecret }),
    scopes,
    redirectBase: input.redirectBase.trim(),
  };
}

export function normalizeOAuthRedirectOrigins(value: string): {
  error?: string;
  origins?: readonly string[];
} {
  const candidates = value
    .split(/\n/u)
    .map((origin) => origin.trim())
    .filter(Boolean);
  if (candidates.length > 20) {
    return { error: "Register at most 20 redirect origins." };
  }
  const origins: string[] = [];
  for (const candidate of candidates) {
    let url: URL;
    try {
      url = new URL(candidate);
    } catch {
      return { error: `${candidate} is not a valid URL origin.` };
    }
    const loopback =
      url.hostname === "localhost" ||
      url.hostname === "::1" ||
      url.hostname === "[::1]" ||
      /^127(?:\.\d{1,3}){3}$/u.test(url.hostname);
    if (
      (url.protocol !== "https:" && url.protocol !== "http:") ||
      (url.protocol === "http:" && !loopback) ||
      url.origin === "null" ||
      url.username.length > 0 ||
      url.password.length > 0 ||
      url.pathname !== "/" ||
      url.search.length > 0 ||
      url.hash.length > 0
    ) {
      return {
        error: `${candidate} must be an exact HTTPS origin (HTTP is allowed only for loopback development).`,
      };
    }
    if (!origins.includes(url.origin)) origins.push(url.origin);
  }
  return { origins };
}

function dateLabel(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return value;
  return new Intl.DateTimeFormat("en", {
    day: "2-digit",
    month: "short",
    timeZone: "UTC",
    year: "numeric",
  }).format(date);
}

function roleLabel(role: CloudMembershipRole): string {
  return `${role.slice(0, 1).toUpperCase()}${role.slice(1)}`;
}

function InlineError({
  error,
}: {
  error: { code: string; message: string } | undefined;
}) {
  return error ? (
    <div className="inline-error" role="alert">
      <span className="taxonomy-badge taxonomy-badge--error">{error.code}</span>
      <p>{error.message}</p>
    </div>
  ) : null;
}

export interface OrganizationScreenProps {
  initialMembers: readonly CloudOrganizationMember[];
  initialOAuthApps: readonly CloudOAuthApp[];
  organization: CloudOrganization;
  project: string;
  toolkits: readonly CatalogToolkitSummary[];
}

export function OrganizationScreen({
  initialMembers,
  initialOAuthApps,
  organization: initialOrganization,
  project,
  toolkits,
}: OrganizationScreenProps) {
  const [organization, setOrganization] =
    useState<CloudOrganization>(initialOrganization);
  const [members, setMembers] =
    useState<readonly CloudOrganizationMember[]>(initialMembers);
  const [oauthApps, setOAuthApps] =
    useState<readonly CloudOAuthApp[]>(initialOAuthApps);
  const [organizationName, setOrganizationName] = useState(organization.name);
  const [memberEmail, setMemberEmail] = useState("");
  const [memberRole, setMemberRole] = useState<AssignableRole>("member");
  const [originsText, setOriginsText] = useState(
    organization.oauthRedirectOrigins.join("\n"),
  );
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<{ code: string; message: string }>();
  const [notice, setNotice] = useState<string>();
  const oauthToolkits = useMemo(() => {
    const available = toolkits
      .filter((toolkit) => toolkit.authClass === "oauth2")
      .map((toolkit) => ({ label: toolkit.displayName, value: toolkit.slug }));
    for (const app of oauthApps) {
      if (!available.some(({ value }) => value === app.toolkit)) {
        available.push({ label: app.toolkit, value: app.toolkit });
      }
    }
    return available.toSorted((left, right) =>
      left.label.localeCompare(right.label),
    );
  }, [oauthApps, toolkits]);
  const firstOAuthToolkit = oauthToolkits[0]?.value ?? "";
  const initialOAuthApp = oauthApps.find(
    ({ kind, toolkit }) => kind === "byo" && toolkit === firstOAuthToolkit,
  );
  const [oauthToolkit, setOAuthToolkit] = useState(firstOAuthToolkit);
  const [oauthClientId, setOAuthClientId] = useState(
    initialOAuthApp?.clientId ?? "",
  );
  const [oauthClientSecret, setOAuthClientSecret] = useState("");
  const [oauthScopes, setOAuthScopes] = useState(
    initialOAuthApp?.scopes.join("\n") ?? "",
  );
  const [oauthRedirectBase, setOAuthRedirectBase] = useState(
    initialOAuthApp?.redirectBase ?? "",
  );
  const actorPolicy = organizationMemberPolicy(organization.role);
  const manager = actorPolicy.canAdd;
  const selectedOAuthApp = oauthApps.find(
    ({ kind, toolkit }) => kind === "byo" && toolkit === oauthToolkit,
  );

  function resetFeedback() {
    setError(undefined);
    setNotice(undefined);
  }

  function selectOAuthToolkit(toolkit: string) {
    const app = oauthApps.find(
      (candidate) => candidate.kind === "byo" && candidate.toolkit === toolkit,
    );
    setOAuthToolkit(toolkit);
    setOAuthClientId(app?.clientId ?? "");
    setOAuthClientSecret("");
    setOAuthScopes(app?.scopes.join("\n") ?? "");
    setOAuthRedirectBase(app?.redirectBase ?? "");
  }

  async function renameOrganization(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    resetFeedback();
    setBusy("rename");
    try {
      const result = await dashboardCloudClient().updateOrganization(
        organization.id,
        { name: organizationName.trim() },
      );
      setOrganization((current) => ({
        ...current,
        ...result.organization,
        role: current.role,
      }));
      setNotice("Organization name updated.");
    } catch (caught) {
      const apiError = caught instanceof CloudApiError ? caught : undefined;
      setError({
        code: apiError?.code ?? "cloud_unavailable",
        message: apiError?.message ?? "The organization could not be renamed.",
      });
    } finally {
      setBusy(undefined);
    }
  }

  async function addMember(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    resetFeedback();
    setBusy("add-member");
    try {
      const result = await requestOrganizationMemberAddition(organization.id, {
        email: memberEmail.trim(),
        role: memberRole,
      });
      const member: CloudOrganizationMember = {
        ...result.membership,
        email: result.user.email,
      };
      setMembers((current) => [...current, member]);
      setMemberEmail("");
      setMemberRole("member");
      setNotice(`${member.email} added as ${member.role}.`);
    } catch (caught) {
      const apiError = caught instanceof CloudApiError ? caught : undefined;
      setError({
        code: apiError?.code ?? "cloud_unavailable",
        message:
          apiError?.message ?? "The organization member could not be added.",
      });
    } finally {
      setBusy(undefined);
    }
  }

  async function changeMemberRole(
    member: CloudOrganizationMember,
    role: AssignableRole,
  ) {
    if (!confirmOrganizationMemberRoleChange(member, role, window.confirm)) {
      setMembers((current) => [...current]);
      return;
    }
    resetFeedback();
    setBusy(`member:${member.userId}`);
    try {
      const result = await requestOrganizationMemberRoleChange(
        organization.id,
        member.userId,
        role,
      );
      setMembers((current) =>
        current.map((candidate) =>
          candidate.userId === member.userId
            ? { ...candidate, ...result.membership }
            : candidate,
        ),
      );
      setNotice(`${member.email} is now ${role}.`);
    } catch (caught) {
      const apiError = caught instanceof CloudApiError ? caught : undefined;
      setError({
        code: apiError?.code ?? "cloud_unavailable",
        message: apiError?.message ?? "The member role could not be changed.",
      });
    } finally {
      setBusy(undefined);
    }
  }

  async function removeMember(member: CloudOrganizationMember) {
    if (!confirmOrganizationMemberRemoval(member, window.confirm)) return;
    resetFeedback();
    setBusy(`member:${member.userId}`);
    try {
      await requestOrganizationMemberRemoval(organization.id, member.userId);
      setMembers((current) =>
        current.filter((candidate) => candidate.userId !== member.userId),
      );
      setNotice(`${member.email} removed from the organization.`);
    } catch (caught) {
      const apiError = caught instanceof CloudApiError ? caught : undefined;
      setError({
        code: apiError?.code ?? "cloud_unavailable",
        message: apiError?.message ?? "The member could not be removed.",
      });
    } finally {
      setBusy(undefined);
    }
  }

  async function saveOrigins(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    resetFeedback();
    const normalized = normalizeOAuthRedirectOrigins(originsText);
    if (normalized.origins === undefined) {
      setError({
        code: "invalid_redirect_origin",
        message: normalized.error ?? "Redirect origins are invalid.",
      });
      return;
    }
    setBusy("origins");
    try {
      const result = await dashboardCloudClient().updateOrganization(
        organization.id,
        { oauthRedirectOrigins: normalized.origins },
      );
      setOrganization((current) => ({
        ...current,
        ...result.organization,
        role: current.role,
      }));
      setOriginsText(result.organization.oauthRedirectOrigins.join("\n"));
      setNotice("OAuth return origins updated.");
    } catch (caught) {
      const apiError = caught instanceof CloudApiError ? caught : undefined;
      setError({
        code: apiError?.code ?? "cloud_unavailable",
        message: apiError?.message ?? "Redirect origins could not be updated.",
      });
    } finally {
      setBusy(undefined);
    }
  }

  async function saveOAuthApp(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    resetFeedback();
    if (oauthToolkit.length === 0) return;
    setBusy("oauth-app");
    try {
      const result = await dashboardCloudClient().putOAuthApp(
        organization.id,
        oauthAppRequest({
          toolkit: oauthToolkit,
          clientId: oauthClientId,
          clientSecret: oauthClientSecret,
          scopes: oauthScopes,
          redirectBase: oauthRedirectBase,
        }),
      );
      setOAuthApps((current) => {
        const exists = current.some(({ id }) => id === result.oauthApp.id);
        return exists
          ? current.map((app) =>
              app.id === result.oauthApp.id ? result.oauthApp : app,
            )
          : [...current, result.oauthApp];
      });
      setOAuthClientSecret("");
      setNotice(
        `${result.oauthApp.toolkit} OAuth app saved. Its client secret cannot be read back.`,
      );
    } catch (caught) {
      const apiError = caught instanceof CloudApiError ? caught : undefined;
      setError({
        code: apiError?.code ?? "cloud_unavailable",
        message: apiError?.message ?? "The OAuth app could not be saved.",
      });
    } finally {
      setBusy(undefined);
    }
  }

  return (
    <div className="page-stack organization-page">
      <PageHeader
        actions={
          <Link
            className="button button--secondary"
            href={`/${encodeURIComponent(project)}/audit`}
          >
            View audit log
            <Icon name="arrowRight" />
          </Link>
        }
        description="Manage organization identity, member access, provider OAuth applications, and the allowlist used for post-connect returns."
        eyebrow="Organization / Settings"
        title="Organization"
      />

      <nav aria-label="Organization sections" className="section-nav">
        <a href="#general">General</a>
        <a href="#members">Members</a>
        <a href="#oauth-apps">OAuth apps</a>
        <a href="#redirect-origins">Redirect origins</a>
      </nav>

      <InlineError error={error} />
      {notice ? (
        <div className="inline-success" role="status">
          <Icon name="check" />
          <p>{notice}</p>
        </div>
      ) : null}

      <section
        className="organization-section surface surface--raised"
        id="general"
      >
        <div className="organization-section__heading">
          <div>
            <p className="eyebrow">General</p>
            <h2>Organization profile</h2>
            <p>
              Name the workspace that owns billing, projects, and credentials.
            </p>
          </div>
          <span className={cn("role-chip", `role-chip--${organization.role}`)}>
            Your role: {roleLabel(organization.role)}
          </span>
        </div>
        <form
          className="organization-inline-form"
          onSubmit={renameOrganization}
        >
          <Input
            disabled={!manager}
            label="Organization name"
            onChange={(event) => setOrganizationName(event.currentTarget.value)}
            required
            value={organizationName}
          />
          <Input
            disabled
            hint="The organization slug is stable here; use the control API for a coordinated slug migration."
            label="Slug"
            mono
            value={organization.slug}
          />
          {manager ? (
            <Button
              disabled={busy !== undefined}
              type="submit"
              variant="primary"
            >
              {busy === "rename" ? "Saving…" : "Save name"}
            </Button>
          ) : null}
        </form>
      </section>

      <section
        className="organization-section surface surface--raised"
        id="members"
      >
        <div className="organization-section__heading">
          <div>
            <p className="eyebrow">Access</p>
            <h2>Members</h2>
            <p>
              Admins can add members. Only the owner can grant admin, change
              roles, or remove members; the owner row is immutable.
            </p>
          </div>
          <span className="organization-count mono">{members.length}</span>
        </div>
        {actorPolicy.canAdd ? (
          <form className="member-add-form" onSubmit={addMember}>
            <Input
              hint="The email must already belong to an Eyeball account."
              label="Member email"
              onChange={(event) => setMemberEmail(event.currentTarget.value)}
              placeholder="teammate@example.com"
              required
              type="email"
              value={memberEmail}
            />
            <Select
              hint={
                actorPolicy.canGrantAdmin
                  ? "Owners may grant member or admin."
                  : "Admins may add members only."
              }
              label="Role"
              onChange={(event) =>
                setMemberRole(event.currentTarget.value as AssignableRole)
              }
              options={
                actorPolicy.canGrantAdmin
                  ? [
                      { label: "Member", value: "member" },
                      { label: "Admin", value: "admin" },
                    ]
                  : [{ label: "Member", value: "member" }]
              }
              value={memberRole}
            />
            <Button
              disabled={busy !== undefined}
              type="submit"
              variant="primary"
            >
              {busy === "add-member" ? "Adding…" : "Add member"}
            </Button>
          </form>
        ) : null}
        <TableShell
          caption="Organization members and role controls"
          columns={[
            { key: "member", label: "Member" },
            { key: "role", label: "Role" },
            { key: "joined", label: "Joined (UTC)" },
            { key: "actions", label: "Actions" },
          ]}
        >
          {members.map((member) => {
            const policy = organizationMemberPolicy(
              organization.role,
              member.role,
            );
            const memberBusy = busy === `member:${member.userId}`;
            return (
              <tr key={member.userId}>
                <td>
                  <strong>{member.email}</strong>
                  <small className="table-subline mono">{member.userId}</small>
                </td>
                <td>
                  <span
                    className={cn("role-chip", `role-chip--${member.role}`)}
                  >
                    {roleLabel(member.role)}
                  </span>
                </td>
                <td className="mono">{dateLabel(member.createdAt)}</td>
                <td>
                  {policy.canManageTarget ? (
                    <span className="row-actions">
                      <select
                        aria-label={`Role for ${member.email}`}
                        className="field__control member-role-select"
                        disabled={memberBusy}
                        onChange={(event) =>
                          void changeMemberRole(
                            member,
                            event.currentTarget.value as AssignableRole,
                          )
                        }
                        value={member.role}
                      >
                        <option value="member">Member</option>
                        <option value="admin">Admin</option>
                      </select>
                      <Button
                        disabled={memberBusy}
                        onClick={() => void removeMember(member)}
                        size="small"
                        variant="danger"
                      >
                        {memberBusy ? "Working…" : "Remove"}
                      </Button>
                    </span>
                  ) : (
                    <span className="organization-guard">
                      {member.role === "owner"
                        ? "Protected owner"
                        : "Owner action required"}
                    </span>
                  )}
                </td>
              </tr>
            );
          })}
        </TableShell>
      </section>

      <section
        className="organization-section surface surface--raised"
        id="oauth-apps"
      >
        <div className="organization-section__heading">
          <div>
            <p className="eyebrow">Provider identity</p>
            <h2>Bring your own OAuth apps</h2>
            <p>
              An organization app overrides Eyeball’s shared app for that
              toolkit. Without one, hosted OAuth automatically falls back to the
              shared default when configured.
            </p>
          </div>
        </div>
        {oauthApps.length > 0 ? (
          <div className="oauth-app-list">
            {oauthApps.map((app) => (
              <article key={app.id}>
                <div>
                  <strong>{app.toolkit}</strong>
                  <span className="role-chip">{app.kind}</span>
                </div>
                <dl>
                  <div>
                    <dt>Client ID</dt>
                    <dd className="mono">{app.clientId}</dd>
                  </div>
                  <div>
                    <dt>Client secret</dt>
                    <dd>
                      {app.hasClientSecret
                        ? "Stored · never readable"
                        : "Not stored"}
                    </dd>
                  </div>
                  <div>
                    <dt>Redirect base</dt>
                    <dd className="mono">{app.redirectBase}</dd>
                  </div>
                  <div>
                    <dt>Scopes</dt>
                    <dd>
                      {app.scopes.length === 0
                        ? "Provider defaults"
                        : app.scopes.join(", ")}
                    </dd>
                  </div>
                </dl>
              </article>
            ))}
          </div>
        ) : (
          <div className="organization-empty">
            No organization OAuth apps. Shared provider apps remain the
            fallback.
          </div>
        )}
        {manager && oauthToolkits.length > 0 ? (
          <form className="oauth-app-form" onSubmit={saveOAuthApp}>
            <Select
              hint="Saving the same toolkit replaces its safe metadata and optionally its secret."
              label="Toolkit"
              onChange={(event) =>
                selectOAuthToolkit(event.currentTarget.value)
              }
              options={oauthToolkits}
              value={oauthToolkit}
            />
            <Input
              label="Client ID"
              mono
              onChange={(event) => setOAuthClientId(event.currentTarget.value)}
              required
              value={oauthClientId}
            />
            <Input
              autoComplete="new-password"
              hint={
                selectedOAuthApp?.hasClientSecret
                  ? "Write only. Leave blank to preserve the existing secret; it is never returned by the API."
                  : "Write only and required for a new organization app; it is never returned by the API."
              }
              label="Client secret"
              mono
              onChange={(event) =>
                setOAuthClientSecret(event.currentTarget.value)
              }
              placeholder="Enter a new secret"
              required={!selectedOAuthApp?.hasClientSecret}
              type="password"
              value={oauthClientSecret}
            />
            <label className="field">
              <span className="field__label">Scopes</span>
              <textarea
                className="field__control mono"
                onChange={(event) => setOAuthScopes(event.currentTarget.value)}
                placeholder={"read\nwrite"}
                rows={4}
                value={oauthScopes}
              />
              <span className="field__message">
                One scope per line or comma-separated.
              </span>
            </label>
            <Input
              hint="Provider redirect base registered for this client."
              label="Redirect base"
              mono
              onChange={(event) =>
                setOAuthRedirectBase(event.currentTarget.value)
              }
              placeholder="https://control.example.com/oauth/callback"
              required
              type="url"
              value={oauthRedirectBase}
            />
            <Button
              disabled={busy !== undefined}
              type="submit"
              variant="primary"
            >
              {busy === "oauth-app" ? "Saving…" : "Save or replace app"}
            </Button>
          </form>
        ) : null}
      </section>

      <section
        className="organization-section surface surface--raised"
        id="redirect-origins"
      >
        <div className="organization-section__heading">
          <div>
            <p className="eyebrow">OAuth return safety</p>
            <h2>Registered redirect origins</h2>
            <p>
              Optional connection return URLs must match one of these origins
              exactly. Paths are allowed on the return URL, but not in this
              origin allowlist.
            </p>
          </div>
        </div>
        <form className="redirect-origin-form" onSubmit={saveOrigins}>
          <label className="field">
            <span className="field__label">Allowed origins</span>
            <textarea
              className="field__control mono"
              disabled={!manager}
              onChange={(event) => setOriginsText(event.currentTarget.value)}
              placeholder={"https://app.example.com\nhttp://localhost:3000"}
              rows={5}
              value={originsText}
            />
            <span className="field__message">
              One exact HTTPS origin per line; loopback HTTP is allowed for
              local development.
            </span>
          </label>
          {manager ? (
            <Button
              disabled={busy !== undefined}
              type="submit"
              variant="primary"
            >
              {busy === "origins" ? "Saving…" : "Save origins"}
            </Button>
          ) : null}
        </form>
      </section>
    </div>
  );
}

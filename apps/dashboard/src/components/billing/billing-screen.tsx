"use client";

import { useState } from "react";
import { PageHeader } from "@/src/components/pages/page-header";
import { Button } from "@/src/components/ui/button";
import { Icon } from "@/src/components/ui/icon";
import {
  CloudApiError,
  type CloudBillingPlan,
  type CloudBillingView,
  type CloudOrganization,
  type CloudUsageView,
  dashboardCloudClient,
} from "@/src/lib/cloud-api";
import { cn } from "@/src/lib/cn";

export interface BillingMutationClient {
  createBillingCheckout(
    organizationId: string,
    plan: "pro" | "scale",
  ): Promise<{ checkout: { id: string; url: string } }>;
  createBillingPortal(organizationId: string): Promise<{ url: string }>;
}

const PLAN_RANK: Record<CloudBillingPlan["key"], number> = {
  free: 0,
  pro: 1,
  scale: 2,
  enterprise: 3,
};

export async function startBillingCheckout(
  organizationId: string,
  plan: "pro" | "scale",
  redirect: (url: string) => void,
  client: BillingMutationClient = dashboardCloudClient(),
): Promise<void> {
  const result = await client.createBillingCheckout(organizationId, plan);
  redirect(result.checkout.url);
}

export async function startBillingPortal(
  organizationId: string,
  redirect: (url: string) => void,
  client: BillingMutationClient = dashboardCloudClient(),
): Promise<void> {
  const result = await client.createBillingPortal(organizationId);
  redirect(result.url);
}

export function billingGraceLabel(
  graceEndsAt: string | null,
  now: string,
): string | undefined {
  if (graceEndsAt === null) return undefined;
  const end = Date.parse(graceEndsAt);
  const reference = Date.parse(now);
  if (!Number.isFinite(end) || !Number.isFinite(reference)) return undefined;
  const remaining = end - reference;
  if (remaining <= 0) return "Grace period ended";
  const days = Math.ceil(remaining / (24 * 60 * 60 * 1_000));
  return `${days} ${days === 1 ? "day" : "days"} left in grace period`;
}

function money(cents: number | null): string {
  if (cents === null) return "Custom";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: cents % 100 === 0 ? 0 : 2,
  }).format(cents / 100);
}

function countLabel(value: number | null): string {
  return value === null ? "Unlimited" : value.toLocaleString("en-US");
}

function monthLabel(value: string): string {
  const date = new Date(`${value}-01T00:00:00.000Z`);
  if (Number.isNaN(date.valueOf())) return value;
  return new Intl.DateTimeFormat("en", {
    month: "long",
    timeZone: "UTC",
    year: "numeric",
  }).format(date);
}

function periodLabel(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return value;
  return new Intl.DateTimeFormat("en", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
    year: "numeric",
  }).format(date);
}

function statusLabel(status: CloudBillingView["status"]): string {
  if (status === "past_due") return "Past due";
  return `${status.slice(0, 1).toUpperCase()}${status.slice(1)}`;
}

function UsageMeter({
  label,
  limit,
  percentage,
  used,
}: {
  label: string;
  limit: number | null;
  percentage: number | null;
  used: number;
}) {
  const meterValue = Math.min(100, Math.max(0, percentage ?? 0));
  return (
    <div className="usage-meter">
      <div className="usage-meter__header">
        <span>{label}</span>
        <strong className="mono">
          {used.toLocaleString("en-US")} / {countLabel(limit)}
        </strong>
      </div>
      <meter
        aria-label={`${label}: ${percentage === null ? "unlimited" : `${percentage}% used`}`}
        className={cn(
          "usage-meter__track",
          meterValue >= 90 && "usage-meter__track--warning",
        )}
        max={100}
        min={0}
        value={percentage === null ? 0 : meterValue}
      />
      <small>
        {percentage === null
          ? "No plan cap"
          : `${percentage.toLocaleString("en-US", { maximumFractionDigits: 1 })}% used`}
      </small>
    </div>
  );
}

function PlanCard({
  currentPlan,
  onUpgrade,
  owner,
  pendingPlan,
  plan,
}: {
  currentPlan: CloudBillingPlan;
  onUpgrade: (plan: "pro" | "scale") => void;
  owner: boolean;
  pendingPlan: string | undefined;
  plan: CloudBillingPlan;
}) {
  const current = currentPlan.key === plan.key;
  const canUpgrade =
    owner &&
    plan.selfServe &&
    (plan.key === "pro" || plan.key === "scale") &&
    PLAN_RANK[plan.key] > PLAN_RANK[currentPlan.key];
  return (
    <article
      className={cn("plan-card surface", current && "plan-card--current")}
    >
      <div className="plan-card__heading">
        <div>
          <h3>{plan.name}</h3>
          <p>
            <strong>{money(plan.baseMonthlyCents)}</strong>
            {plan.baseMonthlyCents === null ? null : <span> / month</span>}
          </p>
        </div>
        {current ? (
          <span className="plan-card__current">Current tier</span>
        ) : null}
      </div>
      <ul className="plan-card__features">
        <li>{countLabel(plan.included.executions)} executions included</li>
        <li>{countLabel(plan.included.connections)} connected accounts</li>
        <li>{countLabel(plan.included.projects)} projects</li>
      </ul>
      <div className="plan-card__overage">
        {plan.overage.executions ? (
          <p>
            +{money(plan.overage.executions.unitCents)} per{" "}
            {plan.overage.executions.unitSize.toLocaleString("en-US")} extra
            executions
          </p>
        ) : (
          <p>
            {plan.hardLimits ? "Hard usage caps" : "No metered execution rate"}
          </p>
        )}
        {plan.overage.connections ? (
          <p>
            +{money(plan.overage.connections.unitCents)} per{" "}
            {plan.overage.connections.unitSize === 1
              ? "extra connected account"
              : `${plan.overage.connections.unitSize.toLocaleString("en-US")} extra connected accounts`}
          </p>
        ) : null}
      </div>
      {canUpgrade ? (
        <Button
          disabled={pendingPlan !== undefined}
          onClick={() => onUpgrade(plan.key as "pro" | "scale")}
          variant="primary"
        >
          {pendingPlan === plan.key
            ? "Opening checkout…"
            : `Upgrade to ${plan.name}`}
        </Button>
      ) : current ? (
        <span className="plan-card__note">This plan is active.</span>
      ) : plan.key === "enterprise" ? (
        <span className="plan-card__note">
          Contact Eyeball for a custom plan.
        </span>
      ) : owner ? null : (
        <span className="plan-card__note">
          Only the owner can change plans.
        </span>
      )}
    </article>
  );
}

export interface BillingScreenProps {
  billing: CloudBillingView;
  now: string;
  organization: CloudOrganization;
  plans: readonly CloudBillingPlan[];
  usage: CloudUsageView;
}

export function BillingScreen({
  billing,
  now,
  organization,
  plans,
  usage,
}: BillingScreenProps) {
  const [pendingPlan, setPendingPlan] = useState<string>();
  const [portalPending, setPortalPending] = useState(false);
  const [error, setError] = useState<{ code: string; message: string }>();
  const owner = organization.role === "owner";
  const manager = owner || organization.role === "admin";
  const restricted =
    billing.restrictions.newApiKeys || billing.restrictions.newConnections;
  const grace = billingGraceLabel(billing.graceEndsAt, now);
  const overage = usage.projected.overage;

  async function upgrade(plan: "pro" | "scale") {
    setPendingPlan(plan);
    setError(undefined);
    try {
      await startBillingCheckout(organization.id, plan, (url) => {
        window.location.assign(url);
      });
    } catch (caught) {
      const apiError = caught instanceof CloudApiError ? caught : undefined;
      setError({
        code: apiError?.code ?? "cloud_unavailable",
        message: apiError?.message ?? "Stripe Checkout could not be opened.",
      });
      setPendingPlan(undefined);
    }
  }

  async function openPortal() {
    setPortalPending(true);
    setError(undefined);
    try {
      await startBillingPortal(organization.id, (url) => {
        window.location.assign(url);
      });
    } catch (caught) {
      const apiError = caught instanceof CloudApiError ? caught : undefined;
      setError({
        code: apiError?.code ?? "cloud_unavailable",
        message: apiError?.message ?? "The billing portal could not be opened.",
      });
      setPortalPending(false);
    }
  }

  return (
    <div className="page-stack billing-page">
      <PageHeader
        actions={
          billing.hasPaymentPortal && manager ? (
            <Button
              disabled={portalPending}
              onClick={() => void openPortal()}
              variant="secondary"
            >
              {portalPending ? "Opening portal…" : "Manage billing"}
              <Icon name="arrowRight" />
            </Button>
          ) : undefined
        }
        description={`Manage the ${organization.name} subscription, see current-month usage, and forecast metered charges before the UTC period closes.`}
        eyebrow="Organization / Billing"
        title="Billing & usage"
      />

      {error ? (
        <div className="inline-error" role="alert">
          <span className="taxonomy-badge taxonomy-badge--error">
            {error.code}
          </span>
          <p>{error.message}</p>
        </div>
      ) : null}

      {billing.status === "past_due" ? (
        <section
          className={cn(
            "billing-warning",
            restricted && "billing-warning--restricted",
          )}
          role="alert"
        >
          <Icon name="activity" />
          <div>
            <strong>
              {restricted
                ? "Payment grace period expired"
                : "Payment requires attention"}
            </strong>
            <p>
              {restricted
                ? "New API keys, connections, executions, and credential resolves are restricted until billing is repaired. Existing keys keep their identity and no data is deleted."
                : `${grace ?? "The 14-day grace period is active"}. Existing access continues, but new keys, connections, and executions will be restricted when grace ends.`}
            </p>
          </div>
        </section>
      ) : null}

      <section className="billing-overview-grid">
        <article className="current-plan-card surface surface--raised">
          <div className="current-plan-card__heading">
            <div>
              <p className="eyebrow">Current plan</p>
              <h2>{billing.plan.name}</h2>
            </div>
            <span
              className={cn(
                "billing-status",
                billing.status === "past_due" && "billing-status--warning",
                billing.status === "canceled" && "billing-status--neutral",
                restricted && "billing-status--restricted",
              )}
            >
              <span className="status-dot" />
              {statusLabel(billing.status)}
            </span>
          </div>
          <p className="current-plan-card__price">
            <strong>{money(billing.plan.baseMonthlyCents)}</strong>
            {billing.plan.baseMonthlyCents === null ? null : (
              <span> / month</span>
            )}
          </p>
          <dl className="billing-facts">
            <div>
              <dt>Billing period</dt>
              <dd>
                {periodLabel(billing.currentPeriod.start)} –{" "}
                {periodLabel(billing.currentPeriod.end)}
              </dd>
            </div>
            <div>
              <dt>Plan version</dt>
              <dd className="mono">v{billing.plan.version}</dd>
            </div>
            <div>
              <dt>Payment portal</dt>
              <dd>
                {billing.hasPaymentPortal ? "Available" : "Not yet available"}
              </dd>
            </div>
          </dl>
          {billing.plan.key === "free" && owner ? (
            <Button
              disabled={pendingPlan !== undefined}
              onClick={() => void upgrade("pro")}
              variant="primary"
            >
              {pendingPlan === "pro"
                ? "Opening checkout…"
                : "Upgrade from Free"}
              <Icon name="arrowRight" />
            </Button>
          ) : null}
        </article>

        <article className="usage-summary-card surface surface--raised">
          <div className="section-heading-row">
            <div>
              <p className="eyebrow">Current UTC month</p>
              <h2>{monthLabel(usage.month)}</h2>
            </div>
            <span className="mono">Live</span>
          </div>
          <UsageMeter
            label="Executions"
            limit={usage.limits.executions}
            percentage={usage.percentage.executions}
            used={usage.totals.executions}
          />
          <UsageMeter
            label="Connected accounts"
            limit={usage.limits.connections}
            percentage={usage.percentage.connections}
            used={usage.totals.connectionsPeak}
          />
          <div className="projection-line">
            <span>Projected executions</span>
            <strong className="mono">
              {usage.projected.executions.toLocaleString("en-US")}
            </strong>
          </div>
          <div className="projection-line">
            <span>Estimated overage at current rate</span>
            <strong>{money(overage.totalCents)}</strong>
          </div>
        </article>
      </section>

      <section className="usage-detail surface surface--raised">
        <div className="section-heading-row">
          <div>
            <p className="eyebrow">Usage detail</p>
            <h2>Dimension breakdown</h2>
          </div>
          <span className="usage-period-chip">
            {monthLabel(usage.month)} only
          </span>
        </div>
        <p className="section-intro">
          The control plane currently exposes the active UTC month, so
          historical month selection is not shown.
        </p>
        <div className="usage-dimensions">
          <article>
            <span>Executions</span>
            <strong className="mono">
              {usage.totals.executions.toLocaleString("en-US")}
            </strong>
            <small>
              {overage.executions.quantity.toLocaleString("en-US")} projected
              overage executions · {money(overage.executions.cents)}
            </small>
          </article>
          <article>
            <span>Connection peak</span>
            <strong className="mono">
              {usage.totals.connectionsPeak.toLocaleString("en-US")}
            </strong>
            <small>
              Projected peak:{" "}
              {usage.projected.connectionsPeak.toLocaleString("en-US")}.{" "}
              {overage.connections.quantity.toLocaleString("en-US")} projected
              overage connected accounts · {money(overage.connections.cents)}.
              The peak is the highest active connected-account snapshot observed
              this month, not a sum of daily connections.
            </small>
          </article>
          <article>
            <span>Projects</span>
            <strong className="mono">
              {usage.totals.projects.toLocaleString("en-US")}
            </strong>
            <small>
              Current organization project count ·{" "}
              {countLabel(usage.limits.projects)} plan limit
            </small>
          </article>
        </div>
      </section>

      <section className="plan-comparison">
        <div className="section-heading-row">
          <div>
            <p className="eyebrow">Plan comparison</p>
            <h2>Choose room to grow</h2>
          </div>
          {!owner ? (
            <span className="usage-period-chip">Owner approval required</span>
          ) : null}
        </div>
        <div className="plan-grid">
          {plans
            .toSorted(
              (left, right) => PLAN_RANK[left.key] - PLAN_RANK[right.key],
            )
            .map((plan) => (
              <PlanCard
                currentPlan={billing.plan}
                key={`${plan.key}:${plan.version}`}
                onUpgrade={(selection) => void upgrade(selection)}
                owner={owner}
                pendingPlan={pendingPlan}
                plan={plan}
              />
            ))}
        </div>
      </section>
    </div>
  );
}

import Link from "next/link";
import type { ReactNode } from "react";
import { ApertureLogo } from "@/src/components/shell/aperture-logo";
import { Badge } from "@/src/components/ui/badge";
import { StatusDot } from "@/src/components/ui/status-dot";
import type { CloudBillingView } from "@/src/lib/cloud-api";

interface BillingScreenProps {
  billing: CloudBillingView | undefined;
  organizationId: string | undefined;
}

function billingHref(organizationId?: string): string {
  return organizationId === undefined
    ? "/"
    : `/billing?org=${encodeURIComponent(organizationId)}`;
}

function BillingFrame({ children }: { children: ReactNode }) {
  return (
    <main className="onboarding-canvas billing-return-canvas">
      <section className="onboarding-card surface surface--raised">
        <div className="auth-brand">
          <ApertureLogo size={34} watching />
          <span>eyeball cloud</span>
        </div>
        {children}
      </section>
    </main>
  );
}

function BillingActions({
  organizationId,
}: {
  organizationId: string | undefined;
}) {
  return (
    <nav aria-label="Billing return actions" className="billing-return-actions">
      <Link
        className="button button--primary"
        href={billingHref(organizationId)}
      >
        View organization billing
      </Link>
      <Link className="button button--secondary" href="/">
        Return to project
      </Link>
    </nav>
  );
}

export function BillingCheckoutSuccessScreen({
  billing,
  checkoutSessionPresent,
  organizationId,
}: BillingScreenProps & { checkoutSessionPresent: boolean }) {
  if (billing === undefined) {
    return (
      <BillingFrame>
        <p className="eyebrow">Checkout return</p>
        <Badge status="pending" />
        <h1>We could not confirm this billing workspace.</h1>
        <p className="auth-card__lede">
          Your session is safe. Return to a project and open billing from an
          organization available to your account.
        </p>
        <BillingActions organizationId={undefined} />
      </BillingFrame>
    );
  }

  const active = billing.status === "active" && billing.plan.key !== "free";
  return (
    <BillingFrame>
      <p className="eyebrow">Checkout return</p>
      <Badge status={active ? "active" : "pending"} />
      <h1>
        {active
          ? `Your ${billing.plan.name} plan is active.`
          : "Your upgrade is processing."}
      </h1>
      <p className="auth-card__lede">
        {active
          ? "Stripe confirmed the subscription and Eyeball has applied the plan to this organization."
          : checkoutSessionPresent
            ? "Stripe returned your checkout session. Eyeball is waiting for the signed webhook to apply the plan; refresh billing in a moment."
            : "The checkout return did not include a session reference. Your current billing state is unchanged while Eyeball waits for Stripe."}
      </p>
      <BillingActions organizationId={organizationId} />
    </BillingFrame>
  );
}

export function BillingCheckoutCancelScreen({
  billing,
  organizationId,
}: BillingScreenProps) {
  const retryHref = billingHref(
    billing === undefined ? undefined : organizationId,
  );
  return (
    <BillingFrame>
      <p className="eyebrow">Checkout canceled</p>
      <span className="badge">
        <StatusDot tone="neutral" />
        Canceled
      </span>
      <h1>No charge was made.</h1>
      <p className="auth-card__lede">
        Stripe Checkout was closed before completion. Your current plan and
        usage remain unchanged.
      </p>
      <nav
        aria-label="Canceled checkout actions"
        className="billing-return-actions"
      >
        <Link className="button button--primary" href={retryHref}>
          Retry from billing
        </Link>
        <Link className="button button--secondary" href="/">
          Return to project
        </Link>
      </nav>
    </BillingFrame>
  );
}

export function BillingLandingScreen({
  billing,
  organizationId,
}: BillingScreenProps) {
  if (billing === undefined) {
    return (
      <BillingFrame>
        <p className="eyebrow">Organization billing</p>
        <h1>Billing workspace unavailable.</h1>
        <p className="auth-card__lede">
          Choose an organization from your current project context to continue.
        </p>
        <BillingActions organizationId={undefined} />
      </BillingFrame>
    );
  }

  return (
    <BillingFrame>
      <p className="eyebrow">Organization billing</p>
      {billing.status === "active" || billing.status === "free" ? (
        <Badge status="active" />
      ) : billing.status === "past_due" ? (
        <span className="badge badge--warning">
          <StatusDot tone="warning" />
          Past due
        </span>
      ) : (
        <span className="badge">
          <StatusDot tone="neutral" />
          Canceled
        </span>
      )}
      <h1>{billing.plan.name} plan</h1>
      <p className="auth-card__lede">
        This landing page confirms your organization billing state. Plan,
        invoice, payment-method, and detailed usage controls will live here.
      </p>
      <dl className="billing-return-summary">
        <div>
          <dt>Status</dt>
          <dd>{billing.status.replace("_", " ")}</dd>
        </div>
        <div>
          <dt>Current usage month</dt>
          <dd>{billing.usage.month}</dd>
        </div>
      </dl>
      <BillingActions organizationId={organizationId} />
    </BillingFrame>
  );
}

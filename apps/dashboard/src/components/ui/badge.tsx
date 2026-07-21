import { cn } from "@/src/lib/cn";
import { StatusDot, type StatusTone } from "./status-dot";

export type BadgeStatus =
  | "active"
  | "connected"
  | "expired"
  | "revoked"
  | "succeeded"
  | "failed"
  | "pending"
  | "needs_reauth"
  | "running"
  | "inactive"
  | "delivering"
  | "selecting"
  | "no_targets"
  | "partial"
  | "not_enqueued"
  | "admission_failed";

const statusPresentation: Record<
  BadgeStatus,
  { label: string; pulse?: boolean; tone: StatusTone }
> = {
  active: { label: "Active", tone: "success" },
  connected: { label: "Connected", tone: "success" },
  expired: { label: "Expired", tone: "warning" },
  revoked: { label: "Revoked", tone: "error" },
  succeeded: { label: "Succeeded", tone: "success" },
  failed: { label: "Failed", tone: "error" },
  pending: { label: "Pending", tone: "warning" },
  needs_reauth: { label: "Needs reauth", tone: "warning" },
  running: { label: "Running", pulse: true, tone: "accent" },
  inactive: { label: "Inactive", tone: "neutral" },
  delivering: { label: "Delivering", pulse: true, tone: "accent" },
  selecting: { label: "Selecting", pulse: true, tone: "accent" },
  no_targets: { label: "No targets", tone: "neutral" },
  partial: { label: "Partial", tone: "warning" },
  not_enqueued: { label: "Not enqueued", tone: "neutral" },
  admission_failed: { label: "Admission failed", tone: "error" },
};

export interface BadgeProps {
  className?: string;
  status: BadgeStatus;
}

export function Badge({ className, status }: BadgeProps) {
  const presentation = statusPresentation[status];
  return (
    <span className={cn("badge", `badge--${presentation.tone}`, className)}>
      <StatusDot pulse={presentation.pulse ?? false} tone={presentation.tone} />
      {presentation.label}
    </span>
  );
}

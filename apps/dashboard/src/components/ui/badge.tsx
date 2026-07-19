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
  | "running";

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

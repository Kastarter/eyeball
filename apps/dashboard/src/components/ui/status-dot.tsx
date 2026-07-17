import { cn } from "@/src/lib/cn";

export type StatusTone = "accent" | "success" | "warning" | "error" | "neutral";

export interface StatusDotProps {
  className?: string;
  pulse?: boolean;
  tone?: StatusTone;
}

export function StatusDot({
  className,
  pulse = false,
  tone = "neutral",
}: StatusDotProps) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "status-dot",
        `status-dot--${tone}`,
        pulse && "status-dot--pulse",
        className,
      )}
    />
  );
}

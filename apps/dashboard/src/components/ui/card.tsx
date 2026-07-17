import type { HTMLAttributes } from "react";
import { cn } from "@/src/lib/cn";

export interface SurfaceProps extends HTMLAttributes<HTMLDivElement> {
  tone?: "panel" | "raised" | "code";
}

export function Surface({
  children,
  className,
  tone = "panel",
  ...props
}: SurfaceProps) {
  return (
    <div
      className={cn(
        "surface",
        tone === "raised" && "surface--raised",
        tone === "code" && "surface--code",
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
}

export interface CardProps extends SurfaceProps {
  interactive?: boolean;
}

export function Card({
  children,
  className,
  interactive = false,
  ...props
}: CardProps) {
  return (
    <Surface
      className={cn("card", interactive && "card--interactive", className)}
      {...props}
    >
      {children}
    </Surface>
  );
}

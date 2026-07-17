import type { ReactNode } from "react";
import { cn } from "@/src/lib/cn";
import { Button } from "./button";
import { Icon } from "./icon";

export interface PanelProps {
  children: ReactNode;
  className?: string;
  description?: string;
  drawer?: boolean;
  onCloseLabel?: string;
  title: string;
}

export function Panel({
  children,
  className,
  description,
  drawer = false,
  onCloseLabel,
  title,
}: PanelProps) {
  return (
    <section
      aria-label={title}
      className={cn("panel", drawer && "panel--drawer", className)}
    >
      <header className="panel__header">
        <div>
          <h2 className="panel__title">{title}</h2>
          {description ? (
            <p className="panel__description">{description}</p>
          ) : null}
        </div>
        {onCloseLabel ? (
          <Button
            aria-label={onCloseLabel}
            icon={<Icon name="close" />}
            size="small"
            variant="ghost"
          >
            <span className="visually-hidden">{onCloseLabel}</span>
          </Button>
        ) : null}
      </header>
      <div className="panel__body">{children}</div>
    </section>
  );
}

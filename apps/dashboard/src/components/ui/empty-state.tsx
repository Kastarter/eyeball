import type { ReactNode } from "react";
import { CodeBlock } from "./code-block";
import { Icon } from "./icon";

export interface EmptyStateProps {
  actions?: ReactNode;
  code: string;
  description: string;
  title: string;
}

export function EmptyState({
  actions,
  code,
  description,
  title,
}: EmptyStateProps) {
  return (
    <section className="empty-state">
      <div>
        <span aria-hidden="true" className="empty-state__mark">
          <Icon name="terminal" />
        </span>
        <h2 className="empty-state__title">{title}</h2>
        <p className="empty-state__description">{description}</p>
        {actions ? <div className="empty-state__actions">{actions}</div> : null}
      </div>
      <div className="empty-state__code">
        <CodeBlock code={code} />
      </div>
    </section>
  );
}

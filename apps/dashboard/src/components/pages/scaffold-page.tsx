import { Button } from "@/src/components/ui/button";
import { EmptyState } from "@/src/components/ui/empty-state";
import { Icon } from "@/src/components/ui/icon";
import { Skeleton } from "@/src/components/ui/skeleton";
import type { RouteScaffoldContent } from "@/src/lib/route-content";
import { PageHeader } from "./page-header";

function GeometryPreview({ label }: { label: string }) {
  return (
    <section
      aria-label={`${label} loading preview`}
      className="geometry-preview"
    >
      <header className="geometry-preview__header">
        <div>
          <Skeleton height={16} label={`${label} title loading`} width={150} />
          <Skeleton height={12} label={`${label} detail loading`} width={230} />
        </div>
        <Skeleton height={34} label={`${label} action loading`} width={112} />
      </header>
      <div className="geometry-preview__filters">
        <Skeleton
          height={38}
          label={`${label} search loading`}
          width="min(100%, 360px)"
        />
        <Skeleton height={38} label={`${label} filter loading`} width={110} />
      </div>
      <div className="geometry-preview__rows">
        {["one", "two", "three"].map((row, index) => (
          <div className="geometry-preview__row" key={row}>
            <Skeleton
              height={index === 0 ? 13 : 12}
              label="Row content loading"
              width="34%"
            />
            <Skeleton height={12} label="Row metadata loading" width="18%" />
            <Skeleton height={24} label="Row status loading" width={82} />
          </div>
        ))}
      </div>
    </section>
  );
}

export function ScaffoldPage({ content }: { content: RouteScaffoldContent }) {
  return (
    <div className="page-stack">
      <PageHeader
        actions={
          <Button disabled icon={<Icon name="plus" />} variant="primary">
            {content.action}
          </Button>
        }
        description={content.description}
        eyebrow={content.eyebrow}
        title={content.title}
      />
      <GeometryPreview label={content.previewLabel} />
      <EmptyState
        actions={
          <span className="wiring-note">
            <StatusMarker /> Data wiring follows in tasks 31–32
          </span>
        }
        code={content.snippet}
        description={content.emptyDescription}
        title={content.emptyTitle}
      />
    </div>
  );
}

function StatusMarker() {
  return <span aria-hidden="true" className="wiring-note__marker" />;
}

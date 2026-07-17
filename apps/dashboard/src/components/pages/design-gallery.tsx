import Link from "next/link";
import type { ReactNode } from "react";
import { ApertureLogo } from "@/src/components/shell/aperture-logo";
import { ThemeToggle } from "@/src/components/shell/theme-toggle";
import {
  Badge,
  type BadgeStatus,
  Button,
  Card,
  CodeBlock,
  EmptyState,
  Icon,
  Input,
  Panel,
  Select,
  Skeleton,
  StatusDot,
  Surface,
  TableShell,
} from "@/src/components/ui";

function GallerySection({
  children,
  description,
  title,
}: {
  children: ReactNode;
  description: string;
  title: string;
}) {
  return (
    <section className="gallery-section">
      <header className="gallery-section__header">
        <h2>{title}</h2>
        <p>{description}</p>
      </header>
      {children}
    </section>
  );
}

const badgeStatuses: readonly BadgeStatus[] = [
  "connected",
  "expired",
  "revoked",
  "succeeded",
  "failed",
  "pending",
  "running",
];

const tokenSwatches = [
  ["Canvas", "var(--bg-canvas)"],
  ["Subtle", "var(--bg-subtle)"],
  ["Panel", "var(--bg-panel)"],
  ["Raised", "var(--bg-raised)"],
  ["Iris Violet", "var(--accent)"],
  ["Success", "var(--success)"],
  ["Warning", "var(--warning)"],
  ["Error", "var(--error)"],
] as const;

const codeSample = `const page = await executor.listExecutions({
  status: "running",
  limit: 25,
});

for (const execution of page.executions) {
  console.log(execution.executionId, execution.tool);
}`;

export function DesignGallery() {
  return (
    <div className="design-page">
      <header className="design-header">
        <div className="design-header__brand">
          <ApertureLogo label="eyeball is watching" size={34} watching />
          <div>
            <p className="eyebrow">Visual QA surface / 0.1</p>
            <h1>eyeball design system</h1>
          </div>
        </div>
        <div className="design-header__actions">
          <Link className="button button--secondary" href="/demo/overview">
            Open dashboard
            <Icon name="arrowRight" />
          </Link>
          <ThemeToggle />
        </div>
      </header>

      <main className="design-content">
        <div className="design-intro">
          <p>
            Dark-first, exact, and calm. Semantic tokens preserve the same
            hierarchy in both themes; Iris Violet appears only for action,
            focus, selection, and live eyeball-owned state.
          </p>
          <span className="mono">ADMIN-UI.md / component gallery</span>
        </div>

        <GallerySection
          description="Semantic roles, not page-specific color values. Toggle the theme to inspect both contracts."
          title="Tokens"
        >
          <div className="token-grid">
            {tokenSwatches.map(([label, value]) => (
              <div className="token-swatch" key={label}>
                <span
                  className="token-swatch__color"
                  style={{ background: value }}
                />
                <span>{label}</span>
                <code>{value}</code>
              </div>
            ))}
          </div>
        </GallerySection>

        <GallerySection
          description="One primary action per region, neutral supporting actions, quiet ghosts, and explicit danger."
          title="Buttons"
        >
          <div className="component-row">
            <Button icon={<Icon name="plus" />} variant="primary">
              Create key
            </Button>
            <Button variant="secondary">Inspect schema</Button>
            <Button variant="ghost">Cancel</Button>
            <Button variant="danger">Revoke key</Button>
            <Button disabled variant="primary">
              Creating…
            </Button>
            <Button size="small" variant="secondary">
              Compact
            </Button>
          </div>
        </GallerySection>

        <GallerySection
          description="Every state combines color with an exact label and a stable shape. Only live work pulses."
          title="Status badges and dots"
        >
          <div className="component-row">
            {badgeStatuses.map((status) => (
              <Badge key={status} status={status} />
            ))}
          </div>
          <div className="status-row">
            <span>
              <StatusDot tone="neutral" /> Idle
            </span>
            <span>
              <StatusDot tone="success" /> Ready
            </span>
            <span>
              <StatusDot tone="warning" /> Degraded
            </span>
            <span>
              <StatusDot tone="error" /> Failed
            </span>
            <span>
              <StatusDot pulse tone="accent" /> Watching
            </span>
          </div>
        </GallerySection>

        <GallerySection
          description="Layer changes and 1px boundaries carry structure; hover raises contrast without moving the card."
          title="Surfaces and cards"
        >
          <div className="surface-grid">
            <Card>
              <p className="eyebrow">Panel</p>
              <h3 className="section-title">Stable project context</h3>
              <p className="section-copy">
                Default grouping for content with one purpose.
              </p>
            </Card>
            <Card interactive tone="raised">
              <p className="eyebrow">Interactive</p>
              <h3 className="section-title mono">gmail.send_email</h3>
              <p className="section-copy">
                Raised contrast signals a selectable entity.
              </p>
            </Card>
            <Surface className="card" tone="code">
              <p className="eyebrow">Code surface</p>
              <h3 className="section-title mono">exe_7Q2D8A</h3>
              <p className="section-copy">
                A deeper tonal layer for technical inspection.
              </p>
            </Surface>
          </div>
        </GallerySection>

        <GallerySection
          description="Inset controls reserve validation space and use the same visible violet focus treatment."
          title="Inputs and selects"
        >
          <div className="form-grid">
            <Input
              defaultValue="user_123"
              hint="Maps to external_user_id."
              label="External user ID"
              mono
            />
            <Select
              defaultValue="production"
              hint="All dashboard data follows this context."
              label="Environment"
              options={[
                { label: "Development", value: "development" },
                { label: "Production", value: "production" },
              ]}
            />
            <Input
              error="Use a qualified dotted tool name."
              label="Canonical tool"
              mono
              value="gmail/send"
              readOnly
            />
          </div>
        </GallerySection>

        <GallerySection
          description="Sticky semantic headers, mono identity columns, calm row hover, and exact status language."
          title="Table shell"
        >
          <TableShell
            caption="Example executions"
            columns={[
              { key: "execution", label: "Execution" },
              { key: "tool", label: "Tool" },
              { key: "latency", label: "Latency" },
              { key: "status", label: "Status" },
            ]}
          >
            <tr>
              <td className="table__identity">exe_7Q2D8A</td>
              <td className="table__identity">gmail.send_email</td>
              <td className="mono">184ms</td>
              <td>
                <Badge status="succeeded" />
              </td>
            </tr>
            <tr>
              <td className="table__identity">exe_A81P2K</td>
              <td className="table__identity">notion.search_rows</td>
              <td className="mono">91ms</td>
              <td>
                <Badge status="running" />
              </td>
            </tr>
            <tr>
              <td className="table__identity">exe_F03K9L</td>
              <td className="table__identity">hubspot.create_contact</td>
              <td className="mono">2.1s</td>
              <td>
                <Badge status="failed" />
              </td>
            </tr>
          </TableShell>
        </GallerySection>

        <div className="gallery-split">
          <GallerySection
            description="Copy is a stable, keyboard-reachable action with inline confirmation."
            title="Code block"
          >
            <CodeBlock
              code={codeSample}
              label="Typed executor client example"
            />
          </GallerySection>

          <GallerySection
            description="Desktop drawers stay bounded; the same shell becomes full width below tablet size."
            title="Panel and drawer"
          >
            <Panel
              description="gmail / 12 canonical tools"
              drawer
              onCloseLabel="Close toolkit inspector"
              title="Toolkit inspector"
            >
              <div className="panel-demo">
                <div>
                  <span>Auth class</span>
                  <code>oauth2</code>
                </div>
                <div>
                  <span>Catalog version</span>
                  <code>1.1</code>
                </div>
                <Button size="small" variant="primary">
                  Enable toolkit
                </Button>
              </div>
            </Panel>
          </GallerySection>
        </div>

        <GallerySection
          description="Teaching states explain the next operational step and place runnable code beside the prose."
          title="Empty state"
        >
          <EmptyState
            actions={
              <Button disabled variant="primary">
                Create test link
              </Button>
            }
            code={`const link = await eb.connections.create({\n  userId: "user_123",\n  toolkit: "gmail",\n});`}
            description="Create a hosted connect link for one external user. Tokens never appear in the dashboard."
            title="No connected accounts"
          />
        </GallerySection>

        <GallerySection
          description="Skeletons preserve final geometry and never replace stable navigation."
          title="Skeleton loader"
        >
          <Surface className="skeleton-demo card">
            <Skeleton height={28} label="Metric value loading" width={110} />
            <Skeleton height={14} label="Metric label loading" width={180} />
            <div className="skeleton-stack">
              <Skeleton height={44} label="Table row loading" />
              <Skeleton height={44} label="Table row loading" />
              <Skeleton height={44} label="Table row loading" />
            </div>
          </Surface>
        </GallerySection>
      </main>
    </div>
  );
}

import { Button } from "@/src/components/ui/button";
import { CodeBlock } from "@/src/components/ui/code-block";
import { Icon } from "@/src/components/ui/icon";
import type { CatalogMetrics } from "@/src/lib/catalog";
import { ExecutorHealthCard } from "./executor-health";
import { PageHeader } from "./page-header";

const quickstart = `import { Eyeball } from "@eyeball/sdk";

const eb = new Eyeball({
  apiKey: process.env.EYEBALL_API_KEY!,
  baseUrl: process.env.EYEBALL_EXECUTOR_URL!,
});

await eb.connections.create({
  userId: "user_123",
  toolkit: "gmail",
});

await eb.tools.execute("gmail.send_email", {
  userId: "user_123",
  input: {
    to: ["agent@example.com"],
    subject: "Hello from eyeball",
    text: "Your first tool call is observable.",
  },
});`;

export function OverviewPage({ metrics }: { metrics: CatalogMetrics }) {
  return (
    <div className="page-stack">
      <PageHeader
        actions={
          <Button disabled icon={<Icon name="activity" />} variant="secondary">
            View live logs
          </Button>
        }
        description="The local capability catalog is ready now. Executor health is checked in the browser and degrades calmly when the wire API is unavailable."
        eyebrow="System pulse"
        title="Your agent surface is ready to inspect."
      />

      <section
        aria-label="Catalog and executor metrics"
        className="metric-band"
      >
        <div className="metric-card">
          <span className="metric-card__label">Toolkits</span>
          <strong className="metric-card__value mono">
            {metrics.toolkits}
          </strong>
          <span className="metric-card__detail">
            Materialized in catalog {metrics.version}
          </span>
        </div>
        <div className="metric-card">
          <span className="metric-card__label">Tools</span>
          <strong className="metric-card__value mono">{metrics.tools}</strong>
          <span className="metric-card__detail">
            Qualified, schema-backed operations
          </span>
        </div>
        <ExecutorHealthCard />
      </section>

      <section className="onboarding-surface">
        <div className="onboarding-surface__copy">
          <p className="eyebrow">First successful execution</p>
          <h2>Three exact steps, then every call is inspectable.</h2>
          <ol className="setup-steps">
            <li>
              <span>1</span>
              <div>
                <strong>Create a project key</strong>
                <p>Keep the reveal-once secret in trusted server code.</p>
              </div>
            </li>
            <li>
              <span>2</span>
              <div>
                <strong>Connect one external user</strong>
                <p>
                  The SDK userId becomes the control plane external_user_id.
                </p>
              </div>
            </li>
            <li>
              <span>3</span>
              <div>
                <strong>Run a canonical tool</strong>
                <p>
                  Use the execution ID to inspect normalized I/O and timing.
                </p>
              </div>
            </li>
          </ol>
        </div>
        <CodeBlock code={quickstart} label="Three-step SDK quickstart" />
      </section>
    </div>
  );
}

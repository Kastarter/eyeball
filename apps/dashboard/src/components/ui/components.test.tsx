import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ApertureLogo } from "@/src/components/shell/aperture-logo";
import { Badge, type BadgeStatus } from "./badge";
import { Button, type ButtonVariant } from "./button";
import { CodeBlock } from "./code-block";
import { EmptyState } from "./empty-state";
import { SecretRevealDialog } from "./secret-reveal-dialog";
import { TableShell } from "./table";
import { Tabs, tabDestinationIndex } from "./tabs";

describe("dashboard design system rendering", () => {
  it("renders every button variant with stable variant classes", () => {
    const variants: readonly ButtonVariant[] = [
      "primary",
      "secondary",
      "ghost",
      "danger",
    ];
    const markup = renderToStaticMarkup(
      <div>
        {variants.map((variant) => (
          <Button key={variant} variant={variant}>
            {variant}
          </Button>
        ))}
      </div>,
    );

    for (const variant of variants) {
      expect(markup).toContain(`button--${variant}`);
      expect(markup).toContain(`>${variant}</button>`);
    }
  });

  it("renders exact status labels and pulses only running work", () => {
    const statuses: readonly BadgeStatus[] = [
      "connected",
      "expired",
      "revoked",
      "succeeded",
      "failed",
      "pending",
      "running",
      "inactive",
      "delivering",
    ];
    const markup = renderToStaticMarkup(
      <div>
        {statuses.map((status) => (
          <Badge key={status} status={status} />
        ))}
      </div>,
    );

    for (const status of statuses) {
      const label = status.charAt(0).toUpperCase() + status.slice(1);
      expect(markup).toContain(label);
    }
    expect(markup.match(/status-dot--pulse/g)).toHaveLength(2);
  });

  it("renders controlled semantic tabs with one selected panel", () => {
    const markup = renderToStaticMarkup(
      <Tabs
        ariaLabel="Webhook endpoint"
        onValueChange={() => undefined}
        tabs={[
          { id: "settings", label: "Settings", content: <p>Settings panel</p> },
          {
            id: "deliveries",
            label: "Deliveries",
            content: <p>Deliveries panel</p>,
          },
        ]}
        value="settings"
      />,
    );

    expect(markup).toContain('role="tablist"');
    expect(markup.match(/role="tab"/g)).toHaveLength(2);
    expect(markup.match(/aria-selected="true"/g)).toHaveLength(1);
    expect(markup).toContain('role="tabpanel"');
    expect(markup).toContain("Settings panel");
    expect(markup).not.toContain("Deliveries panel");
    const selectedControl = markup.match(
      /aria-controls="([^"]+)" aria-selected="true"/u,
    )?.[1];
    expect(selectedControl).toBeDefined();
    expect(markup).toContain(`id="${selectedControl}"`);
  });

  it("calculates wrapped keyboard tab destinations", () => {
    expect(tabDestinationIndex("ArrowRight", 2, 3)).toBe(0);
    expect(tabDestinationIndex("ArrowLeft", 0, 3)).toBe(2);
    expect(tabDestinationIndex("Home", 2, 3)).toBe(0);
    expect(tabDestinationIndex("End", 0, 3)).toBe(2);
    expect(tabDestinationIndex("Space", 1, 3)).toBe(1);
  });

  it("renders a domain-neutral reveal-once secret dialog", () => {
    const markup = renderToStaticMarkup(
      <SecretRevealDialog
        acknowledgementLabel="I stored the signing secret"
        copyLabel="Copy signing secret"
        description="This signing secret is shown exactly once."
        onClose={() => undefined}
        secret="whsec_fixture_reveal_once"
        title="Store this signing secret"
        warning="It cannot be recovered after this dialog closes."
      />,
    );

    expect(markup).toContain("whsec_fixture_reveal_once");
    expect(markup).toContain("Copy signing secret");
    expect(markup).toContain("shown exactly once");
    expect(markup).toContain("cannot be recovered");
    expect(markup).toContain("I stored the signing secret");
  });

  it("renders semantic table structure and mono identity cells", () => {
    const markup = renderToStaticMarkup(
      <TableShell
        caption="Executions"
        columns={[
          { key: "id", label: "Execution" },
          { key: "status", label: "Status" },
        ]}
      >
        <tr>
          <td className="table__identity">exe_123</td>
          <td>
            <Badge status="succeeded" />
          </td>
        </tr>
      </TableShell>,
    );

    expect(markup).toContain("<table");
    expect(markup).toContain("<caption");
    expect(markup).toContain("table__identity");
    expect(markup).toContain("exe_123");
  });

  it("renders copyable teaching code inside an empty state", () => {
    const code = 'await eb.connections.create({ toolkit: "gmail" });';
    const markup = renderToStaticMarkup(
      <EmptyState
        code={code}
        description="Create one link."
        title="No connections"
      />,
    );

    expect(markup).toContain("No connections");
    expect(markup).toContain("Create one link.");
    expect(markup).toContain("Copy");
    expect(markup).toContain("eb.connections.create");
  });

  it("renders the aperture's explicit watching state", () => {
    const markup = renderToStaticMarkup(
      <ApertureLogo label="Watching" watching />,
    );

    expect(markup).toContain("aperture-logo--watching");
    expect(markup).toContain('aria-label="Watching"');
    expect(markup.match(/<path/g)?.length).toBeGreaterThanOrEqual(7);
  });

  it("renders code blocks with their language and source intact", () => {
    const markup = renderToStaticMarkup(
      <CodeBlock
        code="const tool = 'gmail.send_email';"
        language="typescript"
      />,
    );

    expect(markup).toContain("typescript");
    expect(markup).toContain("gmail.send_email");
    expect(markup).toContain("code-block__copy");
  });
});

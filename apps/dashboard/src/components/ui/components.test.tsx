import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ApertureLogo } from "@/src/components/shell/aperture-logo";
import { Badge, type BadgeStatus } from "./badge";
import { Button, type ButtonVariant } from "./button";
import { CodeBlock } from "./code-block";
import { EmptyState } from "./empty-state";
import { TableShell } from "./table";

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
    expect(markup.match(/status-dot--pulse/g)).toHaveLength(1);
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

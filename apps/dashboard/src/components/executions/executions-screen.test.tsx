import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ExecutionDetail, ExecutionRecord } from "@/src/lib/api";
import { ExecutionsScreen, executionCurl } from "./executions-screen";

const failedExecution = {
  catalogVersion: "2026.07.17",
  completedAt: "2026-07-17T09:00:00.145Z",
  createdAt: "2026-07-17T09:00:00.000Z",
  error: {
    code: "provider_rate_limited",
    message: "The upstream provider asked the executor to slow down.",
    provider: {
      toolkit: "gmail",
      status: 429,
      requestId: "provider_req_123",
      detail: { quota: "messages_per_minute" },
    },
    retryAfterSeconds: 12,
    retryable: true,
  },
  executionId: "exe_failed_123",
  latencyMs: 145,
  startedAt: "2026-07-17T09:00:00.010Z",
  status: "failed",
  tool: "gmail.send_email",
  toolVersion: "1.4.0",
  userId: "user_sam",
} as const satisfies ExecutionRecord;

const failedDetail = {
  ...failedExecution,
  connectionId: "conn_gmail_sam",
  idempotencyKey: "reservation-confirmation-123",
  input: {
    body: "Your table is confirmed.",
    subject: "Reservation confirmed",
    to: ["sam@example.com"],
  },
  mode: "sync",
  projectId: "restaurant-demo",
} as const satisfies ExecutionDetail;

describe("ExecutionsScreen server rendering", () => {
  it("renders the filterable execution table and pagination affordance", () => {
    const markup = renderToStaticMarkup(
      <ExecutionsScreen
        initialExecutions={[failedExecution]}
        initialFilters={{ status: "failed", tool: "gmail.send_email" }}
        initialNextCursor="cursor_next"
        project="restaurant-demo"
      />,
    );

    expect(markup).toContain("Executions");
    expect(markup).toContain("Project execution log");
    expect(markup).toContain("gmail.send_email");
    expect(markup).toContain("user_sam");
    expect(markup).toContain("exe_failed_123");
    expect(markup).toContain("Live refresh paused");
    expect(markup).toContain("Load more");
    expect(markup).toContain("Clear 2");
  });

  it("renders a deep-linked detail drawer with the canonical envelope", () => {
    const markup = renderToStaticMarkup(
      <ExecutionsScreen
        initialExecution={failedExecution.executionId}
        initialExecutionDetail={failedDetail}
        initialExecutions={[failedExecution]}
        project="restaurant-demo"
      />,
    );

    expect(markup).toContain("Execution detail");
    expect(markup).toContain("Canonical request");
    expect(markup).toContain("sam@example.com");
    expect(markup).toContain("provider_rate_limited");
    expect(markup).toContain("Provider detail");
    expect(markup).toContain("Retryable");
    expect(markup).toContain("reservation-confirmation-123");
    expect(markup).toContain("Authorization: Bearer &lt;REDACTED&gt;");
  });

  it("shell-quotes apostrophes in copied cURL request values", () => {
    const command = executionCurl({
      ...failedDetail,
      idempotencyKey: "Sam's-reservation",
      input: { ...failedDetail.input, body: "Sam's table is confirmed." },
    });

    expect(command).toContain(`Sam'"'"'s-reservation`);
    expect(command).toContain(`Sam'"'"'s table is confirmed.`);
    expect(command).toContain("Authorization: Bearer <REDACTED>");
  });
});

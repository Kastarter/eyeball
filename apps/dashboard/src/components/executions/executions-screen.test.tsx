import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ExecutionRecord } from "@/src/lib/api";
import { ExecutionsScreen } from "./executions-screen";

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
    retryAfter: 12,
    retryable: true,
  },
  executionId: "exe_failed_123",
  replayed: true,
  source: {
    kind: "voice_session",
    sessionId: "session/linked one",
  },
  attachments: {
    count: 2,
    fileIds: ["file_invoice_123", "file_receipt_456"],
  },
  latencyMs: 145,
  startedAt: "2026-07-17T09:00:00.010Z",
  status: "failed",
  tool: "gmail.send_email",
  toolVersion: "1.4.0",
  userId: "user_sam",
} as const satisfies ExecutionRecord;

describe("ExecutionsScreen server rendering", () => {
  it("renders the filterable execution table and pagination affordance", () => {
    const markup = renderToStaticMarkup(
      <ExecutionsScreen
        emptySnippet="fixture snippet"
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
    expect(markup).toContain("Replay");
  });

  it("renders a deep-linked detail drawer with the public execution record", () => {
    const markup = renderToStaticMarkup(
      <ExecutionsScreen
        emptySnippet="fixture snippet"
        initialExecution={failedExecution.executionId}
        initialExecutionDetail={failedExecution}
        initialExecutions={[failedExecution]}
        project="restaurant-demo"
      />,
    );

    expect(markup).toContain("Execution detail");
    expect(markup).toContain("provider_rate_limited");
    expect(markup).toContain("Provider detail");
    expect(markup).toContain("Retryable");
    expect(markup).toContain("12s");
    expect(markup).toContain("Execution context");
    expect(markup.match(/Replay/gu)).toHaveLength(2);
    expect(markup).toContain("Open voice session");
    expect(markup).toContain(
      "/restaurant-demo/voice-agents?session=session%2Flinked+one&amp;userId=user_sam",
    );
    expect(markup).toContain("2 distinct staged files");
    expect(markup.match(/file_invoice_123/gu)).toHaveLength(1);
    expect(markup.match(/file_receipt_456/gu)).toHaveLength(1);
    expect(markup).not.toContain("Canonical request");
    for (const privateSentinel of [
      "voice-session:session/linked one:event:4",
      "idempotency_hash_private",
      "canonical_input_private",
      "conn_private_selection",
      "base64_private_content",
      "raw_file_bytes_private",
      "invoice-private.pdf",
      "application/pdf",
    ]) {
      expect(markup).not.toContain(privateSentinel);
    }
  });
});

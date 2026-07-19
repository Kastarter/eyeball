import { describe, expect, it } from "vitest";
import { runExecutorBenchmark } from "./bench-executor.js";

describe("executor benchmark harness", () => {
  it("runs a 50-iteration CI-safe smoke suite and returns the report shape", async () => {
    const report = await runExecutorBenchmark({
      warmupIterations: 5,
      measuredIterations: 50,
      attachmentBytes: 1024 * 1024,
      captureVmStat: false,
      baselineDate: "2026-07-19",
    });

    expect(report).toMatchObject({
      schemaVersion: 1,
      baselineDate: "2026-07-19",
      methodology:
        "in-process app.request with in-process Mockhouse fetch injection",
      environment: {
        otelEnabledForBaseline: false,
        maxInFlight: 32,
        attachmentBytes: 1024 * 1024,
      },
      comparison: {
        syncExecuteP95Ms: expect.any(Number),
        rawMockP95Ms: expect.any(Number),
        estimatedAppLayerOverheadP95Ms: expect.any(Number),
      },
    });
    expect(report.scenarios.map(({ id }) => id)).toEqual([
      "health_http_floor",
      "raw_mock_gmail_send",
      "sync_execute_gmail_c1",
      "sync_idempotency_replay",
      "async_submit_poll_terminal",
      "sync_execute_1mb_attachment",
      "sync_execute_gmail_c8",
      "sync_execute_gmail_c32",
      "gmail_trigger_poll_tick",
      "webhook_delivery_attempt",
    ]);
    expect(report.scenarios).toHaveLength(10);
    for (const scenario of report.scenarios) {
      expect(scenario).toMatchObject({
        measuredIterations: 50,
        latencyMs: {
          p50: expect.any(Number),
          p95: expect.any(Number),
          p99: expect.any(Number),
          max: expect.any(Number),
        },
        throughputRps: expect.any(Number),
        rssBeforeBytes: expect.any(Number),
        rssAfterBytes: expect.any(Number),
        rssDeltaBytes: expect.any(Number),
        rssPeakBytes: expect.any(Number),
      });
      expect(scenario.rssPeakBytes).toBeLessThanOrEqual(
        report.environment.rssAbortBytes,
      );
    }
    expect(report.stageAttribution).toMatchObject({
      measuredIterations: 50,
      rootP50Microseconds: expect.any(Number),
      topCostCenter: expect.any(String),
    });
    expect(report.stageAttribution.stages.map(({ stage }) => stage)).toEqual([
      "validate",
      "idempotency",
      "credentials",
      "dispatch",
      "normalize",
      "store",
      "unattributed",
    ]);
    expect(report.vmStat.every(({ available }) => !available)).toBe(true);
  }, 120_000);
});

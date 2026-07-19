# Executor performance baseline

This document records the executor's application-layer baseline. It is a
measurement aid, not a deployment capacity claim or a CI performance gate. The
machine-readable report is
[`docs/perf/baseline-2026-07-19.json`](perf/baseline-2026-07-19.json).

## Methodology

The benchmark runs the executor Hono app through `app.request()` and injects
Mockhouse as an in-process `fetch` implementation. It opens no sockets and does
not include TCP, TLS, a reverse proxy, container scheduling, database I/O, or
provider network latency. The throughput figures are therefore upper bounds on
application-layer throughput for this machine; real deployments add transport
and provider costs. Latency figures likewise describe only the in-process path.

`scripts/bench-executor.ts` uses the same Mockhouse-backed in-process
composition as the development-stack test. Each scenario has 200 discarded
warmup iterations followed by 2,000 measured iterations. Concurrency is a
bounded Promise pool with at most 32 requests in flight. Fixtures, clocks, file
contents, execution IDs, and idempotency keys are deterministic. The runner:

- launches under `NODE_OPTIONS=--max-old-space-size=2048`;
- forces garbage collection between scenarios when `--expose-gc` is available;
- counts observable GC events during each measured phase;
- samples process RSS before, during, and after each scenario;
- aborts if RSS exceeds 1,572,864,000 bytes (1,500 MiB); and
- captures macOS `vm_stat` after every scenario.

The baseline path has OpenTelemetry exporters disabled (`EYEBALL_OTEL` is
unset). A separate attribution pass enables only an in-memory span exporter.
The committed run used Node.js 26.4.0 on macOS 25.0.0, an Apple M4 with 10 CPU
cores and 24 GiB RAM. The local in-memory attribution SDK was 2.2.0; see the
JSON report for the full environment and `vm_stat` snapshots.

The stock request limits would distort a 2,000-request run. The harness keeps
the same limiter implementation but supplies these explicit overrides:

| Setting | Benchmark value | Stock default |
| --- | ---: | ---: |
| `EYEBALL_RATE_LIMIT_REQUESTS_PER_MINUTE` | 1,000,000 | 120 |
| `EYEBALL_RATE_LIMIT_REQUEST_BURST` | 1,000,000 | 240 |
| `EYEBALL_RATE_LIMIT_EXECUTE_PER_MINUTE` | 1,000,000 | 60 |
| `EYEBALL_RATE_LIMIT_EXECUTE_BURST` | 1,000,000 | 120 |
| `EYEBALL_RATE_LIMIT_DAILY_EXECUTIONS` | `off` | `off` |

## Baseline

| Scenario | In flight | p50 ms | p95 ms | p99 ms | max ms | Throughput req/s | RSS delta MiB | RSS peak MiB | GC |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Health HTTP floor | 1 | 0.007 | 0.016 | 0.028 | 0.193 | 103,317.3 | +3.8 | 207.9 | 2 |
| Raw in-process Gmail mock call | 1 | 0.038 | 0.047 | 0.070 | 0.661 | 24,538.6 | +0.5 | 208.7 | 2 |
| Sync Gmail execute | 1 | 0.191 | 0.247 | 0.353 | 1.333 | 4,922.0 | +2.7 | 211.6 | 4 |
| Sync idempotency replay | 1 | 0.066 | 0.081 | 0.118 | 0.463 | 14,432.5 | +0.2 | 211.8 | 3 |
| Async submit + terminal poll | 1 | 0.243 | 0.302 | 0.530 | 1.530 | 3,942.4 | +0.8 | 212.7 | 4 |
| Sync Gmail execute + 1 MiB staged file | 1 | 10.586 | 13.875 | 15.187 | 17.273 | 90.8 | -25.3 | 472.6 | 185 |
| Sync Gmail execute | 8 | 1.371 | 1.731 | 1.873 | 2.524 | 5,473.6 | +5.5 | 405.5 | 3 |
| Sync Gmail execute | 32 | 5.174 | 5.773 | 6.459 | 7.116 | 5,934.3 | +1.8 | 407.3 | 3 |
| Gmail trigger poll tick | 1 | 0.155 | 0.178 | 0.220 | 0.511 | 6,326.2 | +0.0 | 407.6 | 3 |
| Signed webhook delivery attempt | 1 | 0.038 | 0.050 | 0.075 | 1.656 | 23,961.6 | +0.6 | 408.3 | 2 |

The raw Gmail call is a control request directly against the in-process mock.
Subtracting its p95 from the sync execute p95 estimates 0.200 ms of executor
application-layer overhead. It is an estimate rather than a stage-accurate
subtraction because the executor adapter constructs the provider request.

RSS stayed below the safety ceiling in every scenario. The 1 MiB attachment
path was the high-water mark at 472.6 MiB (31.5% of the ceiling) and caused 185
observed collections while repeatedly resolving and MIME/base64-encoding the
same staged bytes. Its negative measured-phase delta means transient buffers
were reclaimed before the ending sample; it does not mean the scenario used no
memory. The largest positive measured-phase delta was 5.5 MiB. The process was
204.7 MiB at the initial `vm_stat` snapshot and 446.1 MiB after the separate
traced attribution pass.

## Stage attribution

The attribution pass repeats sync Gmail execution at concurrency one with the
OpenTelemetry in-memory exporter. It reports the median duration for each named
stage across 2,000 measured traces. The root p50 was 200.3 microseconds.

| Stage | p50 µs | Share of root p50 |
| --- | ---: | ---: |
| Validate and materialize request | 28.7 | 14.3% |
| Idempotency hash and allocation | 14.1 | 7.1% |
| Credential resolution | 44.3 | 22.1% |
| Adapter dispatch + in-process mock HTTP | 54.2 | 27.1% |
| Output normalization | 6.5 | 3.2% |
| Store transitions | 8.2 | 4.1% |
| Unattributed root orchestration | 43.2 | 21.6% |

Adapter dispatch is the largest named cost center. Credential resolution is
second. `store` includes the nested resolved-connection write, which is removed
from the inclusive credential span to avoid double counting. `unattributed`
includes root-only orchestration, logging calls, and tracing overhead. The
columns use independent medians, so their shares need not sum to exactly 100%.

## Concurrency behavior

Gmail has no catalog semaphore cap, so the 1/8/32 sweep measures event-loop and
in-memory pipeline contention rather than semaphore queuing. Relative to one
in-flight request, throughput increased 11.2% at eight and 20.6% at 32, while
p95 per-request latency increased from 0.247 ms to 1.731 ms and 5.773 ms. On
this single Node.js process, additional in-flight work gives modest throughput
gains once the application path is saturated and trades those gains for much
higher request latency.

The stock HTTP rate limiter and toolkit concurrency limiter are process-local,
so these are single-instance figures. Horizontal application capacity comes
from replicas. Deployments that require global enforcement across replicas
must inject the documented asynchronous distributed `RateLimiter` and
distributed toolkit-concurrency seam; the stock in-memory implementations do
not coordinate across processes.

## Performance budget

The small sync-execute budget is **at most 1.0 ms p95 estimated in-process
application overhead over the raw mock call**. That threshold is five times the
measured 0.200 ms baseline, leaving room for ordinary workstation and runtime
variation while still surfacing an order-of-magnitude regression. The current
baseline meets the budget with 0.800 ms headroom. This budget is documented and
reviewed from committed measurements; tests assert report shape, not timing.

## Measured win

The first attribution run showed validation at 56.2 µs p50, tied with dispatch
as the dominant named stage. Inspection found two cache-defeating operations on
every request: `CatalogRegistry.getTool()` rematerialized, cloned, and
deep-froze an already immutable tool, and schema validation recomputed the full
schema fingerprint even for recursively frozen schemas. Materialized immutable
tool and trigger lookups are now cached and invalidated when the registry
changes. Validator identity caching now skips repeated fingerprints only for
recursively frozen schemas; mutable and shallow-frozen schemas preserve the
existing mutation check.

The before and after runs used the same machine, fixtures, 200/2,000 iteration
counts, concurrency, rate-limit overrides, and memory guards.

| Metric | Before | After | Change |
| --- | ---: | ---: | ---: |
| Validation stage p50 | 56.2 µs | 28.7 µs | -48.9% |
| Traced execution root p50 | 238.5 µs | 200.3 µs | -16.0% |
| Sync execute p50 | 0.221 ms | 0.191 ms | -13.6% |
| Sync execute p95 | 0.283 ms | 0.247 ms | -12.7% |
| Sync execute throughput | 4,287.7 req/s | 4,922.0 req/s | +14.8% |
| Idempotency replay p95 | 0.112 ms | 0.081 ms | -27.7% |

No other optimization was applied. Dispatch performs the requested adapter and
mock-provider work, and the remaining credential, store, and orchestration
costs did not expose another measured, obviously redundant hot-path operation.
Transport, durable-store, real-provider, multi-replica, and long-running soak
measurements remain future deployment work rather than changes justified by
this in-process baseline.

## Running the benchmark

Use a serial command and preserve the memory guard:

```sh
PATH=/opt/homebrew/bin:$PATH NODE_OPTIONS="--max-old-space-size=2048" pnpm bench
```

Optional CLI arguments are `--warmup=<count>`, `--iterations=<count>`,
`--date=YYYY-MM-DD`, `--output=<path>`, and `--vm-stat=off`. The CI-safe smoke
test uses 5 warmups and 50 measured iterations per scenario and validates only
the JSON report shape.

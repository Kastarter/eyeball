# @eyeball/core

## 0.3.0

### Minor Changes

- 25718c3: Add the paginated `StagedFilePage` contract and `eyeball.files.list` for unexpired project staged-file metadata.
- 52327e0: Add durable remote voice observation contracts, an executor-owned observer failure webhook, and structured retryable voice worker transport errors.
- 4a794d6: Add bounded execution provenance for accepted idempotent replays, verified voice-session sources, and distinct staged-file ID/count summaries. Raw idempotency keys and derivatives, canonical inputs, and file bytes remain private.
- b9fe8c6: Add a first-class cancelled execution lifecycle, `eyeball.executions.cancel`, distinct cancellation webhooks, and best-effort adapter abort propagation after provider dispatch.

### Patch Changes

- 07ec872: Add the non-retryable `execution_interrupted` error for conservatively recovered provider dispatches whose external outcome may be unknown.

## 0.2.0

### Minor Changes

- 6b7921d: Cut the first coordinated public-package source release at 0.2.0. Registry publication remains blocked until the `@eyeball` npm organization, final license approval, and release credentials are ready.

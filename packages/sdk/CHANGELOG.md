# @eyeball/sdk

## 0.3.0

### Minor Changes

- 25718c3: Add the paginated `StagedFilePage` contract and `eyeball.files.list` for unexpired project staged-file metadata.
- 52327e0: Add durable remote voice observation contracts, an executor-owned observer failure webhook, and structured retryable voice worker transport errors.
- 4a794d6: Add bounded execution provenance for accepted idempotent replays, verified voice-session sources, and distinct staged-file ID/count summaries. Raw idempotency keys and derivatives, canonical inputs, and file bytes remain private.
- b9fe8c6: Add a first-class cancelled execution lifecycle, `eyeball.executions.cancel`, distinct cancellation webhooks, and best-effort adapter abort propagation after provider dispatch.

### Patch Changes

- Updated dependencies [07ec872]
- Updated dependencies [25718c3]
- Updated dependencies [52327e0]
- Updated dependencies [4a794d6]
- Updated dependencies [b9fe8c6]
  - @eyeball/core@0.3.0
  - @eyeball/catalog@0.3.0

## 0.2.0

### Minor Changes

- 6b7921d: Cut the first coordinated public-package source release at 0.2.0. Registry publication remains blocked until the `@eyeball` npm organization, final license approval, and release credentials are ready.

### Patch Changes

- Updated dependencies [6b7921d]
  - @eyeball/core@0.2.0
  - @eyeball/catalog@0.2.0

# @eyeball/toolkits

## 0.3.0

### Minor Changes

- 21c2090: Make the public voice-agent and Twilio binding-store seams asynchronous so durable implementations can back agent revisions, number bindings, session pointers, and message receipts.
- 52327e0: Add durable remote voice observation contracts, an executor-owned observer failure webhook, and structured retryable voice worker transport errors.
- b9fe8c6: Add a first-class cancelled execution lifecycle, `eyeball.executions.cancel`, distinct cancellation webhooks, and best-effort adapter abort propagation after provider dispatch.

### Patch Changes

- Updated dependencies [07ec872]
- Updated dependencies [25718c3]
- Updated dependencies [52327e0]
- Updated dependencies [4a794d6]
- Updated dependencies [b9fe8c6]
  - @eyeball/core@0.3.0

## 0.2.0

### Minor Changes

- 6b7921d: Cut the first coordinated public-package source release at 0.2.0. Registry publication remains blocked until the `@eyeball` npm organization, final license approval, and release credentials are ready.

### Patch Changes

- Updated dependencies [6b7921d]
  - @eyeball/core@0.2.0

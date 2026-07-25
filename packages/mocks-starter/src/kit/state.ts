/** State that can participate in transactional control-plane operations. */
export interface SnapshotableState {
  reset(): void;
  snapshot(): unknown;
  restore(snapshot: unknown): void;
}

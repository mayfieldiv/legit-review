import { EventEmitter } from 'node:events';

// In-process event bus connecting store mutations and the git watcher to SSE
// subscribers (phase: live refresh). Keyed by canonical repo path.

export type ReviewEventType = 'diff-changed' | 'state-changed';

export interface ReviewEvent {
  type: ReviewEventType;
}

const bus = new EventEmitter();
bus.setMaxListeners(0);

export function emitReviewEvent(repoPath: string, event: ReviewEvent): void {
  bus.emit(repoPath, event);
}

export function subscribeReviewEvents(
  repoPath: string,
  listener: (event: ReviewEvent) => void
): () => void {
  bus.on(repoPath, listener);
  return () => {
    bus.off(repoPath, listener);
  };
}

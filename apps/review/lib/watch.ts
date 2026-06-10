import { emitReviewEvent } from './events';
import { computeRepoSignature } from './git';

// Refcounted per-repo pollers. While at least one SSE subscriber is connected
// for a repo, its signature is polled and a change emits `diff-changed` on
// the event bus. The poller stops when the last subscriber disconnects.

const DEFAULT_POLL_INTERVAL_MS = 1000;

interface RepoWatcher {
  refCount: number;
  timer: ReturnType<typeof setInterval>;
  lastSignature: string | null;
  polling: boolean;
}

const watchers = new Map<string, RepoWatcher>();

export function acquireRepoWatcher(
  repoPath: string,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS
): () => void {
  let watcher = watchers.get(repoPath);
  if (watcher == null) {
    const created: RepoWatcher = {
      refCount: 0,
      lastSignature: null,
      polling: false,
      timer: setInterval(() => {
        void poll(repoPath, created);
      }, pollIntervalMs),
    };
    watcher = created;
    watchers.set(repoPath, watcher);
  }
  watcher.refCount++;

  let released = false;
  return () => {
    if (released) {
      return;
    }
    released = true;
    const active = watchers.get(repoPath);
    if (active == null) {
      return;
    }
    active.refCount--;
    if (active.refCount <= 0) {
      clearInterval(active.timer);
      watchers.delete(repoPath);
    }
  };
}

async function poll(repoPath: string, watcher: RepoWatcher): Promise<void> {
  if (watcher.polling) {
    return;
  }
  watcher.polling = true;
  try {
    const signature = await computeRepoSignature(repoPath);
    if (watcher.lastSignature != null && signature !== watcher.lastSignature) {
      emitReviewEvent(repoPath, { type: 'diff-changed' });
    }
    watcher.lastSignature = signature;
  } catch {
    // Repo may be mid-operation (rebase, checkout); try again next tick.
  } finally {
    watcher.polling = false;
  }
}

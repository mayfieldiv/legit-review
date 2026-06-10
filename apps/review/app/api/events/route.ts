import { handleApiError, requireRepoIdentity } from '@/lib/api';
import { subscribeReviewEvents } from '@/lib/events';
import { acquireRepoWatcher } from '@/lib/watch';

export const dynamic = 'force-dynamic';

const HEARTBEAT_INTERVAL_MS = 30_000;

// Server-sent events for ?repo=: `diff-changed` when the working tree or
// HEAD changes (driven by the repo watcher) and `state-changed` when the
// review store mutates (comments, viewed marks) — including mutations made
// by an agent through the REST API.
export async function GET(request: Request) {
  try {
    const { repoPath } = await requireRepoIdentity(request);
    const encoder = new TextEncoder();
    let cleanup: (() => void) | undefined;

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const enqueue = (text: string) => {
          try {
            controller.enqueue(encoder.encode(text));
          } catch {
            // Controller already closed; cleanup follows via abort.
          }
        };

        const unsubscribe = subscribeReviewEvents(repoPath, (event) => {
          enqueue(`event: ${event.type}\ndata: {}\n\n`);
        });
        const releaseWatcher = acquireRepoWatcher(repoPath);
        const heartbeat = setInterval(() => {
          enqueue(': ping\n\n');
        }, HEARTBEAT_INTERVAL_MS);

        enqueue(': connected\n\n');
        cleanup = () => {
          unsubscribe();
          releaseWatcher();
          clearInterval(heartbeat);
        };
        request.signal.addEventListener(
          'abort',
          () => {
            cleanup?.();
            try {
              controller.close();
            } catch {
              // Already closed.
            }
          },
          { once: true }
        );
      },
      cancel() {
        cleanup?.();
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-store',
        Connection: 'keep-alive',
      },
    });
  } catch (error) {
    return handleApiError(error);
  }
}

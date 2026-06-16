import {
  createLocalDiffStream,
  GitRequestError,
  resolveCommitNeighbors,
  resolveReviewDiffSource,
  type ReviewDiffSource,
} from '@/lib/git';
import { recordRecentRepo } from '@/lib/store';

// Streams the local review patch for ?repo=<abs path>. The scope is chosen by
// the remaining params: &commit=<ref> (single commit), &from=&to= (commit
// range), or &base=<ref>/none (working-tree review against merge-base(base,
// HEAD), plus synthesized patches for untracked files). Source metadata rides
// along in X-Review-* headers (URI-encoded so non-ASCII repo paths and branch
// names survive HTTP).
export async function GET(request: Request) {
  const url = new URL(request.url);
  const repo = url.searchParams.get('repo');

  if (repo == null || repo === '') {
    return createTextResponse('repo query parameter is required', {
      status: 400,
    });
  }

  let source: ReviewDiffSource;
  try {
    source = await resolveReviewDiffSource(repo, {
      commit: url.searchParams.get('commit'),
      from: url.searchParams.get('from'),
      to: url.searchParams.get('to'),
      base: url.searchParams.get('base'),
    });
  } catch (error) {
    if (error instanceof GitRequestError) {
      return createTextResponse(error.message, { status: error.status });
    }
    return createTextResponse(
      error instanceof Error ? error.message : 'Unknown error',
      { status: 500 }
    );
  }
  try {
    await recordRecentRepo(source.repoPath, source.branch);
  } catch (error) {
    console.warn('Failed to record recent review repo', error);
  }

  return new Response(createLocalDiffStream(source), {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      // Never cached: working-tree review changes constantly, and range review
      // is cheap enough to re-stream.
      'Cache-Control': 'no-store',
      ...(await buildReviewHeaders(source)),
    },
  });
}

// Builds the X-Review-* headers the client parses into source info. Single
// commit mode also resolves prev/next neighbors so the header can offer the
// step-through controls without an extra round trip.
async function buildReviewHeaders(
  source: ReviewDiffSource
): Promise<Record<string, string>> {
  const headers: Record<string, string> = {
    'X-Review-Repo': encodeURIComponent(source.repoPath),
    'X-Review-Branch': encodeURIComponent(source.branch),
  };
  if (source.kind === 'working-tree') {
    headers['X-Review-Mode'] = 'working-tree';
    headers['X-Review-Base'] = encodeURIComponent(source.baseRef);
    return headers;
  }

  headers['X-Review-Mode'] = source.single ? 'single' : 'range';
  headers['X-Review-From'] = encodeURIComponent(source.fromRef);
  headers['X-Review-To'] = encodeURIComponent(source.toRef);
  headers['X-Review-From-Subject'] = encodeURIComponent(source.fromSubject);
  headers['X-Review-To-Subject'] = encodeURIComponent(source.toSubject);
  if (source.single) {
    const neighbors = await resolveCommitNeighbors(
      source.repoPath,
      source.toRef
    );
    headers['X-Review-Prev'] = neighbors.prevSha ?? '';
    headers['X-Review-Next'] = neighbors.nextSha ?? '';
  }
  return headers;
}

function createTextResponse(
  body: string,
  { status = 200 }: { status?: number } = {}
): Response {
  return new Response(body, {
    status,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

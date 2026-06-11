import {
  createLocalDiffStream,
  GitRequestError,
  resolveLocalDiffSource,
} from '@/lib/git';
import { recordRecentRepo } from '@/lib/store';

// Streams the local review patch for ?repo=<abs path>[&base=<ref>]: the
// tracked diff against merge-base(base, HEAD) plus synthesized patches for
// untracked files. Source metadata rides along in X-Review-* headers
// (URI-encoded so non-ASCII repo paths and branch names survive HTTP).
export async function GET(request: Request) {
  const url = new URL(request.url);
  const repo = url.searchParams.get('repo');
  const base = url.searchParams.get('base');

  if (repo == null || repo === '') {
    return createTextResponse('repo query parameter is required', {
      status: 400,
    });
  }

  let source;
  try {
    source = await resolveLocalDiffSource(repo, base);
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
      // Never cached: the working tree changes constantly.
      'Cache-Control': 'no-store',
      'X-Review-Repo': encodeURIComponent(source.repoPath),
      'X-Review-Branch': encodeURIComponent(source.branch),
      'X-Review-Base': encodeURIComponent(source.baseRef),
    },
  });
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

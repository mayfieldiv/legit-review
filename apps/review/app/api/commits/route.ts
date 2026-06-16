import { GitRequestError, listRepoCommits } from '@/lib/git';

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

// Lists commits newest-first along HEAD for ?repo=<abs path>, paged with
// &limit= and &skip=. Backs the commit picker (form + in-review switcher).
export async function GET(request: Request) {
  const url = new URL(request.url);
  const repo = url.searchParams.get('repo');

  if (repo == null || repo === '') {
    return createTextResponse('repo query parameter is required', {
      status: 400,
    });
  }

  const limit = clampInt(
    url.searchParams.get('limit'),
    DEFAULT_LIMIT,
    1,
    MAX_LIMIT
  );
  const skip = clampInt(
    url.searchParams.get('skip'),
    0,
    0,
    Number.MAX_SAFE_INTEGER
  );

  try {
    return Response.json(await listRepoCommits(repo, { limit, skip }), {
      headers: { 'Cache-Control': 'no-store' },
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
}

function clampInt(
  raw: string | null,
  fallback: number,
  min: number,
  max: number
): number {
  if (raw == null || raw === '') {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, parsed));
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

import { GitRequestError, resolveRepoReviewScopes } from '@/lib/git';

export async function GET(request: Request) {
  const url = new URL(request.url);
  const repo = url.searchParams.get('repo');

  if (repo == null || repo === '') {
    return createTextResponse('repo query parameter is required', {
      status: 400,
    });
  }

  try {
    return Response.json(await resolveRepoReviewScopes(repo), {
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

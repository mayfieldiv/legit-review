import { readFile } from 'node:fs/promises';
import path from 'node:path';

// Placeholder diff source: serves the bundled fixture patch so the viewer has
// something to render before the local `git diff` source lands. The response
// contract (streamable text/plain unified diff, no-store) matches what
// usePatchLoader expects and what the git-backed route will provide.
export async function GET() {
  const fixturePath = path.join(process.cwd(), 'fixtures', 'sample.diff');

  let patchText: string;
  try {
    patchText = await readFile(fixturePath, 'utf8');
  } catch {
    return createTextResponse('Fixture patch not found.', { status: 500 });
  }

  if (patchText.trim() === '') {
    return createTextResponse('Fixture patch is empty.', { status: 422 });
  }

  return createTextResponse(patchText);
}

function createTextResponse(
  body: string,
  { status = 200 }: { status?: number } = {}
): Response {
  return new Response(body, {
    status,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      // Diff responses are intentionally not cached so a refreshed page always
      // reflects the latest content from the source.
      'Cache-Control': 'no-store',
    },
  });
}

import { z } from 'zod';

import {
  ApiError,
  handleApiError,
  jsonResponse,
  parseJsonBody,
  requireRepoIdentity,
} from '@/lib/api';
import { emitReviewEvent } from '@/lib/events';
import {
  createLocalDiffStream,
  loadDiffFileContents,
  resolveLocalDiffSource,
} from '@/lib/git';
import { findHunkAnchorInPatch } from '@/lib/hunkHash';
import { createComment, readState } from '@/lib/store';

const sideSchema = z.enum(['deletions', 'additions']);

const createCommentSchema = z.object({
  filePath: z.string().min(1),
  side: sideSchema,
  range: z.object({
    start: z.number().int().min(1),
    side: sideSchema.optional(),
    end: z.number().int().min(1),
    endSide: sideSchema.optional(),
  }),
  lineSnippet: z.string().optional(),
  hunkHash: z.string().optional(),
  message: z.string().min(1),
  author: z.string().min(1).optional(),
});

const statusSchema = z.enum(['open', 'resolved', 'all']);

// Lists comments for ?repo='s current branch. ?status=open|resolved|all
// (default all) is the filter agents use to find unaddressed feedback.
export async function GET(request: Request) {
  try {
    const { repoPath, branch } = await requireRepoIdentity(request);
    const statusParam = new URL(request.url).searchParams.get('status');
    const status = statusSchema.catch('all').parse(statusParam ?? 'all');
    const state = await readState(repoPath, branch);
    const comments = state.comments.filter((comment) => {
      if (status === 'open') return !comment.resolved;
      if (status === 'resolved') return comment.resolved;
      return true;
    });
    return jsonResponse({ repoPath, branch, comments });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function POST(request: Request) {
  try {
    const { repoPath, branch } = await requireRepoIdentity(request);
    const input = await parseJsonBody(request, createCommentSchema);
    if (input.range.start > input.range.end) {
      throw new ApiError('range.start must be <= range.end', 400);
    }
    // The browser anchors comments itself: it hashes the rendered diff and
    // always sends hunkHash ('' when the line sits outside every hunk). REST
    // callers (agents posting review findings) only know path/side/line, so
    // when the field is absent the server anchors for them — and rejects
    // lines it cannot locate, so a wrong line number fails the request
    // instead of landing a comment on the wrong code. ?base= matches
    // /api/diff for reviews against a non-default base.
    if (input.hunkHash == null) {
      const base = new URL(request.url).searchParams.get('base');
      await anchorComment(repoPath, base, input);
    }
    const comment = await createComment(repoPath, branch, input);
    emitReviewEvent(repoPath, { type: 'state-changed' });
    return jsonResponse({ comment }, 201);
  } catch (error) {
    return handleApiError(error);
  }
}

// Fills in input.hunkHash/lineSnippet by locating the comment's line: first
// in the current review diff (in-hunk comments get the hunk's content hash
// for outdated tracking), then in the file's actual contents — comments on
// unchanged lines and unchanged files are valid and render as full-file
// views in the UI. Throws ApiError(422) with an actionable message when the
// line exists in neither, so agents correct their numbers and retry.
// Spawns git (diff + status + cat-file), which is acceptable on this
// agent-driven path but must not leak onto browser click paths.
async function anchorComment(
  repoPath: string,
  base: string | null,
  input: z.infer<typeof createCommentSchema>
): Promise<void> {
  const source = await resolveLocalDiffSource(repoPath, base);
  const patchText = await new Response(createLocalDiffStream(source)).text();
  const anchor = await findHunkAnchorInPatch(
    patchText,
    input.filePath,
    input.side,
    input.range.end
  );
  if (anchor != null) {
    input.hunkHash = anchor.hunkHash;
    input.lineSnippet ??= anchor.lineSnippet;
    return;
  }

  // Out-of-diff anchor: additions-side line numbers refer to the working
  // tree, deletions-side numbers to the merge-base blob (for an unchanged
  // file the two are identical).
  const [contents] = await loadDiffFileContents(source, [
    { path: input.filePath },
  ]);
  const sideContents =
    input.side === 'additions' ? contents?.newContents : contents?.oldContents;
  if (sideContents == null) {
    const location =
      input.side === 'additions'
        ? 'the working tree'
        : `the merge base (${source.mergeBase ?? 'no merge base'})`;
    throw new ApiError(
      `cannot anchor comment: ${input.filePath} is not readable as text in ${location}`,
      422
    );
  }
  const lines = splitFileLines(sideContents);
  if (input.range.end > lines.length) {
    throw new ApiError(
      `cannot anchor comment: line ${input.range.end} (${input.side}) is out of range for ${input.filePath} (${lines.length} lines)`,
      422
    );
  }
  input.hunkHash = '';
  input.lineSnippet ??= lines[input.range.end - 1];
}

// Splits file contents into lines without counting the empty string a
// trailing newline produces.
function splitFileLines(contents: string): string[] {
  const lines = contents.split('\n');
  if (lines.at(-1) === '') {
    lines.pop();
  }
  return lines;
}

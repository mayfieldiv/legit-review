import { z } from 'zod';

import {
  handleApiError,
  jsonResponse,
  parseJsonBody,
  requireRepoIdentity,
} from '@/lib/api';
import { emitReviewEvent } from '@/lib/events';
import { createLocalDiffStream, resolveLocalDiffSource } from '@/lib/git';
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
    // The browser anchors comments itself: it hashes the rendered diff and
    // always sends hunkHash ('' when the line sits outside every hunk). REST
    // callers (agents posting review findings) only know path/side/line, so
    // when the field is absent the server derives the anchor from the same
    // patch bytes the browser renders. ?base= matches /api/diff for reviews
    // against a non-default base.
    let warning: string | undefined;
    if (input.hunkHash == null) {
      const base = new URL(request.url).searchParams.get('base');
      warning = await anchorCommentToDiff(repoPath, base, input);
    }
    const comment = await createComment(repoPath, branch, input);
    emitReviewEvent(repoPath, { type: 'state-changed' });
    return jsonResponse(
      warning == null ? { comment } : { comment, warning },
      201
    );
  } catch (error) {
    return handleApiError(error);
  }
}

// Fills in input.hunkHash/lineSnippet from the current review diff, so
// server-anchored comments get the same outdated tracking as browser ones.
// Returns a warning message instead of throwing when anchoring fails: a
// review finding is worth saving even when it can't be tracked, and the
// warning tells the posting agent to re-check its line/side against the
// patch. Spawns git (diff + status), which is acceptable on this
// agent-driven path but must not leak onto browser click paths.
async function anchorCommentToDiff(
  repoPath: string,
  base: string | null,
  input: z.infer<typeof createCommentSchema>
): Promise<string | undefined> {
  try {
    const source = await resolveLocalDiffSource(repoPath, base);
    const patchText = await new Response(createLocalDiffStream(source)).text();
    const anchor = await findHunkAnchorInPatch(
      patchText,
      input.filePath,
      input.side,
      input.range.end
    );
    if (anchor == null) {
      return `line ${input.range.end} (${input.side}) is not part of the current diff for ${input.filePath}; comment saved without outdated tracking`;
    }
    input.hunkHash = anchor.hunkHash;
    input.lineSnippet ??= anchor.lineSnippet;
    return undefined;
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'unknown error';
    return `could not anchor comment to the diff (${reason}); comment saved without outdated tracking`;
  }
}

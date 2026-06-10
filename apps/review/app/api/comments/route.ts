import { z } from 'zod';

import {
  handleApiError,
  jsonResponse,
  parseJsonBody,
  requireRepoIdentity,
} from '@/lib/api';
import { emitReviewEvent } from '@/lib/events';
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
    const comment = await createComment(repoPath, branch, input);
    emitReviewEvent(repoPath, { type: 'state-changed' });
    return jsonResponse({ comment }, 201);
  } catch (error) {
    return handleApiError(error);
  }
}

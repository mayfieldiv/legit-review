import { z } from 'zod';

import {
  ApiError,
  handleApiError,
  jsonResponse,
  parseJsonBody,
  requireRepoIdentity,
} from '@/lib/api';
import { emitReviewEvent } from '@/lib/events';
import { addCommentReply } from '@/lib/store';

const createReplySchema = z.object({
  message: z.string().min(1),
  author: z.string().min(1).optional(),
});

interface RouteContext {
  params: Promise<{ id: string }>;
}

// Adds a reply to a comment's thread. Agents answer questions or explain
// their fix here ({"message": "...", "author": "<agent>"}), then resolve the
// root comment via PATCH /api/comments/:id. Returns the full updated comment
// so callers see the whole thread.
export async function POST(request: Request, context: RouteContext) {
  try {
    const { repoPath, branch } = await requireRepoIdentity(request);
    const { id } = await context.params;
    const input = await parseJsonBody(request, createReplySchema);
    const comment = await addCommentReply(repoPath, branch, id, input);
    if (comment == null) {
      throw new ApiError(`No comment with id ${id}`, 404);
    }
    emitReviewEvent(repoPath, { type: 'state-changed' });
    return jsonResponse({ comment }, 201);
  } catch (error) {
    return handleApiError(error);
  }
}

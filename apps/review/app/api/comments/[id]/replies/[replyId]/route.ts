import { z } from 'zod';

import {
  ApiError,
  handleApiError,
  jsonResponse,
  parseJsonBody,
  requireRepoIdentity,
} from '@/lib/api';
import { emitReviewEvent } from '@/lib/events';
import { deleteCommentReply, updateCommentReply } from '@/lib/store';

const updateReplySchema = z.object({
  message: z.string().min(1),
});

interface RouteContext {
  params: Promise<{ id: string; replyId: string }>;
}

// Edits a reply's message. Returns the full updated comment.
export async function PATCH(request: Request, context: RouteContext) {
  try {
    const { repoPath, branch } = await requireRepoIdentity(request);
    const { id, replyId } = await context.params;
    const input = await parseJsonBody(request, updateReplySchema);
    const comment = await updateCommentReply(
      repoPath,
      branch,
      id,
      replyId,
      input.message
    );
    if (comment == null) {
      throw new ApiError(`No reply ${replyId} on comment ${id}`, 404);
    }
    emitReviewEvent(repoPath, { type: 'state-changed' });
    return jsonResponse({ comment });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function DELETE(request: Request, context: RouteContext) {
  try {
    const { repoPath, branch } = await requireRepoIdentity(request);
    const { id, replyId } = await context.params;
    const comment = await deleteCommentReply(repoPath, branch, id, replyId);
    if (comment == null) {
      throw new ApiError(`No reply ${replyId} on comment ${id}`, 404);
    }
    emitReviewEvent(repoPath, { type: 'state-changed' });
    return new Response(null, { status: 204 });
  } catch (error) {
    return handleApiError(error);
  }
}

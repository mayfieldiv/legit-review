import { z } from 'zod';

import {
  ApiError,
  handleApiError,
  jsonResponse,
  parseJsonBody,
  requireRepoIdentity,
} from '@/lib/api';
import { emitReviewEvent } from '@/lib/events';
import { deleteComment, updateComment } from '@/lib/store';

const updateCommentSchema = z
  .object({
    message: z.string().min(1).optional(),
    resolved: z.boolean().optional(),
    resolvedBy: z.string().min(1).optional(),
  })
  .refine((value) => value.message != null || value.resolved != null, {
    message: 'Provide at least one field to update',
  });

interface RouteContext {
  params: Promise<{ id: string }>;
}

// Edits or resolves a comment. Agents resolve with
// {"resolved": true, "resolvedBy": "<agent>"} — the explanation of what was
// done belongs in a thread reply (POST /api/comments/:id/replies).
export async function PATCH(request: Request, context: RouteContext) {
  try {
    const { repoPath, branch } = await requireRepoIdentity(request);
    const { id } = await context.params;
    const input = await parseJsonBody(request, updateCommentSchema);
    const comment = await updateComment(repoPath, branch, id, input);
    if (comment == null) {
      throw new ApiError(`No comment with id ${id}`, 404);
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
    const { id } = await context.params;
    const deleted = await deleteComment(repoPath, branch, id);
    if (!deleted) {
      throw new ApiError(`No comment with id ${id}`, 404);
    }
    emitReviewEvent(repoPath, { type: 'state-changed' });
    return new Response(null, { status: 204 });
  } catch (error) {
    return handleApiError(error);
  }
}

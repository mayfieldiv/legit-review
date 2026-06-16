import { z } from 'zod';

import {
  ApiError,
  handleApiError,
  jsonResponse,
  parseJsonBody,
} from '@/lib/api';
import { loadDiffFileContents, resolveReviewDiffSource } from '@/lib/git';

const contentsRequestSchema = z.object({
  files: z
    .array(
      z.object({
        path: z.string().min(1),
        prevPath: z.string().min(1).optional(),
      })
    )
    .max(10_000),
});

// Full old/new contents for files in the review diff of ?repo=<abs path>
// (scope chosen by &commit=, &from=&to=, or &base=/none, matching /api/diff),
// so the client can expand unmodified context around hunks. For working-tree
// review the old side comes from the merge-base blob and the new side from the
// working tree; for range review both sides come from commit blobs. Either is
// null when not available as text (missing, binary, oversized, submodule).
export async function POST(request: Request) {
  try {
    const url = new URL(request.url);
    const repo = url.searchParams.get('repo');
    if (repo == null || repo === '') {
      throw new ApiError('repo query parameter is required', 400);
    }
    const input = await parseJsonBody(request, contentsRequestSchema);
    const source = await resolveReviewDiffSource(repo, {
      commit: url.searchParams.get('commit'),
      from: url.searchParams.get('from'),
      to: url.searchParams.get('to'),
      base: url.searchParams.get('base'),
    });
    const files = await loadDiffFileContents(source, input.files);
    const oldRef =
      source.kind === 'range' ? source.baseCommit : (source.mergeBase ?? null);
    return jsonResponse({ mergeBase: oldRef, files });
  } catch (error) {
    return handleApiError(error);
  }
}

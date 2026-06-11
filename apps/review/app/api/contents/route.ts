import { z } from 'zod';

import {
  ApiError,
  handleApiError,
  jsonResponse,
  parseJsonBody,
} from '@/lib/api';
import { loadDiffFileContents, resolveLocalDiffSource } from '@/lib/git';

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

// Full old/new contents for files in the review diff of ?repo=<abs
// path>[&base=<ref>], so the client can expand unmodified context around
// hunks. The old side comes from the merge-base blob, the new side from the
// working tree; either is null when not available as text (missing, binary,
// oversized, submodule).
export async function POST(request: Request) {
  try {
    const url = new URL(request.url);
    const repo = url.searchParams.get('repo');
    if (repo == null || repo === '') {
      throw new ApiError('repo query parameter is required', 400);
    }
    const input = await parseJsonBody(request, contentsRequestSchema);
    const source = await resolveLocalDiffSource(
      repo,
      url.searchParams.get('base')
    );
    const files = await loadDiffFileContents(source, input.files);
    return jsonResponse({ mergeBase: source.mergeBase ?? null, files });
  } catch (error) {
    return handleApiError(error);
  }
}

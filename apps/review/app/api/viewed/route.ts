import { z } from 'zod';

import {
  ApiError,
  handleApiError,
  jsonResponse,
  parseJsonBody,
  requireRepoIdentity,
} from '@/lib/api';
import { emitReviewEvent } from '@/lib/events';
import { setViewedMarks } from '@/lib/store';

const viewedSchema = z.object({
  filePath: z.string().min(1),
  viewed: z.boolean(),
  // Hunk-level marks to set or clear.
  hunkHashes: z.array(z.string().min(1)).nonempty().optional(),
  // File-level mark; required when marking a whole file viewed.
  fileHash: z.string().min(1).optional(),
});

// Sets or clears viewed marks. Hunk- and file-level marks for one file can be
// combined in a single request (the whole-file toggle sends both), and they
// apply as one store mutation. Unviewing always clears the file-level mark.
export async function PUT(request: Request) {
  try {
    const { repoPath, branch } = await requireRepoIdentity(request);
    const input = await parseJsonBody(request, viewedSchema);
    if (input.viewed && input.hunkHashes == null && input.fileHash == null) {
      throw new ApiError(
        'hunkHashes or fileHash is required to mark viewed',
        400
      );
    }

    const state = await setViewedMarks(repoPath, branch, input.filePath, {
      viewed: input.viewed,
      hunkHashes: input.hunkHashes,
      fileHash: input.fileHash,
    });

    emitReviewEvent(repoPath, { type: 'state-changed' });
    return jsonResponse({
      viewedFiles: state.viewedFiles,
      viewedHunks: state.viewedHunks,
    });
  } catch (error) {
    return handleApiError(error);
  }
}

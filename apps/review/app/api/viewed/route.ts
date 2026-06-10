import { z } from 'zod';

import {
  ApiError,
  handleApiError,
  jsonResponse,
  parseJsonBody,
  requireRepoIdentity,
} from '@/lib/api';
import { emitReviewEvent } from '@/lib/events';
import { setFileViewed, setHunksViewed } from '@/lib/store';

const viewedSchema = z.object({
  filePath: z.string().min(1),
  viewed: z.boolean(),
  // Hunk-level marks. When present, fileHash is ignored.
  hunkHashes: z.array(z.string().min(1)).nonempty().optional(),
  // File-level mark; required when marking a file viewed (viewed: true).
  fileHash: z.string().min(1).optional(),
});

// Sets or clears viewed marks for hunks or a whole file.
export async function PUT(request: Request) {
  try {
    const { repoPath, branch } = await requireRepoIdentity(request);
    const input = await parseJsonBody(request, viewedSchema);

    let state;
    if (input.hunkHashes != null) {
      state = await setHunksViewed(
        repoPath,
        branch,
        input.filePath,
        input.hunkHashes,
        input.viewed
      );
    } else {
      if (input.viewed && input.fileHash == null) {
        throw new ApiError('fileHash is required to mark a file viewed', 400);
      }
      state = await setFileViewed(
        repoPath,
        branch,
        input.filePath,
        input.viewed ? (input.fileHash as string) : null
      );
    }

    emitReviewEvent(repoPath, { type: 'state-changed' });
    return jsonResponse({
      viewedFiles: state.viewedFiles,
      viewedHunks: state.viewedHunks,
    });
  } catch (error) {
    return handleApiError(error);
  }
}

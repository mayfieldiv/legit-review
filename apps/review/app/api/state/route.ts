import { handleApiError, jsonResponse, requireRepoIdentity } from '@/lib/api';
import { reconcileCommentRenames } from '@/lib/commentRenames';
import { emitReviewEvent } from '@/lib/events';
import { readState } from '@/lib/store';

// Full review state (comments + viewed marks) for ?repo='s current branch.
// Comments whose file was renamed since they were written are remapped to
// the file's current path before the state is served.
export async function GET(request: Request) {
  try {
    const { repoPath, branch } = await requireRepoIdentity(request);
    const { state, changed } = await reconcileCommentRenames(
      repoPath,
      branch,
      await readState(repoPath, branch)
    );
    if (changed) {
      emitReviewEvent(repoPath, { type: 'state-changed' });
    }
    return jsonResponse(state);
  } catch (error) {
    return handleApiError(error);
  }
}

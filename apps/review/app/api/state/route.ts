import { handleApiError, jsonResponse, requireRepoIdentity } from '@/lib/api';
import { readState } from '@/lib/store';

// Full review state (comments + viewed marks) for ?repo='s current branch.
export async function GET(request: Request) {
  try {
    const { repoPath, branch } = await requireRepoIdentity(request);
    return jsonResponse(await readState(repoPath, branch));
  } catch (error) {
    return handleApiError(error);
  }
}

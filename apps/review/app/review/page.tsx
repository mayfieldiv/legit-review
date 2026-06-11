import { RepoHome } from '../_components/RepoHome';
import { ReviewUI } from '../_components/ReviewUI';

interface ReviewPageSearchParams {
  base?: string | string[];
  repo?: string | string[];
}

// Local branch review viewer. ?repo= is the absolute path of the repository
// to review; ?base= optionally overrides the base ref (defaults to the remote
// default branch, then main/master, then HEAD).
export default async function ReviewPage({
  searchParams,
}: {
  searchParams: Promise<ReviewPageSearchParams>;
}) {
  const { repo, base } = await searchParams;
  const repoPath = firstParam(repo);
  const baseRef = firstParam(base);

  if (repoPath == null || repoPath === '') {
    return <RepoHome />;
  }

  return (
    <div className="flex h-dvh flex-col gap-2">
      <ReviewUI base={baseRef} repo={repoPath} />
    </div>
  );
}

function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

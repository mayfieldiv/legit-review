import { RepoHome } from '../_components/RepoHome';
import { ReviewUI } from '../_components/ReviewUI';

interface ReviewPageSearchParams {
  base?: string | string[];
  commit?: string | string[];
  from?: string | string[];
  to?: string | string[];
  repo?: string | string[];
}

// Local branch review viewer. ?repo= is the absolute path of the repository to
// review. The scope is chosen by the remaining params: ?commit= reviews a
// single commit, ?from=&to= reviews a commit range, and ?base= (or none)
// reviews the working tree against the base ref (defaults to the remote
// default branch, then main/master, then HEAD).
export default async function ReviewPage({
  searchParams,
}: {
  searchParams: Promise<ReviewPageSearchParams>;
}) {
  const { repo, base, commit, from, to } = await searchParams;
  const repoPath = firstParam(repo);

  if (repoPath == null || repoPath === '') {
    return <RepoHome />;
  }

  return (
    <div className="flex h-dvh flex-col gap-2">
      <ReviewUI
        base={firstParam(base)}
        commit={firstParam(commit)}
        from={firstParam(from)}
        to={firstParam(to)}
        repo={repoPath}
      />
    </div>
  );
}

function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

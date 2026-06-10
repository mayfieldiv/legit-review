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
    return <RepoPicker />;
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

// Minimal entry form shown when no repo is selected. Submits via GET so the
// resulting viewer URL is shareable/bookmarkable.
function RepoPicker() {
  return (
    <div className="flex h-dvh items-center justify-center p-6">
      <form action="/review" method="get" className="w-full max-w-xl space-y-4">
        <h1 className="text-lg font-semibold">Pierre Review</h1>
        <p className="text-muted-foreground text-sm">
          Review the current branch of a local repository: working-tree changes
          (including untracked files) against the merge base with the default
          branch.
        </p>
        <label className="block space-y-1">
          <span className="text-sm font-medium">Repository path</span>
          <input
            autoFocus
            className="border-input bg-background block h-9 w-full rounded-md border px-3 font-mono text-sm focus-visible:outline-none"
            name="repo"
            placeholder="/absolute/path/to/repo"
            required
            type="text"
          />
        </label>
        <label className="block space-y-1">
          <span className="text-sm font-medium">
            Base ref{' '}
            <span className="text-muted-foreground font-normal">
              (optional, defaults to the default branch)
            </span>
          </span>
          <input
            className="border-input bg-background block h-9 w-full rounded-md border px-3 font-mono text-sm focus-visible:outline-none"
            name="base"
            placeholder="main"
            type="text"
          />
        </label>
        <button
          className="bg-primary text-primary-foreground h-9 rounded-md px-4 text-sm font-medium"
          type="submit"
        >
          Review
        </button>
      </form>
    </div>
  );
}

// Builds `/review` URLs for each review scope so the form, the in-review
// switcher, and keyboard navigation all produce identical links.

export function singleCommitReviewHref(repo: string, sha: string): string {
  return `/review?${new URLSearchParams({ repo, commit: sha })}`;
}

export function commitRangeReviewHref(
  repo: string,
  from: string,
  to: string
): string {
  return `/review?${new URLSearchParams({ repo, from, to })}`;
}

export function workingTreeReviewHref(
  repo: string,
  base?: string | null
): string {
  const params = new URLSearchParams({ repo });
  if (base != null && base !== '') {
    params.set('base', base);
  }
  return `/review?${params}`;
}

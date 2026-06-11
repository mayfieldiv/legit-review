# Pierre Review

Local, browser-based code review for the branch you're on. Point it at any
repository on disk and review the working tree (including untracked files)
against the merge base with the default branch — no GitHub, no remotes.

Built from the diffshub shell: same `@pierre/diffs` rendering, file tree,
themes, and streaming patch pipeline, with the GitHub data source replaced by
local git and a durable review store.

## Run

```bash
bun ws review dev   # http://127.0.0.1:3693 (port shifts with PIERRE_PORT_OFFSET)
```

Open `/review?repo=/absolute/path/to/repo` (or use the picker at `/`). Optional
`&base=<ref>` overrides the base ref; the default is the remote default branch,
then `main`/`master`, then `HEAD` (working-tree-only review).

## What it does

- **Inline comments** — click the `+` gutter button on any line. Comments
  persist to disk and survive restarts.
- **Comments beyond the diff** — comments aren't limited to changed lines:
  unchanged lines and entirely unchanged files host them too. Files outside the
  diff that have comments render as plain full-file views with the comment cards
  inline.
- **Reply threads** — every comment is a GitHub-style conversation: replies,
  in-place edit/delete on each message, and a Resolve/Unresolve conversation
  footer. Resolving can include a `resolutionNote`, which appears as a special
  resolved event in the thread. Open threads default expanded; resolved threads
  default collapsed.
- **Viewed marks** — a Viewed pill per hunk and a Viewed checkbox per file.
  Fully-viewed files auto-collapse. Marks are stored under content hashes of the
  hunk text, so when code changes the affected hunk pops back open on its own;
  untouched hunks stay collapsed.
- **Outdated detection** — a comment whose anchor hunk's content changed is
  badged "Outdated" automatically.
- **Expandable context** — labeled expanders on hunk separators ("5 lines", "All
  n lines") reveal the unmodified lines above/below/between hunks. After the
  diff streams in, the client fetches both full file sides
  (`POST /api/contents`) and re-parses each file's patch with them attached;
  files whose contents can't be paired (binary, oversized, mid-edit drift)
  simply keep the plain diff.
- **Live refresh** — a per-repo watcher fingerprints HEAD + working tree every
  second while the page is open; edits reload the diff in place (scroll
  preserved), and store mutations stream to the browser over SSE.

## State

One JSON file per repo+branch under
`~/.local/share/pierre-review/<sha1(repo)>/<branch>.json` (override the root
with `PIERRE_REVIEW_DATA_DIR`). Nothing is written into the reviewed repository.
Branches are isolated; switching branches switches review state.

## Agent API

Loopback-only REST, keyed by `?repo=<absolute path>`:

| Endpoint                                       | Purpose                                                                         |
| ---------------------------------------------- | ------------------------------------------------------------------------------- |
| `GET /api/state`                               | Full review state (comments + viewed marks)                                     |
| `GET /api/comments?status=open\|resolved\|all` | List comments (each carries its `replies`)                                      |
| `POST /api/comments`                           | Create a comment (omit `hunkHash` and the server anchors it; 422 on bad lines)  |
| `PATCH /api/comments/:id`                      | Edit / resolve (`{"resolved":true,"resolvedBy":"claude","resolutionNote":"…"}`) |
| `DELETE /api/comments/:id`                     | Delete the thread                                                               |
| `POST /api/comments/:id/replies`               | Reply (`{"message":"…","author":"claude"}`)                                     |
| `PATCH /api/comments/:id/replies/:replyId`     | Edit a reply's message                                                          |
| `DELETE /api/comments/:id/replies/:replyId`    | Delete a reply                                                                  |
| `PUT /api/viewed`                              | Set/clear viewed marks (hunk- and/or file-level, one call)                      |
| `GET /api/events`                              | SSE: `diff-changed`, `state-changed`                                            |
| `GET /api/diff`                                | The unified diff the viewer renders                                             |
| `POST /api/contents`                           | Full old/new contents for diffed files (context expansion)                      |

When `POST /api/comments` is called without a `hunkHash` (the browser always
sends one), the server anchors the comment itself: a line inside a diff hunk
gets the hunk's content hash (same Outdated tracking as browser comments), a
line outside the diff is validated against the file's actual contents (working
tree for `additions`, merge-base blob for `deletions`) and anchored by its line
text. A line that exists in neither is rejected with `422` and an actionable
message — the comment is NOT saved, so a caller with wrong line numbers can
correct them against `GET /api/diff` and retry instead of a comment landing on
the wrong code.

A Claude Code skill for the agent workflows (resolving comments, posting review
findings) lives at `~/.agents/mayfield-skills/global/local-review/SKILL.md` (not
part of this repo).

## Tests

```bash
bun test          # from apps/review
bun run tsc
```

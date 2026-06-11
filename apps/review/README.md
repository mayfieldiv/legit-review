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
- **Resolve workflow** — comments carry resolved/open state, a resolver name,
  and an optional resolution note. An agent resolves them over HTTP and the
  badge appears in the open browser within a second.
- **Viewed marks** — a Viewed pill per hunk and a Viewed checkbox per file.
  Fully-viewed files auto-collapse. Marks are stored under content hashes of the
  hunk text, so when code changes the affected hunk pops back open on its own;
  untouched hunks stay collapsed.
- **Outdated detection** — a comment whose anchor hunk's content changed is
  badged "Outdated" automatically.
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
| `GET /api/comments?status=open\|resolved\|all` | List comments                                                                   |
| `POST /api/comments`                           | Create a comment                                                                |
| `PATCH /api/comments/:id`                      | Edit / resolve (`{"resolved":true,"resolvedBy":"claude","resolutionNote":"…"}`) |
| `DELETE /api/comments/:id`                     | Delete                                                                          |
| `PUT /api/viewed`                              | Set/clear viewed marks (hunk- and/or file-level, one call)                      |
| `GET /api/events`                              | SSE: `diff-changed`, `state-changed`                                            |
| `GET /api/diff`                                | The unified diff the viewer renders                                             |

A Claude Code skill for the resolve workflow lives at
`~/.claude/skills/local-review/SKILL.md` (not part of this repo).

## Tests

```bash
bun test          # from apps/review
bun run tsc
```

---
name: verify-review-app
description:
  Use when verifying apps/review (Legit Review) changes end-to-end by launching
  the dev server and driving the UI in a browser.
---

# Verifying apps/review

## Launch

`bun run dev` binds `PIERRE_PORT_OFFSET + 3693` and `run-dev.sh` kills whatever
already owns that port — often the user's live review session. Do not take that
port. Start an isolated instance instead:

```bash
cd apps/review
bun run build:deps                      # app consumes packages/*/dist
PORT=3799 HOST=127.0.0.1 bun run dev:next   # background this
```

If package sources change afterwards, rebuild deps (or run the tsdown watchers
like `_dev` does); Next only sees `dist/`.

## Drive

- Open `http://127.0.0.1:3799/review?repo=/absolute/path/to/repo`.
- Use `agent-browser` (see `.agents/skills/browser-automation`).
- A throwaway repo works: `git init`, commit a file, mutate the working tree.
  The diff live-reloads when the working tree changes.

## Review-state REST (loopback, keyed by ?repo=<absolute path>)

```bash
# create a comment (line numbers are validated against the file)
curl -X POST "http://127.0.0.1:3799/api/comments?repo=$REPO" \
  -H 'Content-Type: application/json' \
  -d '{"filePath":"f.ts","side":"additions","range":{"start":60,"end":60},"message":"...","author":"agent"}'
# resolve / reopen
curl -X PATCH "http://127.0.0.1:3799/api/comments/<id>?repo=$REPO" \
  -H 'Content-Type: application/json' -d '{"resolved":true}'
```

Comment/viewed state persists server-side per repo path + branch, so it survives
server restarts and is shared across instances.

## Gotchas

- The app logs `--     request time` etc. to the browser console;
  `agent-browser console` accumulates across reloads — grep, don't tail.
- Viewed files render collapsed; expand via the file header chevron before
  asserting on diff contents.

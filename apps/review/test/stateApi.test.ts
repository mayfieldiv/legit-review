import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  DELETE as deleteCommentRoute,
  PATCH as patchCommentRoute,
} from '../app/api/comments/[id]/route';
import {
  GET as getCommentsRoute,
  POST as postCommentRoute,
} from '../app/api/comments/route';
import { GET as getStateRoute } from '../app/api/state/route';
import { PUT as putViewedRoute } from '../app/api/viewed/route';
import { synthesizeUntrackedPatch } from '../lib/git';
import { hashPatchFiles } from '../lib/hunkHash';

let baseDir: string;
let repo: string;

beforeAll(async () => {
  baseDir = mkdtempSync(path.join(tmpdir(), 'review-api-test-'));
  process.env.PIERRE_REVIEW_DATA_DIR = path.join(baseDir, 'data');

  repo = path.join(baseDir, 'repo');
  await mkdir(repo, { recursive: true });
  execFileSync('git', ['init', '-qb', 'main'], { cwd: repo });
  execFileSync('git', ['config', 'user.email', 't@t'], { cwd: repo });
  execFileSync('git', ['config', 'user.name', 'T'], { cwd: repo });
  await writeFile(path.join(repo, 'a.txt'), 'one\n');
  // Committed and never modified: the target for out-of-diff comments.
  await writeFile(path.join(repo, 'calm.txt'), 'calm one\ncalm two\n');
  // Committed with enough lines that a tail-only edit leaves the head
  // outside every hunk (3 context lines around the change).
  await writeFile(
    path.join(repo, 'big.txt'),
    Array.from({ length: 12 }, (_, i) => `b${i + 1}`).join('\n') + '\n'
  );
  execFileSync('git', ['add', '-A'], { cwd: repo });
  execFileSync('git', ['commit', '-qm', 'init'], { cwd: repo });
});

afterAll(() => {
  delete process.env.PIERRE_REVIEW_DATA_DIR;
  rmSync(baseDir, { recursive: true, force: true });
});

function apiUrl(pathname: string, params: Record<string, string> = {}) {
  const url = new URL(`http://localhost${pathname}`);
  url.searchParams.set('repo', repo);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}

function jsonRequest(url: string, method: string, body: unknown): Request {
  return new Request(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('review state API', () => {
  test('rejects requests without repo param', async () => {
    const response = await getStateRoute(
      new Request('http://localhost/api/state')
    );
    expect(response.status).toBe(400);
  });

  test('comment CRUD + filters through route handlers', async () => {
    // Create.
    const createResponse = await postCommentRoute(
      jsonRequest(apiUrl('/api/comments'), 'POST', {
        filePath: 'a.txt',
        side: 'additions',
        range: { start: 1, end: 1, side: 'additions' },
        message: 'First comment',
        lineSnippet: 'one',
        hunkHash: 'hash-1',
      })
    );
    expect(createResponse.status).toBe(201);
    const { comment } = (await createResponse.json()) as {
      comment: { id: string; resolved: boolean };
    };
    expect(comment.resolved).toBe(false);

    // Listed in state and via filters.
    const stateResponse = await getStateRoute(
      new Request(apiUrl('/api/state'))
    );
    expect(stateResponse.status).toBe(200);
    const state = (await stateResponse.json()) as {
      branch: string;
      comments: unknown[];
    };
    expect(state.branch).toBe('main');
    expect(state.comments).toHaveLength(1);

    const openResponse = await getCommentsRoute(
      new Request(apiUrl('/api/comments', { status: 'open' }))
    );
    const open = (await openResponse.json()) as { comments: unknown[] };
    expect(open.comments).toHaveLength(1);

    // Resolve via PATCH (the agent path).
    const patchResponse = await patchCommentRoute(
      jsonRequest(apiUrl(`/api/comments/${comment.id}`), 'PATCH', {
        resolved: true,
        resolvedBy: 'claude',
        resolutionNote: 'Fixed in abc123',
      }),
      { params: Promise.resolve({ id: comment.id }) }
    );
    expect(patchResponse.status).toBe(200);
    const patched = (await patchResponse.json()) as {
      comment: { resolved: boolean; resolvedBy: string };
    };
    expect(patched.comment.resolved).toBe(true);
    expect(patched.comment.resolvedBy).toBe('claude');

    const openAfter = (await (
      await getCommentsRoute(
        new Request(apiUrl('/api/comments', { status: 'open' }))
      )
    ).json()) as { comments: unknown[] };
    expect(openAfter.comments).toHaveLength(0);

    // Unknown id → 404.
    const missingPatch = await patchCommentRoute(
      jsonRequest(apiUrl('/api/comments/nope'), 'PATCH', { resolved: true }),
      { params: Promise.resolve({ id: 'nope' }) }
    );
    expect(missingPatch.status).toBe(404);

    // Delete.
    const deleteResponse = await deleteCommentRoute(
      new Request(apiUrl(`/api/comments/${comment.id}`), { method: 'DELETE' }),
      { params: Promise.resolve({ id: comment.id }) }
    );
    expect(deleteResponse.status).toBe(204);
  });

  test('rejects invalid comment bodies', async () => {
    const response = await postCommentRoute(
      jsonRequest(apiUrl('/api/comments'), 'POST', {
        filePath: 'a.txt',
        side: 'sideways',
        range: { start: 1, end: 1 },
        message: 'bad side',
      })
    );
    expect(response.status).toBe(400);
  });

  test('anchors agent comments without hunkHash to the current diff', async () => {
    // Dirty the working tree so a.txt has a real hunk vs HEAD.
    await writeFile(path.join(repo, 'a.txt'), 'one\ntwo\n');

    const response = await postCommentRoute(
      jsonRequest(apiUrl('/api/comments'), 'POST', {
        filePath: 'a.txt',
        side: 'additions',
        range: { start: 2, end: 2 },
        message: 'Agent finding',
        author: 'reviewer',
      })
    );
    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      comment: { hunkHash: string; lineSnippet: string };
    };
    expect(body.comment.lineSnippet).toBe('two');

    // The server-computed hash must equal what the browser computes from the
    // /api/diff patch bytes — same diff invocation, same hashing.
    const patch = execFileSync(
      'git',
      ['diff', '--find-renames', '--no-color', '--no-ext-diff', 'HEAD'],
      { cwd: repo, encoding: 'utf8' }
    );
    const fileHashes = await hashPatchFiles(patch);
    const aTxt = fileHashes.find((file) => file.filePath === 'a.txt');
    expect(body.comment.hunkHash).toBe(aTxt?.hunkHashes[0] as string);
  });

  test('anchors agent comments on untracked files via the synthesized patch', async () => {
    await writeFile(path.join(repo, 'new.txt'), 'alpha\nbeta\n');

    const response = await postCommentRoute(
      jsonRequest(apiUrl('/api/comments'), 'POST', {
        filePath: 'new.txt',
        side: 'additions',
        range: { start: 1, end: 1 },
        message: 'Untracked finding',
        author: 'reviewer',
      })
    );
    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      comment: { hunkHash: string; lineSnippet: string };
    };
    expect(body.comment.lineSnippet).toBe('alpha');

    const patch = await synthesizeUntrackedPatch(repo, 'new.txt');
    const fileHashes = await hashPatchFiles(patch as string);
    expect(body.comment.hunkHash).toBe(fileHashes[0]?.hunkHashes[0]);
  });

  test('anchors out-of-hunk and unchanged-file comments to file contents', async () => {
    // Tail-only edit: line 1 stays outside the hunk (3 context lines).
    await writeFile(
      path.join(repo, 'big.txt'),
      Array.from({ length: 12 }, (_, i) =>
        i === 11 ? 'b12 edited' : `b${i + 1}`
      ).join('\n') + '\n'
    );
    const outOfHunk = await postCommentRoute(
      jsonRequest(apiUrl('/api/comments'), 'POST', {
        filePath: 'big.txt',
        side: 'additions',
        range: { start: 1, end: 1 },
        message: 'Out-of-hunk finding',
        author: 'reviewer',
      })
    );
    expect(outOfHunk.status).toBe(201);
    const outOfHunkBody = (await outOfHunk.json()) as {
      comment: { hunkHash: string; lineSnippet: string };
    };
    expect(outOfHunkBody.comment.hunkHash).toBe('');
    expect(outOfHunkBody.comment.lineSnippet).toBe('b1');

    // A file with no diff at all hosts comments too.
    const unchanged = await postCommentRoute(
      jsonRequest(apiUrl('/api/comments'), 'POST', {
        filePath: 'calm.txt',
        side: 'additions',
        range: { start: 2, end: 2 },
        message: 'Unchanged-file finding',
        author: 'reviewer',
      })
    );
    expect(unchanged.status).toBe(201);
    const unchangedBody = (await unchanged.json()) as {
      comment: { hunkHash: string; lineSnippet: string };
    };
    expect(unchangedBody.comment.hunkHash).toBe('');
    expect(unchangedBody.comment.lineSnippet).toBe('calm two');

    // Deletions-side numbers resolve against the merge-base blob.
    const oldSide = await postCommentRoute(
      jsonRequest(apiUrl('/api/comments'), 'POST', {
        filePath: 'calm.txt',
        side: 'deletions',
        range: { start: 1, end: 1 },
        message: 'Old-side finding',
        author: 'reviewer',
      })
    );
    expect(oldSide.status).toBe(201);
    const oldSideBody = (await oldSide.json()) as {
      comment: { lineSnippet: string };
    };
    expect(oldSideBody.comment.lineSnippet).toBe('calm one');
  });

  test('rejects comments on lines that exist nowhere', async () => {
    const beyondEof = await postCommentRoute(
      jsonRequest(apiUrl('/api/comments'), 'POST', {
        filePath: 'a.txt',
        side: 'additions',
        range: { start: 999, end: 999 },
        message: 'Bad anchor',
        author: 'reviewer',
      })
    );
    expect(beyondEof.status).toBe(422);
    expect(await beyondEof.text()).toContain('out of range');

    const missingFile = await postCommentRoute(
      jsonRequest(apiUrl('/api/comments'), 'POST', {
        filePath: 'no-such-file.txt',
        side: 'additions',
        range: { start: 1, end: 1 },
        message: 'Bad file',
        author: 'reviewer',
      })
    );
    expect(missingFile.status).toBe(422);
    expect(await missingFile.text()).toContain('not readable');

    // Untracked files have no merge-base blob, so deletions-side numbers
    // cannot resolve.
    const untrackedOldSide = await postCommentRoute(
      jsonRequest(apiUrl('/api/comments'), 'POST', {
        filePath: 'new.txt',
        side: 'deletions',
        range: { start: 1, end: 1 },
        message: 'Bad side',
        author: 'reviewer',
      })
    );
    expect(untrackedOldSide.status).toBe(422);

    const invertedRange = await postCommentRoute(
      jsonRequest(apiUrl('/api/comments'), 'POST', {
        filePath: 'a.txt',
        side: 'additions',
        range: { start: 2, end: 1 },
        message: 'Bad range',
        author: 'reviewer',
      })
    );
    expect(invertedRange.status).toBe(400);
  });

  test('viewed marks for hunks and files', async () => {
    const hunkResponse = await putViewedRoute(
      jsonRequest(apiUrl('/api/viewed'), 'PUT', {
        filePath: 'a.txt',
        viewed: true,
        hunkHashes: ['h1', 'h2'],
      })
    );
    expect(hunkResponse.status).toBe(200);
    const hunkState = (await hunkResponse.json()) as {
      viewedHunks: Record<string, string[]>;
    };
    expect(hunkState.viewedHunks['a.txt']).toEqual(['h1', 'h2']);

    const fileResponse = await putViewedRoute(
      jsonRequest(apiUrl('/api/viewed'), 'PUT', {
        filePath: 'a.txt',
        viewed: true,
        fileHash: 'fh',
      })
    );
    const fileState = (await fileResponse.json()) as {
      viewedFiles: Record<string, string>;
    };
    expect(fileState.viewedFiles['a.txt']).toBe('fh');

    // Marking a file viewed without its hash is an error.
    const badResponse = await putViewedRoute(
      jsonRequest(apiUrl('/api/viewed'), 'PUT', {
        filePath: 'a.txt',
        viewed: true,
      })
    );
    expect(badResponse.status).toBe(400);

    // Clearing needs no hash.
    const clearResponse = await putViewedRoute(
      jsonRequest(apiUrl('/api/viewed'), 'PUT', {
        filePath: 'a.txt',
        viewed: false,
      })
    );
    const cleared = (await clearResponse.json()) as {
      viewedFiles: Record<string, string>;
    };
    expect(cleared.viewedFiles['a.txt']).toBeUndefined();
  });

  test('combined hunk + file marks in one request; unview clears file mark', async () => {
    const combinedResponse = await putViewedRoute(
      jsonRequest(apiUrl('/api/viewed'), 'PUT', {
        filePath: 'b.txt',
        viewed: true,
        hunkHashes: ['h1', 'h2'],
        fileHash: 'fh',
      })
    );
    expect(combinedResponse.status).toBe(200);
    const combined = (await combinedResponse.json()) as {
      viewedFiles: Record<string, string>;
      viewedHunks: Record<string, string[]>;
    };
    expect(combined.viewedHunks['b.txt']).toEqual(['h1', 'h2']);
    expect(combined.viewedFiles['b.txt']).toBe('fh');

    const unviewResponse = await putViewedRoute(
      jsonRequest(apiUrl('/api/viewed'), 'PUT', {
        filePath: 'b.txt',
        viewed: false,
        hunkHashes: ['h1'],
      })
    );
    const unviewed = (await unviewResponse.json()) as {
      viewedFiles: Record<string, string>;
      viewedHunks: Record<string, string[]>;
    };
    expect(unviewed.viewedHunks['b.txt']).toEqual(['h2']);
    expect(unviewed.viewedFiles['b.txt']).toBeUndefined();
  });
});

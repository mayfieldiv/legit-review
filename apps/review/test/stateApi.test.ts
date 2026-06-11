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

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  addCommentReply,
  createComment,
  deleteComment,
  deleteCommentReply,
  readState,
  setViewedMarks,
  stateFilePath,
  updateComment,
  updateCommentReply,
} from '../lib/store';

const REPO = '/fake/repo';
const BRANCH = 'feature/x';

let dataDir: string;

beforeAll(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'review-store-test-'));
  process.env.PIERRE_REVIEW_DATA_DIR = dataDir;
});

afterAll(() => {
  delete process.env.PIERRE_REVIEW_DATA_DIR;
  rmSync(dataDir, { recursive: true, force: true });
});

describe('store', () => {
  test('returns empty state for unknown repo+branch', async () => {
    const state = await readState('/never/seen', 'main');
    expect(state.comments).toEqual([]);
    expect(state.viewedHunks).toEqual({});
    expect(state.viewedFiles).toEqual({});
  });

  test('comment lifecycle persists to disk', async () => {
    const created = await createComment(REPO, BRANCH, {
      filePath: 'src/app.ts',
      side: 'additions',
      range: { start: 3, end: 3, side: 'additions' },
      message: 'Use a constant here',
      lineSnippet: 'const a = 100;',
      hunkHash: 'abc123',
    });
    expect(created.id).not.toBe('');
    expect(created.author).toBe('user');
    expect(created.resolved).toBe(false);

    // Fresh read comes from disk, not memory.
    const state = await readState(REPO, BRANCH);
    expect(state.comments).toHaveLength(1);
    expect(state.comments[0]?.message).toBe('Use a constant here');

    const resolved = await updateComment(REPO, BRANCH, created.id, {
      resolved: true,
      resolvedBy: 'claude',
      resolutionNote: 'Fixed in abc123.',
    });
    expect(resolved?.resolved).toBe(true);
    expect(resolved?.resolvedBy).toBe('claude');
    expect(resolved?.replies).toHaveLength(1);
    expect(resolved?.replies[0]?.kind).toBe('resolution');
    expect(resolved?.replies[0]?.author).toBe('claude');
    expect(resolved?.replies[0]?.message).toBe('Fixed in abc123.');

    const reopened = await updateComment(REPO, BRANCH, created.id, {
      resolved: false,
    });
    expect(reopened?.resolved).toBe(false);
    expect(reopened?.resolvedBy).toBeUndefined();

    expect(
      await updateComment(REPO, BRANCH, 'missing-id', { resolved: true })
    ).toBeUndefined();

    expect(await deleteComment(REPO, BRANCH, created.id)).toBe(true);
    expect(await deleteComment(REPO, BRANCH, created.id)).toBe(false);
    expect((await readState(REPO, BRANCH)).comments).toHaveLength(0);
  });

  test('reply lifecycle persists to disk', async () => {
    const created = await createComment(REPO, BRANCH, {
      filePath: 'src/app.ts',
      side: 'additions',
      range: { start: 5, end: 5 },
      message: 'Why not a Map here?',
    });
    expect(created.replies).toEqual([]);

    const withReply = await addCommentReply(REPO, BRANCH, created.id, {
      message: 'A Map allocates per lookup table; this stays monomorphic.',
      author: 'claude',
    });
    expect(withReply?.replies).toHaveLength(1);
    expect(withReply?.replies[0]?.kind).toBe('reply');
    expect(withReply?.replies[0]?.author).toBe('claude');
    const replyId = withReply?.replies[0]?.id as string;

    // Fresh read comes from disk.
    let state = await readState(REPO, BRANCH);
    expect(state.comments[0]?.replies[0]?.id).toBe(replyId);

    const edited = await updateCommentReply(
      REPO,
      BRANCH,
      created.id,
      replyId,
      'Updated explanation.'
    );
    expect(edited?.replies[0]?.message).toBe('Updated explanation.');

    // Missing comment or reply ids resolve undefined.
    expect(
      await addCommentReply(REPO, BRANCH, 'missing', { message: 'x' })
    ).toBeUndefined();
    expect(
      await updateCommentReply(REPO, BRANCH, created.id, 'missing', 'x')
    ).toBeUndefined();
    expect(
      await deleteCommentReply(REPO, BRANCH, created.id, 'missing')
    ).toBeUndefined();

    const afterDelete = await deleteCommentReply(
      REPO,
      BRANCH,
      created.id,
      replyId
    );
    expect(afterDelete?.replies).toEqual([]);
    state = await readState(REPO, BRANCH);
    expect(state.comments[0]?.replies).toEqual([]);

    await deleteComment(REPO, BRANCH, created.id);
  });

  test('migrates pre-thread comments: replies list + resolutionNote reply', async () => {
    const repo = '/fake/legacy';
    const legacy = await createComment(repo, 'main', {
      filePath: 'f.ts',
      side: 'additions',
      range: { start: 1, end: 1 },
      message: 'legacy comment',
    });
    // Rewrite the state file to the pre-thread shape: no replies array, a
    // resolved comment carrying the old free-form resolutionNote.
    const filePath = stateFilePath(repo, 'main');
    const raw = JSON.parse(await readFile(filePath, 'utf8'));
    delete raw.comments[0].replies;
    raw.comments[0].resolved = true;
    raw.comments[0].resolvedBy = 'claude';
    raw.comments[0].resolutionNote = 'Fixed in abc123';
    await writeFile(filePath, JSON.stringify(raw));

    const state = await readState(repo, 'main');
    const migrated = state.comments[0];
    expect(migrated?.replies).toHaveLength(1);
    expect(migrated?.replies[0]?.kind).toBe('resolution');
    expect(migrated?.replies[0]?.author).toBe('claude');
    expect(migrated?.replies[0]?.message).toBe('Fixed in abc123');
    expect(
      (migrated as { resolutionNote?: string } | undefined)?.resolutionNote
    ).toBeUndefined();
    // The synthetic reply id is deterministic: the migration re-runs on
    // every read until the next write, and edits/deletes must keep
    // targeting the same reply.
    expect(migrated?.replies[0]?.id).toBe(`legacy-note-${legacy.id}`);
    const reread = await readState(repo, 'main');
    expect(reread.comments[0]?.replies[0]?.id).toBe(migrated?.replies[0]?.id);
  });

  test('branches are isolated', async () => {
    await createComment(REPO, 'branch-a', {
      filePath: 'a.ts',
      side: 'additions',
      range: { start: 1, end: 1 },
      message: 'only on a',
    });
    const stateB = await readState(REPO, 'branch-b');
    expect(stateB.comments).toHaveLength(0);
  });

  test('viewed marks round-trip and clear', async () => {
    await setViewedMarks(REPO, BRANCH, 'src/app.ts', {
      viewed: true,
      hunkHashes: ['h1', 'h2'],
    });
    await setViewedMarks(REPO, BRANCH, 'src/app.ts', {
      viewed: true,
      hunkHashes: ['h3'],
    });
    let state = await readState(REPO, BRANCH);
    expect(state.viewedHunks['src/app.ts']).toEqual(['h1', 'h2', 'h3']);

    await setViewedMarks(REPO, BRANCH, 'src/app.ts', {
      viewed: false,
      hunkHashes: ['h1', 'h2', 'h3'],
    });
    state = await readState(REPO, BRANCH);
    expect(state.viewedHunks['src/app.ts']).toBeUndefined();

    await setViewedMarks(REPO, BRANCH, 'src/app.ts', {
      viewed: true,
      fileHash: 'filehash',
    });
    state = await readState(REPO, BRANCH);
    expect(state.viewedFiles['src/app.ts']).toBe('filehash');

    await setViewedMarks(REPO, BRANCH, 'src/app.ts', { viewed: false });
    state = await readState(REPO, BRANCH);
    expect(state.viewedFiles['src/app.ts']).toBeUndefined();
  });

  test('combined marks apply atomically and unview clears the file mark', async () => {
    // Whole-file toggle: every hunk plus the file mark in one mutation.
    await setViewedMarks(REPO, BRANCH, 'src/whole.ts', {
      viewed: true,
      hunkHashes: ['h1', 'h2'],
      fileHash: 'fh',
    });
    let state = await readState(REPO, BRANCH);
    expect(state.viewedHunks['src/whole.ts']).toEqual(['h1', 'h2']);
    expect(state.viewedFiles['src/whole.ts']).toBe('fh');

    // Unviewing a single hunk also drops the file-level mark — the file is
    // no longer fully viewed.
    await setViewedMarks(REPO, BRANCH, 'src/whole.ts', {
      viewed: false,
      hunkHashes: ['h1'],
    });
    state = await readState(REPO, BRANCH);
    expect(state.viewedHunks['src/whole.ts']).toEqual(['h2']);
    expect(state.viewedFiles['src/whole.ts']).toBeUndefined();
  });

  test('concurrent mutations serialize without losing writes', async () => {
    const repo = '/fake/concurrent';
    await Promise.all(
      Array.from({ length: 25 }, (_, index) =>
        createComment(repo, 'main', {
          filePath: 'f.ts',
          side: 'additions',
          range: { start: index + 1, end: index + 1 },
          message: `comment ${index}`,
        })
      )
    );
    const state = await readState(repo, 'main');
    expect(state.comments).toHaveLength(25);
  });

  test('state file is human-readable JSON in the data dir', async () => {
    await createComment('/fake/json', 'main', {
      filePath: 'f.ts',
      side: 'additions',
      range: { start: 1, end: 1 },
      message: 'check file',
    });
    const filePath = stateFilePath('/fake/json', 'main');
    expect(filePath.startsWith(dataDir)).toBe(true);
    const parsed = JSON.parse(await readFile(filePath, 'utf8'));
    expect(parsed.version).toBe(1);
    expect(parsed.repoPath).toBe('/fake/json');
  });

  test('branch names with slashes map to distinct files', () => {
    const a = stateFilePath(REPO, 'feature/x');
    const b = stateFilePath(REPO, 'feature/y');
    expect(a).not.toBe(b);
    expect(path.dirname(a)).toBe(path.dirname(b));
  });
});

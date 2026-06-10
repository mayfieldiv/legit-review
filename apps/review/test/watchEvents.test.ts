import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { GET as eventsRoute } from '../app/api/events/route';
import { emitReviewEvent, subscribeReviewEvents } from '../lib/events';
import { computeRepoSignature } from '../lib/git';
import { acquireRepoWatcher } from '../lib/watch';

let baseDir: string;
let repo: string;

function git(...args: string[]): void {
  execFileSync('git', args, { cwd: repo });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

beforeAll(async () => {
  baseDir = mkdtempSync(path.join(tmpdir(), 'review-watch-test-'));
  repo = path.join(baseDir, 'repo');
  await mkdir(repo, { recursive: true });
  git('init', '-qb', 'main');
  git('config', 'user.email', 't@t');
  git('config', 'user.name', 'T');
  await writeFile(path.join(repo, 'a.txt'), 'one\n');
  git('add', '-A');
  git('commit', '-qm', 'init');
});

afterAll(() => {
  rmSync(baseDir, { recursive: true, force: true });
});

describe('computeRepoSignature', () => {
  test('changes when the working tree changes and when HEAD moves', async () => {
    const clean = await computeRepoSignature(repo);
    // Stable across repeated reads of an unchanged tree.
    expect(await computeRepoSignature(repo)).toBe(clean);

    await writeFile(path.join(repo, 'a.txt'), 'two\n');
    const dirty = await computeRepoSignature(repo);
    expect(dirty).not.toBe(clean);

    // Editing content again (same file, still "modified") changes it too,
    // via the mtime/size component.
    await sleep(5);
    await writeFile(path.join(repo, 'a.txt'), 'three!\n');
    const dirtier = await computeRepoSignature(repo);
    expect(dirtier).not.toBe(dirty);

    git('add', '-A');
    git('commit', '-qm', 'edit');
    const committed = await computeRepoSignature(repo);
    expect(committed).not.toBe(dirtier);
  });
});

describe('acquireRepoWatcher', () => {
  test('emits diff-changed on the bus when the repo changes', async () => {
    const events: string[] = [];
    const unsubscribe = subscribeReviewEvents(repo, (event) => {
      events.push(event.type);
    });
    const release = acquireRepoWatcher(repo, 25);
    try {
      // Let the watcher take its baseline signature first.
      await sleep(120);
      await writeFile(path.join(repo, 'watched.txt'), 'hello\n');
      await sleep(250);
      expect(events).toContain('diff-changed');
    } finally {
      release();
      unsubscribe();
    }
  });

  test('release stops polling when the last subscriber leaves', async () => {
    const releaseA = acquireRepoWatcher(repo, 25);
    const releaseB = acquireRepoWatcher(repo, 25);
    releaseA();
    releaseA(); // double release is a no-op
    releaseB();

    const events: string[] = [];
    const unsubscribe = subscribeReviewEvents(repo, (event) => {
      events.push(event.type);
    });
    await writeFile(path.join(repo, 'watched.txt'), 'changed again\n');
    await sleep(150);
    unsubscribe();
    expect(events).toHaveLength(0);
  });
});

describe('events SSE route', () => {
  test('relays bus events and cleans up on abort', async () => {
    const controller = new AbortController();
    const request = new Request(
      `http://localhost/api/events?repo=${encodeURIComponent(repo)}`,
      { signal: controller.signal }
    );
    const response = await eventsRoute(request);
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('text/event-stream');

    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let received = '';

    // First frame is the connected comment.
    const first = await reader.read();
    received += decoder.decode(first.value);
    expect(received).toContain(': connected');

    emitReviewEvent(repo, { type: 'state-changed' });
    const second = await reader.read();
    received += decoder.decode(second.value);
    expect(received).toContain('event: state-changed');

    controller.abort();
    // The stream ends after abort; a subsequent read settles.
    const final = await reader.read().catch(() => ({ done: true }));
    expect(final.done).toBe(true);
  });
});

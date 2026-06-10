// Content hashing for viewed-state and comment anchoring. A hunk's hash is
// derived from its body lines only (the `@@` header is excluded), so edits
// elsewhere in the file that merely shift line numbers do not change the
// hash, while any edit to the hunk's own content does. Used by both the
// browser (mapping rendered hunks to viewed marks) and the server (agent API),
// so it must stay isomorphic: Web Crypto only, no Node imports.

export interface FileHunkHashes {
  filePath: string;
  // Identity of the whole file's change. Derived from the hunk hashes when
  // hunks exist; otherwise (binary stubs, empty new files, mode-only changes)
  // from the remaining block lines so e.g. a binary content change (new
  // `index` line) still invalidates a file-level viewed mark.
  fileHash: string;
  hunkHashes: string[];
}

const DIFF_GIT_PATTERN = /^diff --git a\/(.*) b\/(.*)$/;

export async function sha1Hex(text: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest(
    'SHA-1',
    new TextEncoder().encode(text)
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0')
  ).join('');
}

// Hashes every file block in a unified diff patch.
export async function hashPatchFiles(
  patchText: string
): Promise<FileHunkHashes[]> {
  const results: FileHunkHashes[] = [];
  for (const block of splitPatchIntoFileBlocks(patchText)) {
    results.push(await hashFileBlock(block));
  }
  return results;
}

// Hashes a single file's diff block (text starting with `diff --git`).
export async function hashFileBlock(
  blockText: string
): Promise<FileHunkHashes> {
  const lines = blockText.split('\n');
  const filePath = extractFilePath(lines);

  const hunkBodies: string[] = [];
  let currentHunk: string[] | null = null;
  const headerLines: string[] = [];
  for (const line of lines) {
    if (line.startsWith('@@')) {
      if (currentHunk != null) {
        hunkBodies.push(currentHunk.join('\n'));
      }
      currentHunk = [];
      continue;
    }
    if (currentHunk != null) {
      currentHunk.push(line);
    } else if (!line.startsWith('diff --git')) {
      headerLines.push(line);
    }
  }
  if (currentHunk != null) {
    hunkBodies.push(currentHunk.join('\n'));
  }

  const hunkHashes = await Promise.all(
    hunkBodies.map((body) => sha1Hex(`${filePath}\0${body}`))
  );
  const fileHashInput =
    hunkHashes.length > 0 ? hunkHashes.join('\n') : headerLines.join('\n');
  const fileHash = await sha1Hex(`${filePath}\0${fileHashInput}`);

  return { filePath, fileHash, hunkHashes };
}

// Splits raw patch text into per-file blocks on `diff --git` boundaries.
export function splitPatchIntoFileBlocks(patchText: string): string[] {
  const blocks: string[] = [];
  let currentStart = -1;
  let offset = 0;
  while (offset <= patchText.length) {
    const isFileStart = patchText.startsWith('diff --git ', offset);
    if (isFileStart) {
      if (currentStart !== -1) {
        blocks.push(patchText.slice(currentStart, offset));
      }
      currentStart = offset;
    }
    const nextNewline = patchText.indexOf('\n', offset);
    if (nextNewline === -1) {
      break;
    }
    offset = nextNewline + 1;
  }
  if (currentStart !== -1) {
    blocks.push(patchText.slice(currentStart));
  }
  return blocks;
}

// Prefers the `+++ b/<path>` header; falls back to the `diff --git` line for
// blocks without one (binary stubs, deletions use `--- a/<path>` instead).
function extractFilePath(lines: string[]): string {
  for (const line of lines) {
    if (line.startsWith('+++ b/')) {
      return line.slice('+++ b/'.length);
    }
    if (line.startsWith('@@')) {
      break;
    }
  }
  for (const line of lines) {
    if (line.startsWith('--- a/')) {
      return line.slice('--- a/'.length);
    }
    if (line.startsWith('@@')) {
      break;
    }
  }
  const match = lines[0] == null ? null : DIFF_GIT_PATTERN.exec(lines[0]);
  return match?.[2] ?? '';
}

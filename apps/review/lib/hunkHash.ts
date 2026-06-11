// Content hashing for viewed-state and comment anchoring. A hunk's hash is
// derived from its body lines only (the `@@` header is excluded), so edits
// elsewhere in the file that merely shift line numbers do not change the
// hash, while any edit to the hunk's own content does. Used by both the
// browser (mapping rendered hunks to viewed marks) and the server (agent API),
// so it must stay isomorphic: no Node imports.

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
  const bytes = new TextEncoder().encode(text);
  const subtle = globalThis.crypto?.subtle;
  if (subtle != null) {
    const digest = await subtle.digest('SHA-1', bytes);
    return bytesToHex(new Uint8Array(digest));
  }

  return sha1HexFromBytes(bytes);
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join(
    ''
  );
}

// Browsers expose crypto.subtle only on secure origins. This fallback keeps
// local HTTP review sessions over LAN/Tailscale able to hash rendered hunks.
function sha1HexFromBytes(input: Uint8Array): string {
  const paddedLength = Math.ceil((input.length + 9) / 64) * 64;
  const bytes = new Uint8Array(paddedLength);
  bytes.set(input);
  bytes[input.length] = 0x80;

  const bitLength = input.length * 8;
  const highLength = Math.floor(bitLength / 0x100000000);
  const lowLength = bitLength >>> 0;
  bytes[paddedLength - 8] = (highLength >>> 24) & 0xff;
  bytes[paddedLength - 7] = (highLength >>> 16) & 0xff;
  bytes[paddedLength - 6] = (highLength >>> 8) & 0xff;
  bytes[paddedLength - 5] = highLength & 0xff;
  bytes[paddedLength - 4] = (lowLength >>> 24) & 0xff;
  bytes[paddedLength - 3] = (lowLength >>> 16) & 0xff;
  bytes[paddedLength - 2] = (lowLength >>> 8) & 0xff;
  bytes[paddedLength - 1] = lowLength & 0xff;

  let h0 = 0x67452301;
  let h1 = 0xefcdab89;
  let h2 = 0x98badcfe;
  let h3 = 0x10325476;
  let h4 = 0xc3d2e1f0;
  const words = new Uint32Array(80);

  for (let offset = 0; offset < bytes.length; offset += 64) {
    for (let index = 0; index < 16; index++) {
      const wordOffset = offset + index * 4;
      words[index] =
        ((bytes[wordOffset] ?? 0) << 24) |
        ((bytes[wordOffset + 1] ?? 0) << 16) |
        ((bytes[wordOffset + 2] ?? 0) << 8) |
        (bytes[wordOffset + 3] ?? 0);
    }
    for (let index = 16; index < 80; index++) {
      words[index] = rotateLeft(
        words[index - 3] ^
          words[index - 8] ^
          words[index - 14] ^
          words[index - 16],
        1
      );
    }

    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;

    for (let index = 0; index < 80; index++) {
      let f: number;
      let k: number;
      if (index < 20) {
        f = (b & c) | (~b & d);
        k = 0x5a827999;
      } else if (index < 40) {
        f = b ^ c ^ d;
        k = 0x6ed9eba1;
      } else if (index < 60) {
        f = (b & c) | (b & d) | (c & d);
        k = 0x8f1bbcdc;
      } else {
        f = b ^ c ^ d;
        k = 0xca62c1d6;
      }

      const temp = (rotateLeft(a, 5) + f + e + k + words[index]) >>> 0;
      e = d;
      d = c;
      c = rotateLeft(b, 30);
      b = a;
      a = temp;
    }

    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
  }

  return [h0, h1, h2, h3, h4]
    .map((word) => word.toString(16).padStart(8, '0'))
    .join('');
}

function rotateLeft(value: number, bits: number): number {
  return ((value << bits) | (value >>> (32 - bits))) >>> 0;
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

export interface HunkAnchor {
  hunkHash: string;
  lineSnippet: string;
}

const HUNK_HEADER_PATTERN = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

// Locates the hunk containing `line` on `side` of `filePath`'s diff block and
// returns the same content hash hashFileBlock assigns that hunk, plus the
// anchored line's text (diff marker stripped). This is how the server anchors
// agent-posted comments: the browser hashes the rendered diff itself, but
// REST callers only know a path, side, and line number. Line numbers are
// new-file numbers on the additions side and old-file numbers on the
// deletions side; context lines exist on both. Returns null when the file or
// line is not part of the patch.
export async function findHunkAnchorInPatch(
  patchText: string,
  filePath: string,
  side: 'deletions' | 'additions',
  line: number
): Promise<HunkAnchor | null> {
  for (const block of splitPatchIntoFileBlocks(patchText)) {
    const lines = block.split('\n');
    if (extractFilePath(lines) !== filePath) {
      continue;
    }
    // Collect hunk bodies exactly like hashFileBlock does (hash parity is
    // the whole point), while also walking the per-side line counters to
    // find which hunk covers the requested line.
    const hunkBodies: string[] = [];
    let currentHunk: string[] | null = null;
    let matchedHunkIndex = -1;
    let matchedSnippet = '';
    let oldLine = 0;
    let newLine = 0;
    for (const rawLine of lines) {
      if (rawLine.startsWith('@@')) {
        if (currentHunk != null) {
          hunkBodies.push(currentHunk.join('\n'));
        }
        currentHunk = [];
        const header = HUNK_HEADER_PATTERN.exec(rawLine);
        oldLine = header == null ? 0 : Number(header[1]);
        newLine = header == null ? 0 : Number(header[2]);
        continue;
      }
      if (currentHunk == null) {
        continue;
      }
      currentHunk.push(rawLine);
      // Lines with other markers ('' from the trailing split, '\ No newline'
      // stubs) belong to the hash but to neither side's line numbering.
      const marker = rawLine[0];
      const onDeletions = marker === '-' || marker === ' ';
      const onAdditions = marker === '+' || marker === ' ';
      const onRequestedSide = side === 'deletions' ? onDeletions : onAdditions;
      const lineNumber = side === 'deletions' ? oldLine : newLine;
      if (matchedHunkIndex === -1 && onRequestedSide && lineNumber === line) {
        // hunkBodies holds only completed hunks, so its length is the index
        // the in-progress hunk will get once pushed.
        matchedHunkIndex = hunkBodies.length;
        matchedSnippet = rawLine.slice(1);
      }
      if (onDeletions) {
        oldLine += 1;
      }
      if (onAdditions) {
        newLine += 1;
      }
    }
    if (currentHunk != null) {
      hunkBodies.push(currentHunk.join('\n'));
    }
    const body = hunkBodies[matchedHunkIndex];
    if (matchedHunkIndex === -1 || body == null) {
      return null;
    }
    return {
      hunkHash: await sha1Hex(`${filePath}\0${body}`),
      lineSnippet: matchedSnippet,
    };
  }
  return null;
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

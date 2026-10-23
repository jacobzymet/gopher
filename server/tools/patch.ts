import fs from 'node:fs/promises';
import { atomicWrite, type Workspace } from './workspace.js';

/**
 * apply_patch: the `*** Begin Patch` format with Add, Delete and Update (optionally Move) file
 * operations. Hunks must match complete lines exactly once; line endings and a missing final
 * newline are preserved. All files are prepared first and committed together, with rollback.
 */

interface PatchOperation { kind: 'add' | 'delete' | 'update'; file: string; move?: string; lines: string[] }
interface PatchLine { text: string; eol: string; explicitNoEol?: boolean }
interface PatchHunk { tokens: string[]; anchor?: string; line?: number; count?: number; newLine?: number; newCount?: number; eof: boolean; noNewline?: number[] }

const MAX_PATCH_BYTES = 2_000_000;
const MAX_TARGET_BYTES = 16 * 1024 * 1024;

function fileLines(content: string): PatchLine[] {
  const source = content.split('\n');
  const records = source.map((text, index) => {
    const last = index === source.length - 1;
    return { text: !last && text.endsWith('\r') ? text.slice(0, -1) : text, eol: last ? '' : text.endsWith('\r')
      ? '\r\n' : '\n' };
  });
  if (!records.at(-1)?.text && !records.at(-1)?.eol) records.pop();
  return records;
}

function parseHunks(patchLines: string[], filename: string): PatchHunk[] {
  const hunks: PatchHunk[] = [];
  let current: PatchHunk = { tokens: [], eof: false };
  const flush = () => { if (current.tokens.length) hunks.push(current); current = { tokens: [], eof: false }; };
  for (let index = 0; index < patchLines.length; index++) {
    const line = patchLines[index]!;
    if (line.startsWith('@@')) {
      flush();
      const numeric = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?:.*)?$/.exec(line);
      if (numeric) {
        current.line = Number(numeric[1]);
        current.count = numeric[2] === undefined ? 1 : Number(numeric[2]);
        current.newLine = Number(numeric[3]);
        current.newCount = numeric[4] === undefined ? 1 : Number(numeric[4]);
      } else if (line !== '@@') {
        if (!line.startsWith('@@ ')) throw new Error(`Invalid patch hunk header in ${filename}`);
        current.anchor = line.slice(3);
      }
    } else if (line === '*** End of File') current.eof = true;
    else if (line === '\\ No newline at end of file') {
      const token = current.tokens.length - 1;
      if (token < 0
        || current.noNewline?.includes(token)) throw new Error(`No-newline marker must follow a patch line in ${filename}`);
      (current.noNewline ??= []).push(token);
    } else if (/^[ +\-]/.test(line)) current.tokens.push(line);
    else if (line || index !== patchLines.length - 1) throw new Error('Update lines must start with space, +, or -');
  }
  flush();
  if (!hunks.length) throw new Error(`Update contains no hunks: ${filename}`);
  return hunks;
}

/** Where a hunk applies: at its numeric offset, after its anchor, or at its unique context. */
function locate(hunk: PatchHunk, records: PatchLine[], before: string[], cursor: number, lineDelta: number,
  filename: string): number {
  const matchesAt = (at: number) => at >= cursor && at >= 0 && at + before.length <= records.length
    && before.every((line, offset) => records[at + offset]!.text === line)
      && (!hunk.eof || at + before.length === records.length);
  if (hunk.line !== undefined) {
    const at = (hunk.count === 0 ? hunk.line : hunk.line - 1) + lineDelta;
    if (!Number.isSafeInteger(at) || !matchesAt(at)) {
      throw new Error(`Patch line offset is outside the file or does not match complete lines in ${filename}`);
    }
    return at;
  }
  if (before.length) {
    const matches: number[] = [];
    for (let index = cursor; index + before.length <= records.length; index++) if (matchesAt(index)) matches.push(index);
    if (matches.length !== 1) {
      throw new Error(matches.length ? `Patch context is ambiguous in ${filename}; include more complete lines.`
        : `Patch context was not found as complete lines in ${filename}: ${before.join('\n').slice(0, 120)}`);
    }
    return matches[0]!;
  }
  if (hunk.eof) return records.length;
  if (hunk.anchor !== undefined || !records.length) return cursor;
  throw new Error(`Insertion needs a complete-line anchor or explicit line offset in ${filename}`);
}

function patchFileContent(content: string, patchLines: string[], filename: string): string {
  const records = fileLines(content);
  const defaultEol = records.find(line => line.eol)?.eol || '\n';
  const finalEol = records.at(-1)?.eol || (content.length === 0 ? defaultEol : '');
  let cursor = 0, lineDelta = 0, explicitNewline = false;
  for (const hunk of parseHunks(patchLines, filename)) {
    if (hunk.anchor !== undefined) {
      const anchors = records.flatMap((line, index) => (index >= cursor && line.text === hunk.anchor ? [index] : []));
      if (anchors.length !== 1) throw new Error(`Patch anchor must match exactly one complete line in ${filename}: ${hunk.anchor}`);
      cursor = anchors[0]! + 1;
    }
    const before = hunk.tokens.filter(line => line[0] !== '+').map(line => line.slice(1));
    if (hunk.count !== undefined
      && hunk.count !== before.length) throw new Error(`Patch hunk line count is inconsistent in ${filename}`);
    if (hunk.newCount !== undefined && hunk.newCount !== hunk.tokens.filter(line => line[0] !== '-').length) {
      throw new Error(`Patch hunk new line count is inconsistent in ${filename}`);
    }
    const at = locate(hunk, records, before, cursor, lineDelta, filename);
    if (hunk.newLine !== undefined
      && (!Number.isSafeInteger(hunk.newLine) || (hunk.newCount === 0 ? hunk.newLine : hunk.newLine - 1) !== at)) {
      throw new Error(`Patch new line offset is inconsistent in ${filename}`);
    }
    const replacement: PatchLine[] = [];
    let oldIndex = at;
    for (const [index, token] of hunk.tokens.entries()) {
      const noNewline = Boolean(hunk.noNewline?.includes(index));
      if (noNewline && token[0] !== '+' && (oldIndex !== records.length - 1 || records[oldIndex]!.eol)) {
        throw new Error(`Old no-newline marker does not match the file ending in ${filename}`);
      }
      if (token[0] === ' ') replacement.push({ ...records[oldIndex++]!,
        ...(noNewline ? { explicitNoEol: true } : {}) });
      else if (token[0] === '-') oldIndex++;
      else replacement.push({ text: token.slice(1), eol: noNewline ? '' : defaultEol,
        ...(noNewline ? { explicitNoEol: true } : {}) });
    }
    records.splice(at, before.length, ...replacement);
    cursor = at + replacement.length;
    lineDelta += replacement.length - before.length;
    explicitNewline ||= Boolean(hunk.noNewline?.length);
  }
  for (let index = 0; index < records.length - 1; index++) {
    if (records[index]!.explicitNoEol) throw new Error(`New no-newline marker must describe the last file line in ${filename}`);
    if (!records[index]!.eol) records[index]!.eol = defaultEol;
  }
  if (records.length && !explicitNewline) records.at(-1)!.eol = finalEol;
  return records.map(line => line.text + line.eol).join('');
}

function parseOperations(patch: string): PatchOperation[] {
  const lines = patch.replace(/\r\n/g, '\n').split('\n');
  if (lines[0] !== '*** Begin Patch' || lines.filter(Boolean).at(-1) !== '*** End Patch') {
    throw new Error('Patch must use *** Begin Patch and *** End Patch');
  }
  const operations: PatchOperation[] = [];
  let current: PatchOperation | undefined;
  for (const line of lines.slice(1)) {
    const header = /^\*\*\* (Add|Delete|Update) File: (.+)$/.exec(line);
    if (header) { current = { kind: header[1]!.toLowerCase() as PatchOperation['kind'], file: header[2]!,
      lines: [] }; operations.push(current); }
    else if (line.startsWith('*** Move to: ')) {
      if (!current || current.kind !== 'update') throw new Error('Move must follow Update File');
      current.move = line.slice(13);
    } else if (line === '*** End Patch') break;
    else if (current) current.lines.push(line);
    else if (line) throw new Error('Unexpected patch text');
  }
  if (!operations.length) throw new Error('Patch contains no file changes');
  return operations;
}

export async function applyPatch(ws: Workspace, patch: unknown, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  if (typeof patch !== 'string'
    || Buffer.byteLength(patch) > MAX_PATCH_BYTES) throw new Error('Patch is missing or exceeds 2 MB');
  const operations = parseOperations(patch);
  return ws.transaction(async () => {
    const originals = new Map<string, Buffer | null>(), changes = new Map<string, string | null>();
    const remember = async (file: string) => {
      if (originals.has(file)) return;
      try {
        const stat = await fs.stat(file);
        if (!stat.isFile()
          || stat.size > MAX_TARGET_BYTES) throw new Error('Patch target must be a regular file smaller than 16 MB');
        originals.set(file, await fs.readFile(file));
      } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') originals.set(file,
        null); else throw error; }
    };
    for (const operation of operations) {
      signal?.throwIfAborted();
      const file = await ws.resolve(operation.file);
      if (file === ws.root) throw new Error('Cannot patch the workspace directory');
      await remember(file);
      signal?.throwIfAborted();
      let existing = (changes.has(file) ? changes.get(file) : originals.get(file)?.toString('utf8')) ?? null;
      if (operation.kind === 'add') {
        if (existing !== null) throw new Error(`File already exists: ${operation.file}`);
        const invalid = operation.lines.some((line, index) => !line.startsWith('+')
          && !(index === operation.lines.length - 1 && !line));
        if (invalid) throw new Error('Added file lines must start with +');
        changes.set(file,
          operation.lines.filter(line => line.startsWith('+')).map(line => line.slice(1)).join('\n') + '\n');
        continue;
      }
      if (existing === null) throw new Error(`File does not exist: ${operation.file}`);
      if (operation.kind === 'delete') { changes.set(file, null); continue; }
      if (!changes.has(file)) {
        try { existing = new TextDecoder('utf8', { fatal: true, ignoreBOM: true }).decode(originals.get(file)!); }
        catch { throw new Error(`Patch target is not valid UTF-8 text: ${operation.file}`); }
      }
      const content = patchFileContent(existing, operation.lines, operation.file);
      if (!operation.move) { changes.set(file, content); continue; }
      const moved = await ws.resolve(operation.move);
      await remember(moved);
      if (changes.has(moved) || originals.get(moved) !== null) {
        throw new Error(`Move destination already exists or has a pending change: ${operation.move}`);
      }
      changes.set(file, null);
      changes.set(moved, content);
    }
    const committed: string[] = [];
    try {
      for (const [file, content] of changes) {
        await ws.resolve(file);
        signal?.throwIfAborted();
        if (content === null) await fs.unlink(file); else await atomicWrite(file, content, signal);
        committed.push(file);
      }
      signal?.throwIfAborted();
    } catch (error) {
      for (const file of committed.reverse()) {
        const original = originals.get(file);
        if (original) await atomicWrite(file, original); else await fs.rm(file, { force: true });
      }
      throw error;
    }
    const summary = [...changes].map(([file, content]) => `${content === null ? 'D' : originals.get(file) === null
      ? 'A' : 'M'} ${ws.relative(file)}`);
    return `Applied patch successfully:\n${summary.join('\n')}`;
  }, signal);
}

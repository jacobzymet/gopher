import fs from 'node:fs/promises';
import path from 'node:path';
import { RegexMatcher } from './regex.js';
import { atomicCreate, atomicWrite, limit, readSmall, Workspace } from './workspace.js';
import { applyPatch } from './patch.js';

/** Workspace file tools: read_file, list_dir, glob, grep, write_file, str_replace, delete_file and apply_patch. */

export { Workspace, within } from './workspace.js';
export { applyPatch } from './patch.js';

type Args = Record<string, unknown>;
const SKIP = new Set(['.git', 'node_modules', 'target', 'dist', 'build', '.venv', 'venv', '__pycache__', 'vendor']);
const EDIT_LIMIT = 16 * 1024 * 1024;
const WRITE_LIMIT = 1_000_000;
const MAX_DEPTH = 64;
const MAX_LISTED = 500;
const MAX_GLOB_MATCHES = 200;
const MAX_GREP_FILES = 20_000;
const MAX_GREP_FILE_BYTES = 1_000_000;
const MAX_LINE_CHARS = 1000;

export function globRegex(pattern: unknown): RegExp {
  if (typeof pattern !== 'string' || !pattern
    || pattern.length > 512) throw new Error('Glob pattern must contain 1–512 characters');
  let output = '';
  const normalized = pattern.replace(/\\/g, '/');
  for (let index = 0; index < normalized.length; index++) {
    const char = normalized[index]!;
    if (char === '*' && normalized[index + 1] === '*') {
      index++;
      if (normalized[index + 1] === '/') { index++; output += '(?:.*/)?'; } else output += '.*';
    } else if (char === '*') output += '[^/]*';
    else if (char === '?') output += '[^/]';
    else output += char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`${normalized.includes('/') ? '^' : '(?:^|/)'}${output}$`, process.platform === 'win32' ? 'i' : '');
}

/** Regular files below `dir` in name order, skipping symlinks and dependency or build folders. */
async function* walk(dir: string, depth = 0, signal?: AbortSignal): AsyncGenerator<string> {
  signal?.throwIfAborted();
  if (depth > MAX_DEPTH) return;
  const entries = await fs.readdir(dir, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    signal?.throwIfAborted();
    if (entry.isSymbolicLink()) continue;
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) { if (!SKIP.has(entry.name)) yield* walk(file, depth + 1, signal); }
    else if (entry.isFile()) yield file;
  }
}

/** Skip whole lines to reach a line offset, without reading the file into memory. */
async function lineOffset(handle: fs.FileHandle, desired: number, size: number,
  signal?: AbortSignal): Promise<{ offset: number; line: number }> {
  const chunk = Buffer.alloc(64_000);
  let offset = 0, line = 0;
  while (line < desired && offset < size) {
    signal?.throwIfAborted();
    const { bytesRead } = await handle.read(chunk, 0, Math.min(chunk.length, size - offset), offset);
    if (!bytesRead) break;
    let consumed = 0;
    for (; consumed < bytesRead; consumed++) if (chunk[consumed] === 10 && ++line >= desired) { consumed++; break; }
    offset += consumed;
  }
  return { offset, line };
}

/** One page of a file: at most `max_bytes` and `limit` lines, never splitting a UTF-8 character. */
async function readFilePage(ws: Workspace, args: Args, signal?: AbortSignal): Promise<string> {
  const file = await ws.resolve(args.path);
  signal?.throwIfAborted();
  const handle = await fs.open(file, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error('Path is not a regular file');
    const max = limit(args.max_bytes, 256, 32_000, 32_000), lineLimit = limit(args.limit, 1, 2000, 200);
    let offset = limit(args.byte_offset, 0, Number.MAX_SAFE_INTEGER, 0), line = 0;
    if (args.byte_offset !== undefined
      && args.offset !== undefined) throw new Error('Use byte_offset or offset, not both');
    if (args.byte_offset === undefined && Number(args.offset) > 0) {
      ({ offset, line } = await lineOffset(handle, limit(args.offset, 0, Number.MAX_SAFE_INTEGER, 0), stat.size,
        signal));
    }
    if (offset > stat.size) throw new Error('byte_offset is past the end of the file');
    const buffer = Buffer.alloc(Math.min(max + 4, Math.max(0, stat.size - offset)));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
    const bytes = buffer.subarray(0, bytesRead);
    if (offset && bytes.length && (bytes[0]! & 0xc0) === 0x80) {
      throw new Error('byte_offset is inside a UTF-8 character; resume using the returned next_byte_offset');
    }
    let end = Math.min(max, bytes.length), count = 0;
    for (let index = 0; index < end; index++) if (bytes[index] === 10
      && ++count >= lineLimit) { end = index + 1; break; }
    if (end < bytes.length) while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
    const next = offset + end;
    return JSON.stringify({
      path: ws.relative(file), content: bytes.subarray(0, end).toString('utf8'), offset: args.byte_offset === undefined
        ? line : undefined,
      byte_offset: offset, next_byte_offset: next < stat.size ? next : null, truncated: next < stat.size,
        total_bytes: stat.size,
    });
  } finally { await handle.close(); }
}

/**
 * Replace an exact string. LF and CRLF are treated as equal when matching, and each replacement
 * takes the line ending of the text it replaces, so files keep their own line endings.
 */
function replaceText(content: string, args: Args): string {
  const old = String(args.old_string ?? args.old ?? '').replace(/\r\n/g, '\n');
  const replacement = args.new_string ?? args.new, replaceAll = args.replace_all ?? args.allow_multiple;
  if (!old || typeof replacement !== 'string') throw new Error('old_string must be nonempty and new_string must be text');
  if (Buffer.byteLength(old) > EDIT_LIMIT
    || Buffer.byteLength(replacement) > EDIT_LIMIT) throw new Error('Replacement text exceeds 16 MB');
  const normalized = content.replace(/\r\n/g, '\n');
  const matches: number[] = [];
  for (let cursor = 0,
    at = normalized.indexOf(old); at >= 0; at = normalized.indexOf(old,
      cursor)) { matches.push(at); cursor = at + old.length; }
  if (!matches.length) throw new Error('old_string was not found; no changes were made. LF and CRLF are treated as equivalent.');
  if (matches.length > 1
    && !replaceAll) throw new Error('old_string occurs more than once. Include more context or set replace_all.');
  // Map offsets in the LF-normalized text back to the original text.
  const removed: number[] = [];
  for (const match of content.matchAll(/\r\n/g)) removed.push(match.index! - removed.length);
  const originalOffset = (at: number) => at + removed.filter(index => index < at).length;
  const newline = content.indexOf('\n');
  const defaultCrlf = newline > 0 && content[newline - 1] === '\r';
  const inserted = replacement.replace(/\r\n/g, '\n');
  let next = '', position = 0;
  for (const at of matches) {
    const start = originalOffset(at), end = originalOffset(at + old.length);
    const span = content.slice(start, end), spanNewline = span.indexOf('\n');
    const crlf = spanNewline >= 0 ? spanNewline > 0 && span[spanNewline - 1] === '\r' : defaultCrlf;
    next += content.slice(position, start) + (crlf ? inserted.replace(/\n/g, '\r\n') : inserted);
    position = end;
    if (Buffer.byteLength(next) > EDIT_LIMIT) throw new Error('Replacement would exceed the 16 MB edit limit');
  }
  const result = next + content.slice(position);
  if (Buffer.byteLength(result) > EDIT_LIMIT) throw new Error('Replacement would exceed the 16 MB edit limit');
  return result;
}

async function modify(ws: Workspace, name: string, args: Args, signal?: AbortSignal): Promise<string> {
  const file = await ws.resolve(args.path);
  signal?.throwIfAborted();
  if (file === ws.root) throw new Error('Cannot modify the workspace directory');
  if (name === 'delete_file') {
    const meta = await fs.lstat(file);
    if (!meta.isFile()) throw new Error('delete_file only deletes regular files');
    signal?.throwIfAborted();
    await fs.unlink(file);
    return `Deleted ${ws.relative(file)}`;
  }
  let content: string;
  if (name === 'str_replace') {
    content = replaceText(await readSmall(file, EDIT_LIMIT), args);
    await atomicWrite(file, content, signal);
  } else {
    if (typeof args.content !== 'string'
      || Buffer.byteLength(args.content) > WRITE_LIMIT) throw new Error('File content must be text smaller than 1 MB');
    content = args.content;
    // Without overwrite the file must be new; the create cannot clobber a file that appears meanwhile.
    if (args.overwrite) await atomicWrite(file, content, signal); else await atomicCreate(file, content, signal);
  }
  return `Saved ${ws.relative(file)} (${Buffer.byteLength(content)} bytes)`;
}

async function listDir(ws: Workspace, target: string): Promise<string> {
  const entries = await fs.readdir(target, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));
  const type = (entry: (typeof entries)[number]) => (entry.isSymbolicLink() ? 'symlink' : entry.isDirectory()
    ? 'directory' : 'file');
  return JSON.stringify({
    path: ws.relative(target),
      entries: entries.slice(0, MAX_LISTED).map(entry => ({ name: entry.name, type: type(entry) })),
    truncated: entries.length > MAX_LISTED,
  });
}

async function globFiles(ws: Workspace, target: string, pattern: unknown, signal?: AbortSignal): Promise<string> {
  const regex = globRegex(pattern), matches: string[] = [];
  for await (const file of walk(target, 0, signal)) {
    if (regex.test(path.relative(target, file).split(path.sep).join('/'))) matches.push(ws.relative(file));
    if (matches.length >= MAX_GLOB_MATCHES) break;
  }
  return JSON.stringify({ matches, truncated: matches.length >= MAX_GLOB_MATCHES });
}

/** Regular-expression search, run in a worker so a pathological pattern cannot stall the server. */
async function grep(ws: Workspace, target: string, isFile: boolean, args: Args, signal?: AbortSignal): Promise<string> {
  if (typeof args.query !== 'string' || !args.query
    || args.query.length > 4096) throw new Error('Search query must contain 1–4096 characters');
  const mode = typeof args.output_mode === 'string' ? args.output_mode : 'content';
  const filter = args.glob ? globRegex(args.glob) : null;
  const cap = limit(args.head_limit, 1, 200, mode === 'content' ? 80 : 200), context = limit(args.context, 0, 10, 2);
  const results: unknown[] = [];
  const matcher = new RegexMatcher(args.query, Boolean(args.case_insensitive), mode);
  const files = isFile ? (async function* () { yield target; })() : walk(target, 0, signal);
  let scanned = 0;
  try {
    for await (const file of files) {
      signal?.throwIfAborted();
      if (scanned++ >= MAX_GREP_FILES) break;
      const relative = ws.relative(file);
      if (filter && !filter.test(relative)) continue;
      if ((await fs.stat(file)).size > MAX_GREP_FILE_BYTES) continue;
      const text = await fs.readFile(file, { encoding: 'utf8', signal });
      if (text.includes('\0')) continue;
      const lines = text.split(/\r?\n/);
      const wanted = mode === 'files' ? 1 : mode === 'count' ? 200 : cap - results.length;
      const matched = await matcher.match(lines, wanted, signal);
      if (mode !== 'files' && mode !== 'count') {
        for (const index of matched.matches) {
          const first = Math.max(0, index - context);
          const around = lines.slice(first,
            index + context + 1).map((line,
              offset) => ({ line: first + offset + 1, text: line.slice(0, MAX_LINE_CHARS) }));
          results.push({ path: relative, line: index + 1, text: lines[index]!.slice(0, MAX_LINE_CHARS),
            context: around });
        }
      }
      if (matched.count && mode === 'files') results.push(relative);
      if (matched.count && mode === 'count') results.push({ path: relative, count: matched.count });
      if (results.length >= cap) break;
    }
  } finally { await matcher.close(); }
  return JSON.stringify({ results, truncated: results.length >= cap });
}

export async function executeFilesystem(ws: Workspace, name: string, args: Args,
  signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  if (name === 'read_file') return readFilePage(ws, args, signal);
  if (name === 'apply_patch') return applyPatch(ws, args.patch, signal);
  if (name === 'write_file' || name === 'str_replace'
    || name === 'delete_file') return ws.transaction(() => modify(ws, name, args, signal), signal);
  const target = await ws.resolve(args.path || '.');
  const meta = await fs.stat(target);
  signal?.throwIfAborted();
  if (name === 'list_dir') {
    if (!meta.isDirectory()) throw new Error('Path is not a directory');
    return listDir(ws, target);
  }
  if (name === 'glob') {
    if (!meta.isDirectory()) throw new Error('Glob path must be a directory');
    return globFiles(ws, target, args.pattern, signal);
  }
  if (name === 'grep') return grep(ws, target, meta.isFile(), args, signal);
  throw new Error(`Unknown filesystem tool: ${name}`);
}

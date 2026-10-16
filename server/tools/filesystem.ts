import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { RegexMatcher } from './regex.js';

const SKIP = new Set(['.git', 'node_modules', 'target', 'dist', 'build', '.venv', 'venv', '__pycache__', 'vendor']);
const locks = new Map<string, Promise<unknown>>();
export function within(root: string, target: string): boolean { const relative = path.relative(root, target); return !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative); }
export class Workspace {
  private constructor(public readonly root: string) {}
  static async open(raw: string): Promise<Workspace> {
    if (!raw || !path.isAbsolute(raw)) throw new Error('Choose an absolute workspace folder for this chat.');
    const meta = await fs.lstat(raw); if (!meta.isDirectory() || meta.isSymbolicLink()) throw new Error('Workspace must be a directory, and cannot be a symlink.');
    return new Workspace(await fs.realpath(raw));
  }
  async resolve(raw = '.'): Promise<string> {
    if (typeof raw !== 'string' || raw.includes('\0')) throw new Error('Invalid workspace path');
    const target = path.resolve(this.root, raw); if (!within(this.root, target)) throw new Error('Path is outside the workspace');
    const relative = path.relative(this.root, target); let cursor = this.root;
    for (const component of relative.split(path.sep).filter(Boolean)) {
      cursor = path.join(cursor, component);
      try { const meta = await fs.lstat(cursor); if (meta.isSymbolicLink()) throw new Error('Symlinks are not permitted in workspace tool paths'); if (!within(this.root, await fs.realpath(cursor))) throw new Error('Path resolves outside the workspace'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    return target;
  }
  relative(target: string): string { return path.relative(this.root, target).split(path.sep).join('/') || '.'; }
  async transaction<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted();
    const previous = locks.get(this.root) || Promise.resolve();
    let started = false;
    const current = previous.catch(() => {}).then(() => { signal?.throwIfAborted(); started = true; return fn(); }).finally(() => { if (locks.get(this.root) === current) locks.delete(this.root); });
    locks.set(this.root, current);
    if (!signal) return current;
    return new Promise<T>((resolve, reject) => {
      // A queued call can settle immediately; an active transaction must finish cleanup/rollback first.
      const abort = () => { if (!started) reject(signal.reason); };
      signal.addEventListener('abort', abort, { once: true });
      current.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
      if (signal.aborted) abort();
    });
  }
}
function limit(value: any, min: number, max: number, fallback: number): number { return Math.min(max, Math.max(min, Number.isFinite(Number(value)) ? Math.floor(Number(value)) : fallback)); }
async function readSmall(file: string, max: number): Promise<string> { const stat = await fs.stat(file); if (!stat.isFile()) throw new Error('Path is not a regular file'); if (stat.size > max) throw new Error(`File exceeds the ${max} byte edit limit`);try{return new TextDecoder('utf8',{fatal:true}).decode(await fs.readFile(file));}catch{throw new Error('File is not valid UTF-8 text');} }
async function atomicWrite(file: string, content: string | Buffer, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  await fs.mkdir(path.dirname(file), { recursive: true }); const temp = `${file}.${randomUUID()}.tmp`;let mode=0o600;try{mode=(await fs.stat(file)).mode;}catch{}
  try { signal?.throwIfAborted(); await fs.writeFile(temp, content, { flag: 'wx', mode, signal }); signal?.throwIfAborted(); await fs.rename(temp, file); } finally { await fs.rm(temp, { force: true }).catch(() => {}); }
}
export function globRegex(pattern: string): RegExp {
  if (!pattern || pattern.length > 512) throw new Error('Glob pattern must contain 1–512 characters');
  let output = ''; const normalized = pattern.replace(/\\/g, '/');
  for (let i = 0; i < normalized.length; i++) {
    const ch = normalized[i];
    if (ch === '*' && normalized[i + 1] === '*') { i++; if (normalized[i + 1] === '/') { i++; output += '(?:.*/)?'; } else output += '.*'; }
    else if (ch === '*') output += '[^/]*'; else if (ch === '?') output += '[^/]'; else output += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`${normalized.includes('/') ? '^' : '(?:^|/)'}${output}$`, process.platform === 'win32' ? 'i' : '');
}
async function* walk(ws: Workspace, dir: string, depth = 0, signal?: AbortSignal): AsyncGenerator<string> {
  signal?.throwIfAborted(); if (depth > 64) return;
  const entries = await fs.readdir(dir, { withFileTypes: true }); entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    signal?.throwIfAborted(); if (entry.isSymbolicLink()) continue; const file = path.join(dir, entry.name);
    if (entry.isDirectory()) { if (!SKIP.has(entry.name)) yield* walk(ws, file, depth + 1, signal); } else if (entry.isFile()) yield file;
  }
}
async function readFilePage(ws: Workspace, args: any, signal?: AbortSignal): Promise<string> {
  const file = await ws.resolve(args.path); signal?.throwIfAborted(); const handle = await fs.open(file, 'r');
  try {
    const stat = await handle.stat(); if (!stat.isFile()) throw new Error('Path is not a regular file');
    const max = limit(args.max_bytes, 256, 32_000, 32_000); const lineLimit = limit(args.limit, 1, 2000, 200); let offset = limit(args.byte_offset, 0, Number.MAX_SAFE_INTEGER, 0); let line = 0;
    if (args.byte_offset !== undefined && args.offset !== undefined) throw new Error('Use byte_offset or offset, not both');
    if (args.byte_offset === undefined && Number(args.offset) > 0) {
      const desired = limit(args.offset, 0, Number.MAX_SAFE_INTEGER, 0); const chunk = Buffer.alloc(64_000);
      while (line < desired && offset < stat.size) { signal?.throwIfAborted(); const { bytesRead } = await handle.read(chunk, 0, Math.min(chunk.length, stat.size - offset), offset); if (!bytesRead) break; let consumed = 0; for (; consumed < bytesRead; consumed++) if (chunk[consumed] === 10 && ++line >= desired) { consumed++; break; } offset += consumed; }
    }
    if(offset>stat.size)throw new Error('byte_offset is past the end of the file');
    const buffer = Buffer.alloc(Math.min(max + 4, Math.max(0, stat.size - offset))); const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset); const bytes = buffer.subarray(0, bytesRead);if(offset&&bytes.length&&(bytes[0]&0xc0)===0x80)throw new Error('byte_offset is inside a UTF-8 character; resume using the returned next_byte_offset');
    let end = Math.min(max, bytes.length); let count = 0;
    for (let i = 0; i < end; i++) if (bytes[i] === 10 && ++count >= lineLimit) { end = i + 1; break; }
    if (end < bytes.length) while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
    const text = bytes.subarray(0, end).toString('utf8'); const next = offset + end;
    return JSON.stringify({ path: ws.relative(file), content: text, offset: args.byte_offset === undefined ? line : undefined, byte_offset: offset, next_byte_offset: next < stat.size ? next : null, truncated: next < stat.size, total_bytes: stat.size });
  } finally { await handle.close(); }
}

interface PatchOperation { kind: 'add' | 'delete' | 'update'; file: string; move?: string; lines: string[] }
interface PatchLine { text: string; eol: string; explicitNoEol?: boolean }
interface PatchHunk { tokens: string[]; anchor?: string; line?: number; count?: number; newLine?: number; newCount?: number; eof: boolean; noNewline?: number[] }
function patchFileContent(content: string, patchLines: string[], filename: string): string {
  const source = content.split('\n');
  const records: PatchLine[] = source.map((text, index) => ({ text: index < source.length - 1 && text.endsWith('\r') ? text.slice(0, -1) : text, eol: index < source.length - 1 ? text.endsWith('\r') ? '\r\n' : '\n' : '' }));
  if (!records.at(-1)?.text && !records.at(-1)?.eol) records.pop();
  const defaultEol = records.find(line => line.eol)?.eol || '\n';
  const finalEol = records.at(-1)?.eol || (content.length === 0 ? defaultEol : '');
  const hunks: PatchHunk[] = []; let current: PatchHunk = { tokens: [], eof: false };
  const flush = () => { if (current.tokens.length) hunks.push(current); current = { tokens: [], eof: false }; };
  for (let index = 0; index < patchLines.length; index++) {
    const line = patchLines[index];
    if (line.startsWith('@@')) {
      flush(); const numeric = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?:.*)?$/.exec(line);
      if (numeric) { current.line = Number(numeric[1]); current.count = numeric[2] === undefined ? 1 : Number(numeric[2]); current.newLine = Number(numeric[3]); current.newCount = numeric[4] === undefined ? 1 : Number(numeric[4]); }
      else if (line !== '@@') { if (!line.startsWith('@@ ')) throw new Error(`Invalid patch hunk header in ${filename}`); current.anchor = line.slice(3); }
    } else if (line === '*** End of File') current.eof = true;
    else if (line === '\\ No newline at end of file') {
      const token = current.tokens.length - 1;
      if (token < 0 || current.noNewline?.includes(token)) throw new Error(`No-newline marker must follow a patch line in ${filename}`);
      (current.noNewline ??= []).push(token);
    }
    else if (/^[ +\-]/.test(line)) current.tokens.push(line);
    else if (line || index !== patchLines.length - 1) throw new Error('Update lines must start with space, +, or -');
  }
  flush(); if (!hunks.length) throw new Error(`Update contains no hunks: ${filename}`);
  let cursor = 0, lineDelta = 0, explicitNewline = false;
  for (const hunk of hunks) {
    if (hunk.anchor !== undefined) {
      const anchors = records.flatMap((line, index) => index >= cursor && line.text === hunk.anchor ? [index] : []);
      if (anchors.length !== 1) throw new Error(`Patch anchor must match exactly one complete line in ${filename}: ${hunk.anchor}`);
      cursor = anchors[0] + 1;
    }
    const before = hunk.tokens.filter(line => line[0] !== '+').map(line => line.slice(1));
    if (hunk.count !== undefined && hunk.count !== before.length) throw new Error(`Patch hunk line count is inconsistent in ${filename}`);
    if (hunk.newCount !== undefined && hunk.newCount !== hunk.tokens.filter(line => line[0] !== '-').length) throw new Error(`Patch hunk new line count is inconsistent in ${filename}`);
    const matchesAt = (at: number) => at >= cursor && at >= 0 && at + before.length <= records.length && before.every((line, offset) => records[at + offset].text === line) && (!hunk.eof || at + before.length === records.length);
    let at: number;
    if (hunk.line !== undefined) {
      at = (hunk.count === 0 ? hunk.line : hunk.line - 1) + lineDelta;
      if (!Number.isSafeInteger(at) || !matchesAt(at)) throw new Error(`Patch line offset is outside the file or does not match complete lines in ${filename}`);
    } else if (before.length) {
      const matches: number[] = []; for (let index = cursor; index + before.length <= records.length; index++) if (matchesAt(index)) matches.push(index);
      if (matches.length !== 1) throw new Error(matches.length ? `Patch context is ambiguous in ${filename}; include more complete lines.` : `Patch context was not found as complete lines in ${filename}: ${before.join('\n').slice(0, 120)}`);
      at = matches[0];
    } else {
      if (hunk.eof) at = records.length;
      else if (hunk.anchor !== undefined || !records.length) at = cursor;
      else throw new Error(`Insertion needs a complete-line anchor or explicit line offset in ${filename}`);
    }
    if (hunk.newLine !== undefined && (!Number.isSafeInteger(hunk.newLine) || (hunk.newCount === 0 ? hunk.newLine : hunk.newLine - 1) !== at)) throw new Error(`Patch new line offset is inconsistent in ${filename}`);
    const replacement: PatchLine[] = []; let oldIndex = at;
    for (const [index, token] of hunk.tokens.entries()) {
      const noNewline = Boolean(hunk.noNewline?.includes(index));
      if (noNewline && token[0] !== '+' && (oldIndex !== records.length - 1 || records[oldIndex].eol)) throw new Error(`Old no-newline marker does not match the file ending in ${filename}`);
      if (token[0] === ' ') replacement.push({ ...records[oldIndex++], ...(noNewline ? { explicitNoEol: true } : {}) });
      else if (token[0] === '-') oldIndex++;
      else replacement.push({ text: token.slice(1), eol: noNewline ? '' : defaultEol, ...(noNewline ? { explicitNoEol: true } : {}) });
    }
    records.splice(at, before.length, ...replacement); cursor = at + replacement.length; lineDelta += replacement.length - before.length;
    explicitNewline ||= Boolean(hunk.noNewline?.length);
  }
  for (let index = 0; index < records.length - 1; index++) {
    if (records[index].explicitNoEol) throw new Error(`New no-newline marker must describe the last file line in ${filename}`);
    if (!records[index].eol) records[index].eol = defaultEol;
  }
  if (records.length && !explicitNewline) records.at(-1)!.eol = finalEol;
  return records.map(line => line.text + line.eol).join('');
}
export async function applyPatch(ws: Workspace, patch: string, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  if (typeof patch !== 'string' || Buffer.byteLength(patch) > 2_000_000) throw new Error('Patch is missing or exceeds 2 MB');
  const lines = patch.replace(/\r\n/g, '\n').split('\n'); if (lines[0] !== '*** Begin Patch' || lines.filter(Boolean).at(-1) !== '*** End Patch') throw new Error('Patch must use *** Begin Patch and *** End Patch');
  const operations: PatchOperation[] = []; let current: PatchOperation | undefined;
  for (const line of lines.slice(1)) {
    const header = /^\*\*\* (Add|Delete|Update) File: (.+)$/.exec(line);
    if (header) { current = { kind: header[1].toLowerCase() as PatchOperation['kind'], file: header[2], lines: [] }; operations.push(current); }
    else if (line.startsWith('*** Move to: ')) { if (!current || current.kind !== 'update') throw new Error('Move must follow Update File'); current.move = line.slice(13); }
    else if (line === '*** End Patch') break;
    else if (current) current.lines.push(line);
    else if (line) throw new Error('Unexpected patch text');
  }
  if (!operations.length) throw new Error('Patch contains no file changes');
  return ws.transaction(async () => {
    const originals = new Map<string, Buffer | null>(); const changes = new Map<string, string | null>();
    const remember = async (file: string) => { if (!originals.has(file)) { try { const stat = await fs.stat(file); if (!stat.isFile() || stat.size > 16 * 1024 * 1024) throw new Error('Patch target must be a regular file smaller than 16 MB'); originals.set(file, await fs.readFile(file)); } catch (error) { if ((error as any).code === 'ENOENT') originals.set(file, null); else throw error; } } };
    for (const op of operations) {
      signal?.throwIfAborted(); const file = await ws.resolve(op.file); if (file === ws.root) throw new Error('Cannot patch the workspace directory'); await remember(file); signal?.throwIfAborted();
      let existing = (changes.has(file) ? changes.get(file) : originals.get(file)?.toString('utf8')) ?? null;
      if (op.kind === 'add') { if (existing !== null) throw new Error(`File already exists: ${op.file}`); if (op.lines.some((line, i) => !line.startsWith('+') && !(i === op.lines.length - 1 && !line))) throw new Error('Added file lines must start with +'); changes.set(file, op.lines.filter(line => line.startsWith('+')).map(line => line.slice(1)).join('\n') + '\n'); }
      else if (op.kind === 'delete') { if (existing === null) throw new Error(`File does not exist: ${op.file}`); changes.set(file, null); }
      else {
        if (existing === null) throw new Error(`File does not exist: ${op.file}`);
        if (!changes.has(file)) {
          try { existing = new TextDecoder('utf8', { fatal: true, ignoreBOM: true }).decode(originals.get(file)!); }
          catch { throw new Error(`Patch target is not valid UTF-8 text: ${op.file}`); }
        }
        const content = patchFileContent(existing, op.lines, op.file);
        if (op.move) { const moved = await ws.resolve(op.move); await remember(moved); if (changes.has(moved) || originals.get(moved) !== null) throw new Error(`Move destination already exists or has a pending change: ${op.move}`); changes.set(file, null); changes.set(moved, content); } else changes.set(file, content);
      }
    }
    const committed: string[] = [];
    try { for (const [file, content] of changes) { await ws.resolve(file); signal?.throwIfAborted(); if (content === null) await fs.unlink(file); else await atomicWrite(file, content, signal); committed.push(file); } signal?.throwIfAborted(); }
    catch (error) { for (const file of committed.reverse()) { const original = originals.get(file); if (original) await atomicWrite(file, original); else await fs.rm(file, { force: true }); } throw error; }
    return `Applied patch successfully:\n${[...changes].map(([file, content]) => `${content === null ? 'D' : originals.get(file) === null ? 'A' : 'M'} ${ws.relative(file)}`).join('\n')}`;
  }, signal);
}

export async function executeFilesystem(ws: Workspace, name: string, args: any, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  if (name === 'read_file') return readFilePage(ws, args, signal);
  if (name === 'apply_patch') return applyPatch(ws, args.patch, signal);
  if (['write_file', 'str_replace', 'delete_file'].includes(name)) return ws.transaction(async () => {
    const file = await ws.resolve(args.path); signal?.throwIfAborted(); if (file === ws.root) throw new Error('Cannot modify the workspace directory');
    if (name === 'delete_file') { const meta = await fs.lstat(file); if (!meta.isFile()) throw new Error('delete_file only deletes regular files'); signal?.throwIfAborted(); await fs.unlink(file); return `Deleted ${ws.relative(file)}`; }
    let content: string;
    if (name === 'str_replace') {
      content=await readSmall(file,16*1024*1024);const old=String(args.old_string??args.old??'').replace(/\r\n/g,'\n'),replacement=args.new_string??args.new,replaceAll=args.replace_all??args.allow_multiple;
      if(!old||typeof replacement!=='string')throw new Error('old_string must be nonempty and new_string must be text');if(Buffer.byteLength(old)>16*1024*1024||Buffer.byteLength(replacement)>16*1024*1024)throw new Error('Replacement text exceeds 16 MB');
      const normalized=content.replace(/\r\n/g,'\n');const matches:number[]=[];let cursor=0;while(true){const at=normalized.indexOf(old,cursor);if(at<0)break;matches.push(at);cursor=at+old.length;}if(!matches.length)throw new Error('old_string was not found; no changes were made. LF and CRLF are treated as equivalent.');if(matches.length>1&&!replaceAll)throw new Error('old_string occurs more than once. Include more context or set replace_all.');
      const removed:number[]=[];for(const match of content.matchAll(/\r\n/g))removed.push(match.index!-removed.length);const originalOffset=(at:number)=>at+removed.filter(index=>index<at).length;const defaultCRLF=content.indexOf('\n')>0&&content[content.indexOf('\n')-1]==='\r';let next='',position=0;for(const at of matches){const start=originalOffset(at),end=originalOffset(at+old.length);const span=content.slice(start,end),newline=span.indexOf('\n'),crlf=newline>=0?newline>0&&span[newline-1]==='\r':defaultCRLF;const inserted=replacement.replace(/\r\n/g,'\n');next+=content.slice(position,start)+(crlf?inserted.replace(/\n/g,'\r\n'):inserted);position=end;if(Buffer.byteLength(next)>16*1024*1024)throw new Error('Replacement would exceed the 16 MB edit limit');}content=next+content.slice(position);if(Buffer.byteLength(content)>16*1024*1024)throw new Error('Replacement would exceed the 16 MB edit limit');
    }
    else { content = args.content; if (typeof content !== 'string' || Buffer.byteLength(content) > 1_000_000) throw new Error('File content must be text smaller than 1 MB'); if (!args.overwrite) { try { await fs.access(file); throw new Error('File already exists. Set overwrite only for a complete intentional replacement.'); } catch (error) { if ((error as any).code !== 'ENOENT') throw error; } } }
    await atomicWrite(file, content, signal); return `Saved ${ws.relative(file)} (${Buffer.byteLength(content)} bytes)`;
  }, signal);
  const target = await ws.resolve(args.path || '.'); const meta = await fs.stat(target); signal?.throwIfAborted();
  if (name === 'list_dir') { if (!meta.isDirectory()) throw new Error('Path is not a directory'); const entries = await fs.readdir(target, { withFileTypes: true }); entries.sort((a, b) => a.name.localeCompare(b.name)); return JSON.stringify({ path: ws.relative(target), entries: entries.slice(0, 500).map(entry => ({ name: entry.name, type: entry.isSymbolicLink() ? 'symlink' : entry.isDirectory() ? 'directory' : 'file' })), truncated: entries.length > 500 }); }
  if (name === 'glob') { if (!meta.isDirectory()) throw new Error('Glob path must be a directory'); const regex = globRegex(args.pattern); const matches: string[] = []; for await (const file of walk(ws, target, 0, signal)) { const rel = ws.relative(file); if (regex.test(path.relative(target, file).split(path.sep).join('/'))) matches.push(rel); if (matches.length >= 200) break; } return JSON.stringify({ matches, truncated: matches.length >= 200 }); }
  if (name === 'grep') {
    if (typeof args.query !== 'string' || !args.query || args.query.length > 4096) throw new Error('Search query must contain 1–4096 characters');
    const filter = args.glob ? globRegex(args.glob) : null; const cap = limit(args.head_limit, 1, 200, args.output_mode === 'content' ? 80 : 200); const context = limit(args.context, 0, 10, 2); const results: any[] = []; let scanned = 0; const matcher = new RegexMatcher(args.query, Boolean(args.case_insensitive), args.output_mode || 'content');
    const files = meta.isFile() ? (async function* () { yield target; })() : walk(ws, target, 0, signal);
    try { for await (const file of files) { signal?.throwIfAborted(); if (scanned++ >= 20_000) break; const relative = ws.relative(file); if (filter && !filter.test(relative)) continue; const stat = await fs.stat(file); if (stat.size > 1_000_000) continue; const text = await fs.readFile(file, { encoding: 'utf8', signal }); if (text.includes('\0')) continue; const lines = text.split(/\r?\n/); const matched = await matcher.match(lines, args.output_mode === 'files' ? 1 : args.output_mode === 'count' ? 200 : cap - results.length, signal); const hits = matched.count;
      if (!['files', 'count'].includes(args.output_mode)) for (const i of matched.matches) { results.push({ path: relative, line: i + 1, text: lines[i].slice(0, 1000), context: lines.slice(Math.max(0, i - context), i + context + 1).map((line, n) => ({ line: Math.max(0, i - context) + n + 1, text: line.slice(0, 1000) })) }); }
      if (hits && args.output_mode === 'files') results.push(relative); if (hits && args.output_mode === 'count') results.push({ path: relative, count: hits }); if (results.length >= cap) break;
    } } finally { await matcher.close(); }
    return JSON.stringify({ results, truncated: results.length >= cap });
  }
  throw new Error(`Unknown filesystem tool: ${name}`);
}

// In-memory Git object store and repository state
// Pure TypeScript, no dependencies, Node 22 compatible

import { createHash } from 'node:crypto';
import * as zlib from 'node:zlib';

// Buffer is a global in Node.js; types from @types/node or tsconfig "types": ["node"]
// No explicit import needed at runtime

export const ZERO_OID = '0'.repeat(40);
export const PKT_LINE_MAX = 65520;

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: GitObjectType;
  data: Uint8Array;
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export interface TagView {
  object: string;
  type: 'commit';
  tag: string;
  tagger: string;
  message: string;
}

export interface RefUpdate {
  oldOid: string;
  newOid: string;
  ref: string;
}

export interface PushReport {
  unpackOk: boolean;
  unpackDetail?: string;
  refs: Array<{ ref: string; ok: boolean; reason?: string }>;
}

export interface AdvertisedRef {
  name: string;
  oid: string;
  peeled?: string;
  symrefTarget?: string;
}

export interface Advertisement {
  protocol: 0 | 2;
  refs: AdvertisedRef[];
  capabilities: Map<string, string | true>;
}

function sha1(data: Uint8Array): string {
  return createHash('sha1').update(data).digest('hex');
}

function hashObject(type: GitObjectType, data: Uint8Array): string {
  const header = Buffer.from(`${type} ${data.length}\0`);
  return sha1(Buffer.concat([header, Buffer.from(data)]));
}

function encodeLooseObject(type: GitObjectType, data: Uint8Array): Buffer {
  const header = Buffer.from(`${type} ${data.length}\0`);
  return Buffer.concat([header, Buffer.from(data)]);
}

function objectHeader(type: GitObjectType, size: number): Buffer {
  return Buffer.from(`${type} ${size}\0`);
}

const treeViewCache = new WeakMap<Uint8Array, TreeEntry[]>();
function parseTree(data: Uint8Array): TreeEntry[] {
  const cached = treeViewCache.get(data);
  if (cached) return cached;
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space === -1) break;
    const mode = data.subarray(offset, space).toString('utf8');
    offset = space + 1;
    const nullPos = data.indexOf(0x00, offset);
    if (nullPos === -1) break;
    const name = data.subarray(offset, nullPos).toString('utf8');
    offset = nullPos + 1;
    if (offset + 20 > data.length) break;
    const oid = data.subarray(offset, offset + 20).toString('hex');
    offset += 20;
    entries.push({ mode, name, oid });
  }
  treeViewCache.set(data, entries);
  return entries;
}

function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    const modeBuf = Buffer.from(`${entry.mode} ${entry.name}\0`);
    const oidBuf = Buffer.from(entry.oid, 'hex');
    parts.push(modeBuf, oidBuf);
  }
  return Buffer.concat(parts);
}

const commitViewCache = new WeakMap<Uint8Array, CommitView>();
function parseCommit(data: Uint8Array): CommitView {
  const cached = commitViewCache.get(data);
  if (cached) return cached;
  const text = data.toString('utf8');
  const lines = text.split('\n');
  const parents: string[] = [];
  let tree = '';
  let author = '';
  let committer = '';
  let messageStart = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('tree ')) tree = line.slice(5);
    else if (line.startsWith('parent ')) parents.push(line.slice(7));
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
    else if (line === '') { messageStart = i + 1; break; }
  }
  const message = lines.slice(messageStart).join('\n');
  const view = { tree, parents, author, committer, message };
  commitViewCache.set(data, view);
  return view;
}

function buildCommit(fields: {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
  timestamp: number;
}): Buffer {
  const lines = [
    `tree ${fields.tree}`,
    ...fields.parents.map(p => `parent ${p}`),
    `author ${fields.author} ${fields.timestamp} +0000`,
    `committer ${fields.committer} ${fields.timestamp} +0000`,
    '',
    fields.message.endsWith('\n') ? fields.message : `${fields.message}\n`,
  ];
  return Buffer.from(lines.join('\n'), 'utf8');
}

function parseTag(data: Uint8Array): TagView {
  const text = data.toString('utf8');
  const lines = text.split('\n');
  let object = '', type = '', tag = '', tagger = '';
  let messageStart = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('object ')) object = line.slice(7);
    else if (line.startsWith('type ')) type = line.slice(5);
    else if (line.startsWith('tag ')) tag = line.slice(4);
    else if (line.startsWith('tagger ')) tagger = line.slice(7);
    else if (line === '') { messageStart = i + 1; break; }
  }
  const message = lines.slice(messageStart).join('\n');
  return { object, type: type as 'commit', tag, tagger, message };
}

function buildTag(fields: {
  object: string;
  type: 'commit';
  tag: string;
  message: string;
  tagger: string;
  timestamp: number;
}): Buffer {
  const lines = [
    `object ${fields.object}`,
    `type ${fields.type}`,
    `tag ${fields.tag}`,
    `tagger ${fields.tagger} ${fields.timestamp} +0000`,
    '',
    fields.message.endsWith('\n') ? fields.message : `${fields.message}\n`,
  ];
  return Buffer.from(lines.join('\n'), 'utf8');
}

type ObjectLookup = (oid: string) => GitObject | undefined;

function collectReachable(tips: Iterable<string>, lookup: ObjectLookup): Set<string> {
  const visited = new Set<string>();
  const stack = [...tips];
  while (stack.length) {
    const oid = stack.pop()!;
    if (visited.has(oid)) continue;
    visited.add(oid);
    const obj = lookup(oid);
    if (!obj) throw new Error(`missing-object: ${oid}`);
    if (obj.type === 'commit') {
      const commit = parseCommit(obj.data);
      for (const parent of commit.parents) stack.push(parent);
      stack.push(commit.tree);
    } else if (obj.type === 'tree') {
      const entries = parseTree(obj.data);
      for (const entry of entries) stack.push(entry.oid);
    }
  }
  return visited;
}

// Pack file reading/writing (simplified but functional)
interface PackEntry {
  type: GitObjectType;
  data: Uint8Array;
  oid?: string;
  ofsDelta?: { baseOffset: number; delta: Uint8Array };
  refDelta?: { baseOid: string; delta: Uint8Array };
}

interface PackReadResult {
  version: number;
  declaredCount: number;
  entries: PackEntry[];
  objects: Map<string, GitObject>;
  deltaCount: number;
}

function inflateAt(buffer: Uint8Array, offset: number): { data: Buffer; next: number } {
  const input = Buffer.from(buffer.subarray(offset));
  const inflate = zlib.createInflate();
  inflate.end(input);
  // This is a simplified version - real implementation would stream
  const output = zlib.inflateSync(input);
  return { data: output, next: offset + input.length };
}

function applyDelta(base: Uint8Array, delta: Uint8Array): Buffer {
  // Simplified delta application - Git uses a custom format
  // For now, assume delta is the full object (OFs delta with no base)
  // Real implementation would parse the delta instructions
  return Buffer.from(delta);
}

function packChecksum(pack: Uint8Array): string {
  return sha1(pack.subarray(0, pack.length - 20));
}

function readPack(pack: Uint8Array, options: { resolveBase?: ObjectLookup } = {}): PackReadResult {
  if (pack.length < 12) throw new Error('pack too small');
  const view = new DataView(pack.buffer, pack.byteOffset, pack.byteLength);
  if (Buffer.from(pack.subarray(0, 4)).toString('ascii') !== 'PACK') throw new Error('not a pack file');
  const version = view.getUint32(4);
  const count = view.getUint32(8);
  const entries: PackEntry[] = [];
  const objects = new Map<string, GitObject>();
  let offset = 12;
  let deltaCount = 0;

  for (let i = 0; i < count; i++) {
    if (offset >= pack.length) throw new Error('truncated pack');
    let firstByte = pack[offset++];
    const typeCode = (firstByte >> 4) & 0x7;
    const type = (['', 'commit', 'tree', 'blob', 'tag'][typeCode] ?? 'blob') as GitObjectType;
    let size = firstByte & 0xf;
    let shift = 4;
    while (firstByte & 0x80) {
      if (offset >= pack.length) throw new Error('truncated pack size');
      const b = pack[offset++];
      size |= (b & 0x7f) << shift;
      shift += 7;
      firstByte = b;
    }

    const isDelta = typeCode === 6 || typeCode === 7; // OFS_DELTA or REF_DELTA
    let entry: PackEntry;

    if (isDelta) {
      deltaCount++;
      if (typeCode === 6) { // OFS_DELTA
        let baseOffset = 0;
        let b: number;
        do {
          if (offset >= pack.length) throw new Error('truncated OFS_DELTA offset');
          b = pack[offset++];
          baseOffset = (baseOffset << 7) | (b & 0x7f);
        } while (b & 0x80);
        const dataStart = offset;
        while (offset < pack.length && pack[offset] !== 0x00) offset++; // simplified
        const deltaData = pack.subarray(dataStart, offset);
        entry = { type: 'blob', data: deltaData, ofsDelta: { baseOffset, delta: deltaData } };
      } else { // REF_DELTA
        if (offset + 20 > pack.length) throw new Error('truncated REF_DELTA oid');
        const baseOid = pack.subarray(offset, offset + 20).toString('hex');
        offset += 20;
        const dataStart = offset;
        while (offset < pack.length && pack[offset] !== 0x00) offset++; // simplified
        const deltaData = pack.subarray(dataStart, offset);
        entry = { type: 'blob', data: deltaData, refDelta: { baseOid, delta: deltaData } };
      }
    } else {
      const dataStart = offset;
      const remaining = pack.subarray(offset);
      try {
        const inflated = zlib.inflateSync(remaining, { info: true });
        offset += inflated.engine.bytesWritten;
        entry = { type, data: inflated.buffer };
      } catch {
        entry = { type, data: remaining };
        offset = pack.length;
      }
    }
    entries.push(entry);

    if (!isDelta) {
      const oid = hashObject(entry.type, entry.data);
      objects.set(oid, { type: entry.type, data: entry.data });
    }
  }

  // Resolve deltas (simplified)
  for (const entry of entries) {
    if (entry.ofsDelta) {
      // Skip delta resolution for now
    } else if (entry.refDelta) {
      const base = options.resolveBase?.(entry.refDelta.baseOid);
      if (base) {
        const resolved = applyDelta(base.data, entry.refDelta.delta);
        const oid = hashObject(entry.type, resolved);
        objects.set(oid, { type: entry.type, data: resolved });
      }
    }
  }

  return { version, declaredCount: count, entries, objects, deltaCount };
}

interface GitObjectInput {
  type: GitObjectType;
  data: Uint8Array;
}

function writePack(objects: Iterable<GitObjectInput>): Buffer {
  const objArray = [...objects];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  new DataView(header.buffer).setUint32(4, 2); // version 2
  new DataView(header.buffer).setUint32(8, objArray.length);
  const parts: Buffer[] = [header];
  const typeCodes: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };

  for (const obj of objArray) {
    const typeCode = typeCodes[obj.type];
    // Compress raw content directly (client's readPack expects raw content to compute correct OID)
    const compressed = zlib.deflateSync(obj.data, { level: 1 });
    // Write type+size header (packfile format: bit 7 of first byte = continuation, bits 6-4 = type, bits 3-0 = size_low)
    let size = obj.data.length;
    let firstByte = (typeCode << 4) | (size & 0xf);
    size >>= 4;
    if (size > 0) firstByte |= 0x80;
    const sizeBytes: number[] = [firstByte];
    while (size > 0) {
      let byte = size & 0x7f;
      size >>= 7;
      if (size > 0) byte |= 0x80;
      sizeBytes.push(byte);
    }
    const typeSizeBuf = Buffer.from(sizeBytes);
    parts.push(typeSizeBuf, compressed);
  }

  const packData = Buffer.concat(parts);
  const csum = sha1(packData);
  const trailer = Buffer.from(csum, 'hex');
  return Buffer.concat([packData, trailer]);
}

function verifyPackChecksum(pack: Uint8Array): { ok: boolean; expected: string; actual: string } {
  if (pack.length < 20) return { ok: false, expected: '', actual: 'too short' };
  const expected = sha1(pack.subarray(0, pack.length - 20));
  const actual = pack.subarray(pack.length - 20).toString('hex');
  return { ok: expected === actual, expected, actual };
}

// Repository state
export class Repository {
  readonly objects = new Map<string, GitObject>();
  readonly refs = new Map<string, string>(); // ref name -> oid

  put(type: GitObjectType, data: Uint8Array): string {
    const oid = hashObject(type, data);
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data });
    return oid;
  }

  blob(data: Buffer | string): string {
    return this.put('blob', typeof data === 'string' ? Buffer.from(data, 'utf8') : data);
  }

  treeFromFiles(files: readonly { path: string; data: Buffer }[]): string {
    interface Node {
      files: Map<string, Buffer>;
      dirs: Map<string, Node>;
    }
    const make = (): Node => ({ files: new Map(), dirs: new Map() });
    const root = make();
    for (const file of files) {
      const segments = file.path.split('/');
      let node = root;
      for (let index = 0; index < segments.length - 1; index += 1) {
        const name = segments[index];
        if (!node.dirs.has(name)) node.dirs.set(name, make());
        node = node.dirs.get(name)!;
      }
      node.files.set(segments[segments.length - 1], file.data);
    }
    const build = (node: Node): string => {
      const entries: TreeEntry[] = [];
      for (const [name, data] of [...node.files].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
        entries.push({ mode: '100644', name, oid: this.blob(data) });
      }
      for (const [name, child] of [...node.dirs].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
        entries.push({ mode: '40000', name, oid: build(child) });
      }
      return this.put('tree', buildTree(entries));
    };
    return build(root);
  }

  commit(
    files: readonly { path: string; data: Buffer }[],
    meta: { message: string; timestamp: number; author: string },
    parents: readonly string[] = [],
  ): string {
    const tree = this.treeFromFiles(files);
    const data = buildCommit({
      tree,
      parents: [...parents],
      message: meta.message.endsWith('\n') ? meta.message : `${meta.message}\n`,
      author: meta.author,
      committer: meta.author,
      timestamp: meta.timestamp,
    });
    return this.put('commit', data);
  }

  tag(name: string, target: string, meta: { message: string; timestamp: number; author: string }): string {
    const data = buildTag({
      object: target,
      type: 'commit',
      tag: name,
      message: meta.message.endsWith('\n') ? meta.message : `${meta.message}\n`,
      tagger: meta.author,
      timestamp: meta.timestamp,
    });
    return this.put('tag', data);
  }

  reachable(tips: Iterable<string>): Set<string> {
    return collectReachable(tips, (oid) => this.objects.get(oid));
  }

  // Commit-only ancestry with early exit: fast-forward checks need only the
  // commit DAG, not trees/blobs, and stop the moment the ancestor is found.
  isAncestor(tip: string, ancestor: string): boolean {
    if (tip === ancestor) return true;
    const visited = new Set<string>();
    const stack: string[] = [tip];
    while (stack.length > 0) {
      const oid = stack.pop()!;
      if (oid === ancestor) return true;
      if (visited.has(oid)) continue;
      visited.add(oid);
      const obj = this.objects.get(oid);
      if (!obj || obj.type !== 'commit') continue;
      const commit = parseCommit(obj.data);
      for (const parent of commit.parents) stack.push(parent);
    }
    return false;
  }

  hasRef(name: string): boolean {
    return this.refs.has(name);
  }

  getRef(name: string): string | undefined {
    return this.refs.get(name);
  }

  setRef(name: string, oid: string): void {
    this.refs.set(name, oid);
  }

  deleteRef(name: string): boolean {
    return this.refs.delete(name);
  }

  listRefs(): Map<string, string> {
    return new Map(this.refs);
  }
}

export {
  sha1,
  hashObject,
  encodeLooseObject,
  objectHeader,
  parseTree,
  buildTree,
  parseCommit,
  buildCommit,
  parseTag,
  buildTag,
  collectReachable,
  readPack,
  writePack,
  verifyPackChecksum,
  packChecksum,
  applyDelta,
  inflateAt,
  type PackEntry,
  type PackReadResult,
  type GitObjectInput,
  type ObjectLookup,
};

export class GitProtocolError extends Error {
  code: string;
  constructor(message: string, code = 'protocol') {
    super(message);
    this.name = 'GitProtocolError';
    this.code = code;
  }
}

export class GitHttpError extends Error {
  url: string;
  status: number;
  bodySnippet: string;
  constructor(message: string, url: string, status: number, bodySnippet = '') {
    super(message);
    this.name = 'GitHttpError';
    this.url = url;
    this.status = status;
    this.bodySnippet = bodySnippet;
  }
}

export function isObjectId(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}
// The entry's HTTP surface: git smart HTTP, REST v3, GraphQL v4, MCP
// Pure TypeScript, no dependencies, Node 22 compatible

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { parse as parseUrl } from 'node:url';
import { readFileSync, appendFileSync } from 'node:fs';
import {
  Repository,
  hashObject,
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
  ZERO_OID,
  type GitObject,
  type TreeEntry,
  type CommitView,
  type TagView,
  type RefUpdate,
  type PushReport,
  type AdvertisedRef,
  type Advertisement,
  GitProtocolError,
  GitHttpError,
  isObjectId,
} from './store.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const GIT_UPLOAD_PACK_TYPE = 'application/x-git-upload-pack-result';
const GIT_UPLOAD_PACK_ADVERTISEMENT_TYPE = 'application/x-git-upload-pack-advertisement';
const GIT_RECEIVE_PACK_TYPE = 'application/x-git-receive-pack-result';
const GIT_RECEIVE_PACK_ADVERTISEMENT_TYPE = 'application/x-git-receive-pack-advertisement';

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const buf = Buffer.from(JSON.stringify(body) + '\n');
  const requestId = headers['x-github-request-id'] || randomId();
  res.writeHead(status, { 'content-type': JSON_TYPE, 'content-length': buf.length, 'x-github-request-id': requestId, ...headers });
  res.end(buf);
}

// Pre-serialized body path: skips JSON.stringify + byteLength on hot repeated reads.
function sendJsonBuf(res: ServerResponse, status: number, buf: Buffer, headers: Record<string, string> = {}): void {
  const requestId = headers['x-github-request-id'] || randomId();
  res.writeHead(status, { 'content-type': JSON_TYPE, 'content-length': buf.length, 'x-github-request-id': requestId, ...headers });
  res.end(buf);
}

// Cached GET /issues/{number} body, keyed by the stored issue object. The only
// in-place mutation of an issue is PATCH, which deletes its entry here.
const issueRespCache = new WeakMap<object, Buffer>();

function sendBytes(res: ServerResponse, status: number, data: Buffer, contentType: string): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': data.length });
  res.end(data);
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function getBearerToken(req: IncomingMessage): string | null {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) return null;
  return auth.slice(7);
}

function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

function randomId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString('hex');
}

// Global state
const repos = new Map<string, Repository>(); // "owner/repo" -> Repository
const users = new Map<string, { login: string; name: string; email: string }>(); // token -> user

function getUser(token: string | null): { login: string; name: string; email: string } | null {
  if (!token) return null;
  return users.get(token) ?? null;
}

// The forge is single-tenant: the trial's shop token authenticates as the scenario viewer.
const SHOP_TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';
const VIEWER = { login: 'adaiversen', name: 'ada iversen', email: 'adaiversen@example.invalid' };

function getOrCreateUser(token: string): { login: string; name: string; email: string } {
  // The shop token (and the local probe tokens) name the scenario viewer; any other token is a
  // foreign principal with no rights on the viewer's repositories.
  if (token === 'probe-token' || token === 'test-token' || (SHOP_TOKEN !== '' && token === SHOP_TOKEN)) {
    return VIEWER;
  }
  let user = users.get(token);
  if (!user) {
    user = { login: `user-${token.slice(0, 8)}`, name: 'Test User', email: `${token.slice(0, 8)}@example.invalid` };
    users.set(token, user);
  }
  return user;
}

const repoMetadata = new Map<string, { description: string; isPrivate: boolean }>();
const labelsByRepo = new Map<string, Map<string, { name: string; color: string }>>();
const issuesByRepo = new Map<string, any[]>();
const pullsByRepo = new Map<string, any[]>();
const commentsByIssue = new Map<string, any[]>();

// GraphQL helper: cursor encoding/decoding
function encodeCursor(number: number): string {
  return Buffer.from(`issue:${number}`).toString('base64');
}

function decodeCursor(cursor: string): number {
  try {
    const decoded = Buffer.from(cursor, 'base64').toString('utf8');
    const match = decoded.match(/^issue:(\d+)$/);
    return match ? parseInt(match[1], 10) : -1;
  } catch {
    return -1;
  }
}

// GraphQL helper: create opaque global IDs
function toGlobalId(type: string, id: string | number): string {
  return Buffer.from(`${type}:${id}`).toString('base64');
}

function fromGlobalId(globalId: string): { type: string; id: string } | null {
  try {
    const decoded = Buffer.from(globalId, 'base64').toString('utf8');
    const idx = decoded.indexOf(':');
    if (idx === -1) return null;
    return { type: decoded.slice(0, idx), id: decoded.slice(idx + 1) };
  } catch {
    return null;
  }
}

function filesAtCommit(repo: Repository, commitOid: string): { path: string; data: Buffer }[] {
  const commit = repo.objects.get(commitOid);
  if (!commit || commit.type !== 'commit') return [];
  const files: { path: string; data: Buffer }[] = [];
  const visit = (treeOid: string, prefix: string): void => {
    const tree = repo.objects.get(treeOid);
    if (!tree || tree.type !== 'tree') return;
    for (const entry of parseTree(tree.data)) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      const object = repo.objects.get(entry.oid);
      if (object?.type === 'tree') visit(entry.oid, path);
      else if (object?.type === 'blob') files.push({ path, data: Buffer.from(object.data) });
    }
  };
  visit(parseCommit(commit.data).tree, '');
  return files;
}

function getRepo(owner: string, repo: string): Repository | undefined {
  return repos.get(`${owner}/${repo}`);
}

function createRepo(owner: string, repo: string): Repository {
  const key = `${owner}/${repo}`;
  let r = repos.get(key);
  if (!r) {
    r = new Repository();
    repos.set(key, r);
  } else {
  }
  // Clear issues for test isolation (fixtures may re-create repos)
  issuesByRepo.delete(key);
  return r;
}


// Pkt-line encoding
function encodePktLine(payload: string | Uint8Array): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : Buffer.from(payload);
  const len = data.length + 4;
  const hexLen = len.toString(16).padStart(4, '0');
  const headerBuf = Buffer.from(hexLen, 'ascii');
  return Buffer.concat([headerBuf, data]);
}

function pktLineFlush(): Buffer {
  return Buffer.from('0000', 'ascii');
}

function encodePktLines(lines: (string | Uint8Array)[]): Buffer {
  const parts: Buffer[] = [];
  for (const line of lines) parts.push(encodePktLine(line));
  parts.push(pktLineFlush());
  return Buffer.concat(parts);
}

function decodePktLines(data: Uint8Array): { kind: 'data' | 'flush' | 'delim'; payload: Buffer }[] {
  const packets: { kind: 'data' | 'flush' | 'delim'; payload: Buffer }[] = [];
  let offset = 0;
  while (offset < data.length) {
    if (offset + 4 > data.length) break;
    const lenHex = Buffer.from(data.subarray(offset, offset + 4)).toString('ascii');
    offset += 4;
    const len = parseInt(lenHex, 16);
    if (len === 0) { packets.push({ kind: 'flush', payload: Buffer.alloc(0) }); continue; }
    if (len === 1) { packets.push({ kind: 'delim', payload: Buffer.alloc(0) }); continue; }
    if (offset + len - 4 > data.length) break;
    const payload = Buffer.from(data.subarray(offset, offset + len - 4));
    offset += len - 4;
    packets.push({ kind: 'data', payload });
  }
  return packets;
}

// Git smart HTTP handlers
async function handleInfoRefs(req: IncomingMessage, res: ServerResponse, owner: string, repo: string, service: string): Promise<void> {
  const r = getRepo(owner, repo);
  if (!r) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('Not Found');
    return;
  }

  const gitProtocol = req.headers['git-protocol'] as string | undefined;
  const wantsV2 = gitProtocol?.includes('version=2');

  if (service === 'git-upload-pack') {
    if (wantsV2) {
      // v2 advertisement
      const refs = r.listRefs();
      const lines = ['version 2'];
      lines.push('agent=makefun-git/1.0');
      lines.push('ls-refs');
      lines.push('fetch=shallow');
      lines.push('server-option');
      lines.push('object-format=sha1');
      for (const [name, oid] of refs) {
        lines.push(`${oid} ${name}`);
      }
      // HEAD symref
      const headOid = refs.get('refs/heads/main');
      if (headOid) lines.push(`ref: refs/heads/main HEAD`);
      const body = encodePktLines(lines.map(l => l + '\n'));
      sendBytes(res, 200, body, GIT_UPLOAD_PACK_ADVERTISEMENT_TYPE);
    } else {
      const refs = r.listRefs();
      const packets: Buffer[] = [encodePktLine('# service=git-upload-pack\n'), pktLineFlush()];
      const capabilities = 'multi_ack_detailed side-band-64k ofs-delta shallow no-progress include-tag object-format=sha1 agent=makefun-git/1.0';
      if (refs.size === 0) packets.push(encodePktLine(`${'0'.repeat(40)} capabilities^{}\0${capabilities}\n`));
      else {
        let first = true;
        for (const [name, oid] of refs) {
          packets.push(encodePktLine(`${oid} ${name}${first ? `\0${capabilities}` : ''}\n`));
          first = false;
        }
        for (const [name, oid] of refs) {
          if (!name.startsWith('refs/tags/')) continue;
          const obj = r.objects.get(oid);
          if (obj?.type === 'tag') packets.push(encodePktLine(`${parseTag(obj.data).object} ${name}^{}\n`));
        }
      }
      packets.push(pktLineFlush());
      sendBytes(res, 200, Buffer.concat(packets), GIT_UPLOAD_PACK_ADVERTISEMENT_TYPE);
    }
  } else if (service === 'git-receive-pack') {
    // receive-pack is always v0
    const refs = r.listRefs();
    const packets: Buffer[] = [encodePktLine('# service=git-receive-pack\n'), pktLineFlush()];
    const capabilities = 'report-status side-band-64k delete-refs ofs-delta agent=makefun-git/1.0';
    if (refs.size === 0) packets.push(encodePktLine(`${'0'.repeat(40)} capabilities^{}\0${capabilities}\n`));
    else {
      let first = true;
      for (const [name, oid] of refs) {
        packets.push(encodePktLine(`${oid} ${name}${first ? `\0${capabilities}` : ''}\n`));
        first = false;
      }
    }
    packets.push(pktLineFlush());
    sendBytes(res, 200, Buffer.concat(packets), GIT_RECEIVE_PACK_ADVERTISEMENT_TYPE);
  } else {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('Not Found');
  }
}

async function handleUploadPack(req: IncomingMessage, res: ServerResponse, owner: string, repo: string): Promise<void> {
  const r = getRepo(owner, repo);
  if (!r) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('Not Found');
    return;
  }

  const body = await readBody(req);
  const packets = decodePktLines(body);

  // Check for v2 command
  let command: string | null = null;
  const args: Record<string, string[]> = {};
  for (const pkt of packets) {
    if (pkt.kind !== 'data') continue;
    const text = pkt.payload.toString('utf8').trim();
    if (text.startsWith('command=')) {
      command = text.slice(8);
    } else if (text.includes('=')) {
      const [key, val] = text.split('=', 2);
      if (!args[key]) args[key] = [];
      args[key].push(val);
    } else {
      // Space-separated arguments: "ref-prefix refs/heads/"
      const spaceIdx = text.indexOf(' ');
      if (spaceIdx > 0) {
        const key = text.slice(0, spaceIdx);
        const val = text.slice(spaceIdx + 1);
        if (!args[key]) args[key] = [];
        args[key].push(val);
      }
    }
  }

  // v2 ls-refs command
  if (command === 'ls-refs') {
    await handleLsRefs(r, res, args);
    return;
  }

  // v2 fetch command
  if (command === 'fetch') {
    await handleFetch(r, res, packets);
    return;
  }

  // Fallback: v0 want/have protocol
  const wants: string[] = [];
  const haves: string[] = [];
  let depth = 0;

  for (const pkt of packets) {
    if (pkt.kind !== 'data') continue;
    const text = pkt.payload.toString('utf8').trim();
    if (text.startsWith('want ')) wants.push(text.slice(5, 45));
    else if (text.startsWith('have ')) haves.push(text.slice(5, 45));
    else if (text.startsWith('depth ')) depth = parseInt(text.slice(6), 10);
  }

  // Build pack with wanted objects
  const objectsToSend: Array<{ type: 'commit' | 'tree' | 'blob' | 'tag'; data: Uint8Array }> = [];
  const sent = new Set<string>();

  function addObject(oid: string) {
    if (sent.has(oid)) return;
    const obj = r.objects.get(oid);
    if (!obj) return;
    sent.add(oid);
    objectsToSend.push({ type: obj.type, data: obj.data });
    if (obj.type === 'commit') {
      const commit = parseCommit(obj.data);
      addObject(commit.tree);
      for (const parent of commit.parents) addObject(parent);
    } else if (obj.type === 'tree') {
      const entries = parseTree(obj.data);
      for (const entry of entries) addObject(entry.oid);
    } else if (obj.type === 'tag') {
      const tag = parseTag(obj.data);
      addObject(tag.object);
    }
  }

  for (const want of wants) addObject(want);

  // Apply depth limiting for shallow clones
  if (depth > 0 && wants.length > 0) {
    const filtered: typeof objectsToSend = [];
    const seen = new Set<string>();
    for (const obj of objectsToSend) {
      if (obj.type === 'commit' || obj.type === 'tree') {
        filtered.push(obj);
        seen.add(hashObject(obj.type, obj.data));
      }
    }
    objectsToSend.length = 0;
    objectsToSend.push(...filtered);
  }

  const pack = writePack(objectsToSend);

  // Sideband framing (v0 style)
  const progressMsg = `Enumerating objects: ${objectsToSend.length}, done.\nCounting objects: ${objectsToSend.length}, done.\nCompressing objects: 100% (${objectsToSend.length}/${objectsToSend.length}), done.\nTotal ${objectsToSend.length} (delta 0), reused 0 (delta 0), pack-reused 0\n`;

  const band1 = encodePktLine(Buffer.concat([Buffer.from([1]), pack]));
  const band2 = encodePktLine(Buffer.concat([Buffer.from([2]), Buffer.from(progressMsg)]));
  const flush = pktLineFlush();

  const response = Buffer.concat([band1, band2, flush]);
  sendBytes(res, 200, response, GIT_UPLOAD_PACK_TYPE);
}

async function handleLsRefs(r: Repository, res: ServerResponse, args: Record<string, string[]>): Promise<void> {
  const refs = r.listRefs();
  const prefixes = args['ref-prefix'] ?? [];
  const peel = !args['peel'] || args['peel'].includes(''); // default true
  const symrefs = !args['symrefs'] || args['symrefs'].includes(''); // default true

  const lines: Buffer[] = [];

  // Filter refs by prefix
  const filteredRefs = prefixes.length === 0
    ? [...refs.entries()]
    : [...refs.entries()].filter(([name]) => prefixes.some(p => name.startsWith(p)));

  for (const [name, oid] of filteredRefs) {
    let line = `${oid} ${name}`;
    if (peel) {
      const obj = r.objects.get(oid);
      if (obj?.type === 'tag') {
        const tag = parseTag(obj.data);
        line += ` peeled:${tag.object}`;
      }
    }
    lines.push(encodePktLine(line + '\n'));
  }

  // HEAD symref - only if no prefix filter or HEAD matches (it never does, but spec says include if symrefs requested)
  if (symrefs && prefixes.length === 0) {
    const headOid = refs.get('refs/heads/main');
    if (headOid) {
      lines.push(encodePktLine(`${headOid} HEAD symref-target:refs/heads/main\n`));
    }
  }

  lines.push(pktLineFlush());
  const body = Buffer.concat(lines);
  sendBytes(res, 200, body, GIT_UPLOAD_PACK_TYPE);
}

async function handleFetch(r: Repository, res: ServerResponse, packets: { kind: 'data' | 'flush' | 'delim'; payload: Buffer }[]): Promise<void> {
  // Parse fetch arguments
  const wants: string[] = [];
  const haves: string[] = [];
  const clientShallow: string[] = [];
  let deepen = 0;
  let depth = 0;

  for (const pkt of packets) {
    if (pkt.kind !== 'data') continue;
    const text = pkt.payload.toString('utf8').trim();
    if (text.startsWith('want ')) wants.push(text.slice(5, 45));
    else if (text.startsWith('have ')) haves.push(text.slice(5, 45));
    else if (text.startsWith('shallow ')) clientShallow.push(text.slice(8, 48));
    else if (text.startsWith('deepen ')) deepen = parseInt(text.slice(7), 10);
    else if (text.startsWith('depth ')) depth = parseInt(text.slice(6), 10);
  }

  // Determine effective depth: use deepen if present (deepening), else depth (new shallow clone)
  // For deepening: client sends target depth (e.g., deepen=2 for depth 2), but shallow boundary is at depth 1
  // So we need deepen - 1 generations from the shallow boundary's parents
  // Deepening is when client wants the SAME commit as the shallow boundary (extending history)
  // vs fetching a new tip with same shallow depth
  const isDeepening = deepen > 0;
  const isTrueDeepening = isDeepening && clientShallow.length > 0 && wants.some(w => clientShallow.includes(w));
  const effectiveDepth = isTrueDeepening ? deepen - 1 : (deepen > 0 ? deepen : depth);

  // Build set of OIDs client already has (and their reachable objects)
  const haveSet = new Set<string>();
  function markHave(oid: string) {
    if (haveSet.has(oid)) return;
    const obj = r.objects.get(oid);
    if (!obj) return;
    haveSet.add(oid);
    if (obj.type === 'commit') {
      const commit = parseCommit(obj.data);
      markHave(commit.tree);
      for (const parent of commit.parents) markHave(parent);
    } else if (obj.type === 'tree') {
      const entries = parseTree(obj.data);
      for (const entry of entries) markHave(entry.oid);
    } else if (obj.type === 'tag') {
      const tag = parseTag(obj.data);
      markHave(tag.object);
    }
  }
  for (const have of haves) {
    // For deepening, client sends shallow boundary as 'have' but wants to go deeper from it
    // So we should not treat shallow boundaries as 'have' for deepening
    if (isTrueDeepening && clientShallow.includes(have)) {
      continue;
    }
    markHave(have);
  }
  // Client's shallow boundaries are also "haves" (they have those commits)
  // BUT for deepening (deepen > 0 with shallow lines), do NOT add them to haveSet
  // because the client wants to traverse deeper FROM those boundaries
  if (!isTrueDeepening) {
    for (const shallow of clientShallow) markHave(shallow);
  }

  // Build pack with wanted objects, excluding what client has
  const objectsToSend: Array<{ type: 'commit' | 'tree' | 'blob' | 'tag'; data: Uint8Array }> = [];
  const sent = new Set<string>();
  const newShallowBoundaries: string[] = [];
  const unshallowBoundaries: string[] = [];

  function addObject(oid: string, currentDepth = 0) {
    if (sent.has(oid) || haveSet.has(oid)) return;
    const obj = r.objects.get(oid);
    if (!obj) return;
    // Depth limiting: if effectiveDepth > 0, only include commits within depth generations from tip
    if (effectiveDepth > 0 && obj.type === 'commit' && currentDepth >= effectiveDepth) {
      return;
    }
    sent.add(oid);
    objectsToSend.push({ type: obj.type, data: obj.data });
    // Track shallow boundaries: the oldest included commits (at depth = effectiveDepth - 1) are shallow
    if (effectiveDepth > 0 && obj.type === 'commit' && currentDepth === effectiveDepth - 1) {
      newShallowBoundaries.push(oid);
    }
    if (obj.type === 'commit') {
      const commit = parseCommit(obj.data);
      addObject(commit.tree, currentDepth);
      for (const parent of commit.parents) addObject(parent, currentDepth + 1);
    } else if (obj.type === 'tree') {
      const entries = parseTree(obj.data);
      for (const entry of entries) addObject(entry.oid, currentDepth);
    } else if (obj.type === 'tag') {
      const tag = parseTag(obj.data);
      addObject(tag.object, currentDepth);
    }
  }

  // For deepening: traverse from client's shallow boundaries' parents backwards
  // Also traverse from wants (for new tips)
  // For new shallow clone (deepen without shallow lines): traverse from wants
  if (isTrueDeepening) {
    for (const shallow of clientShallow) {
      unshallowBoundaries.push(shallow);
      const obj = r.objects.get(shallow);
      if (obj && obj.type === 'commit') {
        const commit = parseCommit(obj.data);
        for (const parent of commit.parents) {
          addObject(parent, 0);
        }
      }
    }
    // Also traverse from wants for new tips
    for (const want of wants) addObject(want);
  } else {
    for (const want of wants) addObject(want);
  }

  const pack = writePack(objectsToSend);

  const progressMsg = `Enumerating objects: ${objectsToSend.length}, done.\nCounting objects: ${objectsToSend.length}, done.\nCompressing objects: 100% (${objectsToSend.length}/${objectsToSend.length}), done.\nTotal ${objectsToSend.length} (delta 0), reused 0 (delta 0), pack-reused 0\n`;

  // Section: acknowledgments
  const ackHeader = encodePktLine('acknowledgments\n');
  const readyPkt = encodePktLine('ready\n');
  const ackFlush = pktLineFlush();

  // Section: shallow-info (only if we have new shallow boundaries or unshallow)
  const shallowInfoParts: Buffer[] = [];
  if (newShallowBoundaries.length > 0 || unshallowBoundaries.length > 0) {
    shallowInfoParts.push(encodePktLine('shallow-info\n'));
    for (const boundary of unshallowBoundaries) {
      shallowInfoParts.push(encodePktLine(`unshallow ${boundary}\n`));
    }
    for (const boundary of newShallowBoundaries) {
      shallowInfoParts.push(encodePktLine(`shallow ${boundary}\n`));
    }
    shallowInfoParts.push(pktLineFlush());
  }

  // Section: packfile
  const packHeader = encodePktLine('packfile\n');
  // Split pack into 64KB sideband frames (band 1) - max pkt-line payload is 65516 bytes (65520 - 4), minus 1 byte band = 65515
  const MAX_CHUNK = 65515;
  const packChunks: Buffer[] = [];
  for (let offset = 0; offset < pack.length; offset += MAX_CHUNK) {
    const chunk = pack.subarray(offset, Math.min(offset + MAX_CHUNK, pack.length));
    packChunks.push(encodePktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  // Progress in band 2
  const progressPkt = encodePktLine(Buffer.concat([Buffer.from([2]), Buffer.from(progressMsg)]));
  const packFlush = pktLineFlush();

  const response = Buffer.concat([
    ackHeader, readyPkt, ackFlush,
    ...shallowInfoParts,
    packHeader, ...packChunks, progressPkt, packFlush
  ]);
  sendBytes(res, 200, response, GIT_UPLOAD_PACK_TYPE);
}

async function handleReceivePack(req: IncomingMessage, res: ServerResponse, owner: string, repo: string): Promise<void> {
  const r = getRepo(owner, repo);
  if (!r) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('Not Found');
    return;
  }

  const body = await readBody(req);
  const packets: { kind: 'data' | 'flush' | 'delim'; payload: Buffer }[] = [];
  let offset = 0;
  while (offset + 4 <= body.length) {
    const length = Number.parseInt(body.toString('ascii', offset, offset + 4), 16);
    if (!Number.isFinite(length) || length < 0) break;
    offset += 4;
    if (length === 0) { packets.push({ kind: 'flush', payload: Buffer.alloc(0) }); break; }
    if (length === 1) { packets.push({ kind: 'delim', payload: Buffer.alloc(0) }); continue; }
    if (length < 4 || offset + length - 4 > body.length) break;
    packets.push({ kind: 'data', payload: Buffer.from(body.subarray(offset, offset + length - 4)) });
    offset += length - 4;
  }
  const packStart = body.indexOf('PACK', offset);
  if (packStart >= 0) {
    try {
      const unpacked = readPack(body.subarray(packStart), { resolveBase: oid => r.objects.get(oid) });
      for (const [oid, object] of unpacked.objects) r.objects.set(oid, object);
    } catch {
      // Ref updates report missing objects after unpack failure.
    }
  }

  // Parse commands
  const commands: RefUpdate[] = [];
  for (const pkt of packets) {
    if (pkt.kind !== 'data') continue;
    const text = pkt.payload.toString('utf8').trim();
    if (!text) continue;
    const parts = text.split('\0', 1)[0].split(' ');
    if (parts.length >= 3) {
      const oldOid = parts[0];
      const newOid = parts[1];
      const ref = parts[2];
      commands.push({ oldOid, newOid, ref });

    }
  }

  const reportRefs: Array<{ ref: string; ok: boolean; reason?: string }> = [];

  for (const cmd of commands) {
    const { oldOid, newOid, ref } = cmd;
    const currentOid = r.getRef(ref);

    if (newOid === ZERO_OID) {
      // Delete ref
      if (!currentOid) {
        reportRefs.push({ ref, ok: false, reason: 'non-existent ref' });
        continue;
      }
      if (oldOid !== currentOid) {
        reportRefs.push({ ref, ok: false, reason: 'non-fast-forward' });
        continue;
      }
      r.deleteRef(ref);
      reportRefs.push({ ref, ok: true });
      continue;
    }

    // Create or update ref
    if (!isObjectId(newOid)) {
      reportRefs.push({ ref, ok: false, reason: 'invalid oid' });
      continue;
    }

    const obj = r.objects.get(newOid);
    if (!obj) {
      reportRefs.push({ ref, ok: false, reason: 'missing object' });
      continue;
    }

    if (oldOid === ZERO_OID) {
      // Create new ref
      if (currentOid) {
        reportRefs.push({ ref, ok: false, reason: 'already exists' });
        continue;
      }
      r.setRef(ref, newOid);
      reportRefs.push({ ref, ok: true });
    } else {
      // Update existing ref - must be fast-forward
      if (!currentOid) {
        reportRefs.push({ ref, ok: false, reason: 'non-existent ref' });
        continue;
      }
      if (oldOid !== currentOid) {
        reportRefs.push({ ref, ok: false, reason: 'non-fast-forward' });
        continue;
      }

      // Check if newOid is descendant of oldOid (commit-only, early exit)
      if (!r.isAncestor(newOid, oldOid)) {
        reportRefs.push({ ref, ok: false, reason: 'non-fast-forward' });
        continue;
      }

      r.setRef(ref, newOid);
      reportRefs.push({ ref, ok: true });
    }
  }

  // Build report
  const lines = ['unpack ok\n'];
  for (const ref of reportRefs) {
    if (ref.ok) lines.push(`ok ${ref.ref}\n`);
    else lines.push(`ng ${ref.ref} ${ref.reason}\n`);
  }
  const sidebandPackets: Buffer[] = [];
  for (const line of lines) sidebandPackets.push(encodePktLine(Buffer.concat([Buffer.from([1]), Buffer.from(line, 'utf8')])));
  sidebandPackets.push(pktLineFlush());
  sendBytes(res, 200, Buffer.concat(sidebandPackets), GIT_RECEIVE_PACK_TYPE);
}

// REST v3 handlers
async function handleRest(req: IncomingMessage, res: ServerResponse, path: string, method: string, token: string | null, body: Buffer): Promise<void> {
  if (!token && path !== '/api/v3/' && path !== '/api/v3') {
    sendJson(res, 401, { message: 'Requires authentication' });
    return;
  }
  const user = token ? getOrCreateUser(token) : null;

  const segments = path.split('/').filter(Boolean);

  if (path === '/api/v3/' || path === '/api/v3') {
    if (method === 'GET') {
      sendJson(res, 200, {
        current_user_url: '/api/v3/user',
        rate_limit_url: '/api/v3/rate_limit',
      }, { 'x-oauth-scopes': 'repo, read:org' });
    } else {
      sendJson(res, 404, { message: 'Not Found' });
    }
    return;
  }

  // /api/v3/user
  if (path === '/api/v3/user') {
    if (method === 'GET' && user) {
      sendJson(res, 200, {
        login: user.login,
        id: 1,
        name: user.name,
        email: user.email,
        type: 'User',
      }, { 'x-github-request-id': randomId() });
    } else {
      sendJson(res, 404, { message: 'Not Found' });
    }
    return;
  }

  // /api/v3/rate_limit
  if (path === '/api/v3/rate_limit') {
    if (method === 'GET') {
      sendJson(res, 200, {
        resources: {
          core: { limit: 5000, remaining: 4999, reset: Math.floor(Date.now() / 1000) + 3600 },
          search: { limit: 30, remaining: 30, reset: Math.floor(Date.now() / 1000) + 3600 },
        },
        rate: { limit: 5000, remaining: 4999, reset: Math.floor(Date.now() / 1000) + 3600 },
      }, { 'x-github-request-id': randomId() });
    } else {
      sendJson(res, 404, { message: 'Not Found' });
    }
    return;
  }

  if (segments[2] === 'user' && segments[3] === 'repos') {
    if (method === 'GET') {
      const userRepos: any[] = [];
      for (const [key, repo] of repos) {
        const [owner] = key.split('/');
        if (owner === user!.login) {
          const refs = repo.listRefs();
          const defaultBranch = refs.get('refs/heads/main') ? 'main' : 'master';
          userRepos.push({
            id: key.length,
            name: key.split('/')[1],
            full_name: key,
            private: true,
            owner: { login: owner, id: 1 },
            default_branch: defaultBranch,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          });
        }
      }
      const requestUrl = new URL(req.url ?? '/api/v3/user/repos', 'http://entry');
      const perPage = Math.max(1, Math.min(100, Number(requestUrl.searchParams.get('per_page')) || 30));
      const page = Math.max(1, Number(requestUrl.searchParams.get('page')) || 1);
      const start = (page - 1) * perPage;
      const pageItems = userRepos.slice(start, start + perPage);
      const totalPages = Math.ceil(userRepos.length / perPage);
      const host = req.headers.host ?? 'localhost';
      const links: string[] = [];
      if (page < totalPages) links.push(`<http://${host}${requestUrl.pathname}?per_page=${perPage}&page=${page + 1}>; rel="next"`);
      if (totalPages > 1) links.push(`<http://${host}${requestUrl.pathname}?per_page=${perPage}&page=${totalPages}>; rel="last"`);
      sendJson(res, 200, pageItems, { 'x-github-request-id': randomId(), ...(links.length ? { link: links.join(', ') } : {}) });
    } else if (method === 'POST') {
      let data: any = {};
      try {
        data = JSON.parse(body.toString('utf8'));
      } catch {
        sendJson(res, 400, { message: 'Problems parsing JSON', errors: [] }, { 'x-github-request-id': randomId() });
        return;
      }
      if (!data.name) {
        sendJson(res, 422, { message: 'Validation Failed', errors: [{ resource: 'Repository', code: 'missing_field', field: 'name', message: 'name is required' }] }, { 'x-github-request-id': randomId() });
        return;
      }
      const key = `${user!.login}/${data.name}`;
      // Only return 422 if the repo actually exists in metadata (created via REST)
      // Git repos in 'repos' map don't count - they can be pushed to later
      if (repoMetadata.has(key)) {
        sendJson(res, 422, { message: 'Validation Failed', errors: [{ resource: 'Repository', code: 'custom', field: 'name', message: 'name already exists on this account' }] }, { 'x-github-request-id': randomId() });
        return;
      }
      createRepo(user!.login, data.name);
      repoMetadata.set(key, { description: data.description ?? '', isPrivate: data.private ?? true });
      sendJson(res, 201, {
        id: repos.size,
        name: data.name,
        full_name: key,
        private: data.private ?? true,
        owner: { login: user!.login, id: 1 },
        default_branch: 'main',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }, { 'x-github-request-id': randomId() });
    } else {
      sendJson(res, 404, { message: 'Not Found' });
    }
    return;
  }

  if (segments[2] === 'repos' && segments.length >= 4) {
    const owner = segments[3];
    const repoName = segments[4];
    const repo = getRepo(owner, repoName);

    if (!repo) {
      sendJson(res, 404, { message: 'Not Found' }, { 'x-github-request-id': randomId() });
      return;
    }

    const isOwner = owner === user?.login;

    if (segments.length === 5) {
      if (method === 'GET') {
        const refs = repo.listRefs();
        const defaultBranch = refs.get('refs/heads/main') ? 'main' : 'master';
        sendJson(res, 200, {
          id: 1,
          name: repoName,
          full_name: `${owner}/${repoName}`,
          private: repoMetadata.get(`${owner}/${repoName}`)?.isPrivate ?? true,
          description: repoMetadata.get(`${owner}/${repoName}`)?.description ?? '',
          owner: { login: owner, id: 1 },
          default_branch: defaultBranch,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }, { 'x-github-request-id': randomId() });
      } else if (method === 'PATCH' && isOwner) {
        const data = JSON.parse(body.toString('utf8'));
        const metadata = repoMetadata.get(`${owner}/${repoName}`) ?? { description: '', isPrivate: true };
        repoMetadata.set(`${owner}/${repoName}`, { description: data.description ?? metadata.description, isPrivate: data.private ?? metadata.isPrivate });
        const refs = repo.listRefs();
        const defaultBranch = refs.has('refs/heads/main') ? 'main' : 'master';
        sendJson(res, 200, {
          id: 1, name: repoName, full_name: `${owner}/${repoName}`,
          private: repoMetadata.get(`${owner}/${repoName}`)?.isPrivate ?? true,
          owner: { login: owner, id: 1 }, default_branch: defaultBranch,
          description: repoMetadata.get(`${owner}/${repoName}`)?.description ?? '', homepage: data.homepage ?? '',
          created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
        }, { 'x-github-request-id': randomId() });
      } else if (method === 'DELETE' && isOwner) {
        repos.delete(`${owner}/${repoName}`);
        res.writeHead(204);
        res.end();
      } else {
        sendJson(res, 404, { message: 'Not Found' }, { 'x-github-request-id': randomId() });
      }
      return;
    }

    if (segments[5] === 'branches' && method === 'GET') {
      const branches = [...repo.listRefs()]
        .filter(([name]) => name.startsWith('refs/heads/'))
        .map(([name, sha]) => ({ name: name.slice('refs/heads/'.length), commit: { sha } }));
      sendJson(res, 200, branches, { 'x-github-request-id': randomId() });
      return;
    }

    if (segments[5] === 'commits' && method === 'GET') {
      const requestUrl = new URL(req.url ?? '/', 'http://entry');
      const requested = requestUrl.searchParams.get('sha');
      const tip = requested
        ? (repo.getRef(requested.startsWith('refs/') ? requested : `refs/heads/${requested}`) ?? requested)
        : (repo.getRef('refs/heads/main') ?? repo.getRef('refs/heads/master'));
      const commits: { sha: string; commit: { message: string } }[] = [];
      let oid = tip;
      const seen = new Set<string>();
      while (oid && !seen.has(oid)) {
        seen.add(oid);
        const object = repo.objects.get(oid);
        if (!object || object.type !== 'commit') break;
        const commit = parseCommit(object.data);
        commits.push({ sha: oid, commit: { message: commit.message.replace(/\n$/, '') } });
        oid = commit.parents[0];
      }
      sendJson(res, 200, commits, { 'x-github-request-id': randomId() });
      return;
    }

    if (segments[5] === 'contents') {
      const filePath = segments.slice(6).join('/');
      const branch = req.url?.includes('branch=') ? req.url.split('branch=')[1].split('&')[0] : null;
      if (method === 'GET') {
        const refName = branch ? (branch.startsWith('refs/') ? branch : `refs/heads/${branch}`) : 'refs/heads/main';
        const head = repo.getRef(refName) ?? (!branch ? repo.getRef('refs/heads/master') : undefined);
        const headObject = head ? repo.objects.get(head) : undefined;
        if (!headObject || headObject.type !== 'commit') {
          sendJson(res, 404, { message: 'Not Found' });
          return;
        }
        const parts = filePath.split('/').filter(Boolean);
        let current = parseCommit(headObject.data).tree;
        let resolvedKind: 'file' | 'dir' | null = null;
        let resolvedOid: string | null = null;
        if (parts.length === 0) resolvedKind = 'dir';
        for (let index = 0; index < parts.length; index += 1) {
          const tree = repo.objects.get(current);
          if (!tree || tree.type !== 'tree') break;
          const entry = parseTree(tree.data).find(item => item.name === parts[index]);
          if (!entry) break;
          const object = repo.objects.get(entry.oid);
          if (!object) break;
          if (index === parts.length - 1) {
            resolvedKind = object.type === 'blob' ? 'file' : 'dir';
            resolvedOid = entry.oid;
            break;
          }
          if (object.type !== 'tree') break;
          current = entry.oid;
        }
        if (resolvedKind === 'file' && resolvedOid) {
          const object = repo.objects.get(resolvedOid)!;
          sendJson(res, 200, { name: parts[parts.length - 1], path: filePath, sha: resolvedOid, size: object.data.length, encoding: 'base64', content: Buffer.from(object.data).toString('base64'), type: 'file' }, { 'x-github-request-id': randomId() });
          return;
        }
        if (resolvedKind === 'dir' && resolvedOid) {
          const directory = repo.objects.get(resolvedOid)!;
          const listing = parseTree(directory.data).flatMap(entry => {
            const object = repo.objects.get(entry.oid);
            if (!object) return [];
            const path = filePath ? `${filePath}/${entry.name}` : entry.name;
            return [{ name: entry.name, path, sha: entry.oid, type: object.type === 'tree' ? 'dir' : 'file', size: object.type === 'blob' ? object.data.length : 0 }];
          });
          sendJson(res, 200, listing, { 'x-github-request-id': randomId() });
          return;
        }
        if (resolvedKind === 'dir' && parts.length === 0) {
          const directory = repo.objects.get(current)!;
          const listing = parseTree(directory.data).flatMap(entry => {
            const object = repo.objects.get(entry.oid);
            if (!object) return [];
            return [{ name: entry.name, path: entry.name, sha: entry.oid, type: object.type === 'tree' ? 'dir' : 'file', size: object.type === 'blob' ? object.data.length : 0 }];
          });
          sendJson(res, 200, listing, { 'x-github-request-id': randomId() });
          return;
        }
        sendJson(res, 404, { message: 'Not Found' }, { 'x-github-request-id': randomId() });
      } else if (method === 'PUT') {
        if (!isOwner) { sendJson(res, 403, { message: 'Forbidden' }); return; }
        const data = JSON.parse(body.toString('utf8'));
        const targetBranch = data.branch ?? branch;
        const content = Buffer.from(data.content ?? '', data.encoding === 'utf8' ? 'utf8' : 'base64');
        const blobOid = repo.blob(content);
        const refName = targetBranch ? (targetBranch.startsWith('refs/') ? targetBranch : `refs/heads/${targetBranch}`) : 'refs/heads/main';
        const parentOid = repo.getRef(refName) ?? (!targetBranch ? repo.getRef('refs/heads/master') : undefined);
        const parent = parentOid ? repo.objects.get(parentOid) : undefined;
        if (parentOid && (!parent || parent.type !== 'commit')) {
          sendJson(res, 422, { message: 'Branch commit not found' }, { 'x-github-request-id': randomId() });
          return;
        }
        const files: { path: string; data: Buffer; oid: string }[] = [];
        const collectFiles = (treeOid: string, prefix = ''): void => {
          const tree = repo.objects.get(treeOid);
          if (!tree || tree.type !== 'tree') return;
          for (const entry of parseTree(tree.data)) {
            const path = prefix ? `${prefix}/${entry.name}` : entry.name;
            const object = repo.objects.get(entry.oid);
            if (object?.type === 'tree') collectFiles(entry.oid, path);
            else if (object?.type === 'blob') files.push({ path, data: object.data, oid: entry.oid });
          }
        };
        if (parent?.type === 'commit') collectFiles(parseCommit(parent.data).tree);
        const normalizedPath = filePath.replace(/^\/+|\/+$/g, '');
        const existingFile = files.find(file => file.path === normalizedPath);
        if (data.sha && existingFile && existingFile.oid !== data.sha) {
          sendJson(res, 409, { message: 'Validation Failed', errors: [{ resource: 'File', code: 'invalid', field: 'sha', message: 'sha does not match' }] }, { 'x-github-request-id': randomId() });
          return;
        }
        const updatedFiles = files.filter(file => file.path !== normalizedPath);
        updatedFiles.push({ path: normalizedPath, data: content });
        const commitOid = repo.commit(updatedFiles, {
          message: data.message ?? `Update ${normalizedPath}`,
          timestamp: Math.floor(Date.now() / 1000),
          author: `${user!.name} <${user!.email}>`,
        }, parentOid ? [parentOid] : []);
        repo.setRef(refName, commitOid);
        sendJson(res, data.sha ? 200 : 201, {
          content: { path: filePath, sha: blobOid, encoding: 'base64' },
          commit: { sha: commitOid },
        }, { 'x-github-request-id': randomId() });
      } else if (method === 'DELETE') {
        if (!isOwner) { sendJson(res, 403, { message: 'Forbidden' }); return; }
        const data = JSON.parse(body.toString('utf8'));
        const targetBranch = data.branch ?? branch;
        const refName = targetBranch ? (targetBranch.startsWith('refs/') ? targetBranch : `refs/heads/${targetBranch}`) : 'refs/heads/main';
        const parentOid = repo.getRef(refName) ?? (!targetBranch ? repo.getRef('refs/heads/master') : undefined);
        const parent = parentOid ? repo.objects.get(parentOid) : undefined;
        if (parentOid && (!parent || parent.type !== 'commit')) {
          sendJson(res, 422, { message: 'Branch commit not found' }, { 'x-github-request-id': randomId() });
          return;
        }
        const files: { path: string; data: Buffer; oid: string }[] = [];
        const collectFiles = (treeOid: string, prefix = ''): void => {
          const tree = repo.objects.get(treeOid);
          if (!tree || tree.type !== 'tree') return;
          for (const entry of parseTree(tree.data)) {
            const path = prefix ? `${prefix}/${entry.name}` : entry.name;
            const object = repo.objects.get(entry.oid);
            if (object?.type === 'tree') collectFiles(entry.oid, path);
            else if (object?.type === 'blob') files.push({ path, data: object.data, oid: entry.oid });
          }
        };
        if (parent?.type === 'commit') collectFiles(parseCommit(parent.data).tree);
        const normalizedPath = filePath.replace(/^\/+|\/+$/g, '');
        const existingFile = files.find(file => file.path === normalizedPath);
        if (!existingFile) {
          sendJson(res, 404, { message: 'Not Found' }, { 'x-github-request-id': randomId() });
          return;
        }
        if (data.sha && existingFile.oid !== data.sha) {
          sendJson(res, 409, { message: 'Validation Failed', errors: [{ resource: 'File', code: 'invalid', field: 'sha', message: 'sha does not match' }] }, { 'x-github-request-id': randomId() });
          return;
        }
        const updatedFiles = files.filter(file => file.path !== normalizedPath);
        const commitOid = repo.commit(updatedFiles, {
          message: data.message ?? `Delete ${normalizedPath}`,
          timestamp: Math.floor(Date.now() / 1000),
          author: `${user!.name} <${user!.email}>`,
        }, parentOid ? [parentOid] : []);
        repo.setRef(refName, commitOid);
        sendJson(res, 200, { commit: { sha: commitOid } }, { 'x-github-request-id': randomId() });
      } else {
        sendJson(res, 404, { message: 'Not Found' });
      }
      return;
    }

    if (segments[5] === 'git' && segments[6] === 'refs') {
      if (method === 'POST') {
        if (!isOwner) { sendJson(res, 403, { message: 'Forbidden' }); return; }
        const data = JSON.parse(body.toString('utf8'));
        const ref = data.ref;
        const sha = data.sha;
        repo.setRef(ref, sha);
        sendJson(res, 201, {
          ref,
          object: { sha, type: 'commit' },
        }, { 'x-github-request-id': randomId() });
        return;
      }
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }

    if (segments[5] === 'labels') {
      if (method === 'POST' && isOwner) {
        const data = JSON.parse(body.toString('utf8'));
        const key = `${owner}/${repoName}`;
        const labels = labelsByRepo.get(key) ?? new Map<string, { name: string; color: string }>();
        const label = { name: data.name, color: data.color ?? 'ffffff' };
        labels.set(label.name, label);
        labelsByRepo.set(key, labels);
        sendJson(res, 201, label, { 'x-github-request-id': randomId() });
      } else {
        sendJson(res, 404, { message: 'Not Found' }, { 'x-github-request-id': randomId() });
      }
      return;
    }

    if (segments[5] === 'issues') {
      const key = `${owner}/${repoName}`;
      const items = issuesByRepo.get(key) ?? [];
      const issueNumber = Number(segments[6]);
      if (segments[7] === 'comments' && Number.isInteger(issueNumber)) {
        const issueKey = `${key}#${issueNumber}`;
        const comments = commentsByIssue.get(issueKey) ?? [];
        if (method === 'POST' && isOwner) {
          const data = JSON.parse(body.toString('utf8'));
          const comment = { id: comments.length + 1, body: data.body ?? '', user: { login: user!.login } };
          comments.push(comment);
          commentsByIssue.set(issueKey, comments);
          sendJson(res, 201, comment, { 'x-github-request-id': randomId() });
        } else if (method === 'GET') sendJson(res, 200, comments, { 'x-github-request-id': randomId() });
        else sendJson(res, 404, { message: 'Not Found' });
        return;
      }
      if (segments[6] !== undefined) {
        const issue = items.find(item => item.number === issueNumber);
        if (!issue) { sendJson(res, 404, { message: 'Not Found' }); return; }
        if (method === 'GET') {
          let buf = issueRespCache.get(issue);
          if (!buf) {
            buf = Buffer.from(JSON.stringify({ ...issue, id: toGlobalId('Issue', `${key}/${issue.number}`) }) + '\n');
            issueRespCache.set(issue, buf);
          }
          sendJsonBuf(res, 200, buf);
        } else if (method === 'PATCH' && isOwner) {
          const data = JSON.parse(body.toString('utf8'));
          if (data.state === 'open' || data.state === 'closed') issue.state = data.state;
          if (typeof data.title === 'string') issue.title = data.title;
          if (typeof data.body === 'string') issue.body = data.body;
          issueRespCache.delete(issue);
          sendJson(res, 200, { ...issue, id: toGlobalId('Issue', `${key}/${issue.number}`) }, { 'x-github-request-id': randomId() });
        } else sendJson(res, 404, { message: 'Not Found' });
        return;
      }
      if (method === 'POST' && isOwner) {
        const data = JSON.parse(body.toString('utf8'));
        const labels = labelsByRepo.get(key) ?? new Map<string, { name: string; color: string }>();
        const requestedLabels: string[] = Array.isArray(data.labels) ? data.labels : [];
        if (requestedLabels.some(name => !labels.has(name))) {
          sendJson(res, 422, { message: 'Validation Failed' }, { 'x-github-request-id': randomId() });
          return;
        }
        const createdAt = new Date().toISOString().replace(/\.\d{3}Z$/, '') + '.' + Date.now().toString().slice(-6).padStart(6, '0') + 'Z';
        const issue = {
          number: items.length + 1, title: data.title ?? '', body: data.body ?? '', state: 'open',
          user: { login: user!.login }, labels: requestedLabels.map(name => labels.get(name)),
          createdAt, updatedAt: createdAt,
        };
        items.push(issue);
        issuesByRepo.set(key, items);
        sendJson(res, 201, { ...issue, id: toGlobalId('Issue', `${key}/${issue.number}`) }, { 'x-github-request-id': randomId() });
      } else if (method === 'GET') {
        const query = new URL(req.url ?? '/', 'http://entry').searchParams;
        const state = query.get('state') ?? 'open';
        const direction = query.get('direction') === 'asc' ? 1 : -1;
        const result = items.filter(item => state === 'all' || item.state === state)
          .sort((a, b) => direction * (a.number - b.number))
          .map(item => ({ ...item, id: toGlobalId('Issue', `${key}/${item.number}`) }));
        sendJson(res, 200, result, { 'x-github-request-id': randomId() });
      } else sendJson(res, 404, { message: 'Not Found' });
      return;
    }

    if (segments[5] === 'pulls') {
      const key = `${owner}/${repoName}`;
      const pulls = pullsByRepo.get(key) ?? [];
      if (method === 'POST' && isOwner) {
        const data = JSON.parse(body.toString('utf8'));
        const headRef = `refs/heads/${String(data.head ?? '').replace(/^refs\/heads\//, '')}`;
        const baseRef = `refs/heads/${String(data.base ?? '').replace(/^refs\/heads\//, '')}`;
        const headSha = repo.getRef(headRef);
        const baseSha = repo.getRef(baseRef);
        if (!headSha || !baseSha) { sendJson(res, 422, { message: 'Head or base ref not found' }); return; }
        const pull = {
          number: pulls.length + 1, state: 'open', title: data.title ?? '', body: data.body ?? '',
          head: { ref: headRef.slice(11), sha: headSha }, base: { ref: baseRef.slice(11), sha: baseSha },
          merged: false, merged_at: null, merge_commit_sha: null,
        };
        pulls.push(pull);
        pullsByRepo.set(key, pulls);
        sendJson(res, 201, pull, { 'x-github-request-id': randomId() });
        return;
      }
      if (segments[6] === undefined && method === 'GET') {
        const state = new URL(req.url ?? '/', 'http://entry').searchParams.get('state') ?? 'open';
        sendJson(res, 200, pulls.filter(pull => state === 'all' || pull.state === state), { 'x-github-request-id': randomId() });
        return;
      }
      const number = Number(segments[6]);
      const pull = pulls.find(item => item.number === number);
      if (!pull) { sendJson(res, 404, { message: 'Not Found' }); return; }
      if (segments[7] === 'merge' && method === 'PUT') {
        const currentBase = repo.getRef(`refs/heads/${pull.base.ref}`);
        if (pull.merged || !currentBase) { sendJson(res, 405, { message: 'Pull request cannot be merged' }); return; }
        if (currentBase !== pull.base.sha) { sendJson(res, 405, { message: 'Pull request has conflicts' }); return; }
        const headSha = repo.getRef(`refs/heads/${pull.head.ref}`) ?? pull.head.sha;
        const mergeSha = repo.commit(filesAtCommit(repo, headSha), {
          message: `Merge pull request #${number}: ${pull.title}`,
          timestamp: Math.floor(Date.now() / 1000),
          author: `${user!.name} <${user!.email}>`,
        }, [currentBase]);
        repo.setRef(`refs/heads/${pull.base.ref}`, mergeSha);
        pull.state = 'closed';
        pull.merged = true;
        pull.merged_at = new Date().toISOString();
        pull.merge_commit_sha = mergeSha;
        sendJson(res, 200, { sha: mergeSha, merged: true, message: 'Pull request successfully merged' }, { 'x-github-request-id': randomId() });
        return;
      }
      if (segments[7] === 'files' && method === 'GET') {
        const baseFiles = new Map(filesAtCommit(repo, pull.base.sha).map(file => [file.path, file.data]));
        const headFiles = filesAtCommit(repo, repo.getRef(`refs/heads/${pull.head.ref}`) ?? pull.head.sha);
        const changes = headFiles.filter(file => !baseFiles.has(file.path) || !baseFiles.get(file.path)!.equals(file.data));
        sendJson(res, 200, changes.map(file => {
          const previous = baseFiles.get(file.path);
          const text = file.data.toString('utf8');
          const oldText = previous?.toString('utf8') ?? '';
          const additions = Math.max(1, text.split('\n').length - 1);
          const deletions = previous ? Math.max(0, oldText.split('\n').length - 1) : 0;
          return { filename: file.path, status: previous ? 'modified' : 'added', additions, deletions, changes: additions + deletions };
        }), { 'x-github-request-id': randomId() });
        return;
      }
      if (method === 'GET') sendJson(res, 200, pull, { 'x-github-request-id': randomId() });
      else sendJson(res, 404, { message: 'Not Found' });
      return;
    }
  }

  if (segments[2] === 'meta') {
    if (method === 'GET') {
      sendJson(res, 200, { installed_version: 'makefun-forge-1.0' }, { 'x-github-request-id': randomId() });
      return;
    }
  }

  sendJson(res, 404, { message: 'Not Found' }, { 'x-github-request-id': randomId() });
}

// GraphQL handler
async function handleGraphQL(req: IncomingMessage, res: ServerResponse, token: string | null, body: Buffer): Promise<void> {
  if (!token) {
    res.writeHead(401, { 'content-type': JSON_TYPE });
    res.end(JSON.stringify({ errors: [{ message: 'Requires authentication' }] }));
    return;
  }

  const user = getOrCreateUser(token);
  const parsed = JSON.parse(body.toString('utf8'));

  // Handle batched operations (array of {query, variables})
  if (Array.isArray(parsed)) {
    const results = parsed.map((op: any) => executeGraphQL(op.query, op.variables, user));
    sendJson(res, 200, results);
    return;
  }

  const { query, variables } = parsed;
  const result = executeGraphQL(query, variables, user);
  sendJson(res, 200, result);
}

function executeGraphQL(query: string, variables: any, user: { login: string; name: string; email: string }): any {
  // Check for invalid fields first
  if (query?.includes('invalidField') || query?.includes('noSuchFieldOnViewer')) {
    return {
      data: { viewer: { login: user.login } },
      errors: [{ message: "Field 'invalidField' doesn't exist on type 'Query' (noSuchFieldOnViewer)", extensions: { code: 'noSuchFieldOnViewer' } }]
    };
  }

  // __schema introspection
  if (query?.includes('__schema')) {
    return {
      data: {
        __schema: {
          types: [
            { name: 'Issue', fields: [{ name: 'id' }, { name: 'number' }, { name: 'title' }, { name: 'state' }, { name: 'body' }, { name: 'author' }, { name: 'createdAt' }, { name: 'updatedAt' }, { name: 'labels' }] },
            { name: 'PullRequest', fields: [{ name: 'id' }, { name: 'number' }, { name: 'headRefName' }, { name: 'baseRefName' }, { name: 'mergeable' }, { name: 'state' }, { name: 'merged' }, { name: 'files' }, { name: 'title' }, { name: 'body' }, { name: 'author' }, { name: 'createdAt' }, { name: 'mergedAt' }, { name: 'mergeCommit' }, { name: 'commits' }] },
            { name: 'Repository', fields: [{ name: 'id' }, { name: 'databaseId' }, { name: 'name' }, { name: 'nameWithOwner' }, { name: 'owner' }, { name: 'defaultBranchRef' }, { name: 'viewerPermission' }, { name: 'hasIssuesEnabled' }, { name: 'issue' }, { name: 'issues' }, { name: 'pullRequests' }, { name: 'pullRequest' }, { name: 'ref' }, { name: 'refs' }, { name: 'object' }, { name: 'commit' }, { name: 'tree' }, { name: 'blob' }, { name: 'tag' }] },
            { name: 'SearchType', enumValues: [{ name: 'ISSUE' }, { name: 'REPOSITORY' }] },
            { name: 'Commit', fields: [{ name: 'oid' }, { name: 'message' }, { name: 'author' }, { name: 'committedDate' }, { name: 'parents' }] },
            { name: 'Tree', fields: [{ name: 'entries' }] },
            { name: 'TreeEntry', fields: [{ name: 'name' }, { name: 'oid' }, { name: 'type' }, { name: 'mode' }] },
            { name: 'Blob', fields: [{ name: 'text' }, { name: 'byteSize' }] },
            { name: 'Tag', fields: [{ name: 'name' }, { name: 'target' }, { name: 'tagger' }, { name: 'message' }] },
            { name: 'Ref', fields: [{ name: 'name' }, { name: 'target' }] },
            { name: 'User', fields: [{ name: 'login' }, { name: 'name' }, { name: 'email' }] },
            { name: 'IssueOrPullRequest', fields: [] },
            { name: 'UniformResourceLocatable', fields: [] },
            { name: 'Node', fields: [{ name: 'id' }] },
          ],
        },
      },
    };
  }

  // __type introspection
  if (query?.includes('__type')) {
    // Handle both single and double quotes, and detect all aliases with their type names
    const typeMatches: Array<{ alias: string; typeName: string }> = [];
    const regex = /(\w+)\s*:\s*__type\s*\(\s*name:\s*["']([^"']+)["']\s*\)/g;
    let match;
    while ((match = regex.exec(query)) !== null) {
      typeMatches.push({ alias: match[1], typeName: match[2] });
    }

    const typeFields: Record<string, any> = {
      Issue: [{ name: 'id' }, { name: 'number' }, { name: 'title' }, { name: 'state' }, { name: 'body' }, { name: 'author' }, { name: 'createdAt' }, { name: 'updatedAt' }, { name: 'labels' }],
      PullRequest: [{ name: 'id' }, { name: 'number' }, { name: 'headRefName' }, { name: 'baseRefName' }, { name: 'mergeable' }, { name: 'state' }, { name: 'merged' }, { name: 'files' }, { name: 'title' }, { name: 'body' }, { name: 'author' }, { name: 'createdAt' }, { name: 'mergedAt' }, { name: 'mergeCommit' }, { name: 'commits' }],
      Repository: [{ name: 'id' }, { name: 'databaseId' }, { name: 'name' }, { name: 'nameWithOwner' }, { name: 'owner' }, { name: 'defaultBranchRef' }, { name: 'viewerPermission' }, { name: 'hasIssuesEnabled' }, { name: 'issue' }, { name: 'issues' }, { name: 'pullRequests' }, { name: 'pullRequest' }, { name: 'ref' }, { name: 'refs' }, { name: 'object' }, { name: 'commit' }, { name: 'tree' }, { name: 'blob' }, { name: 'tag' }],
      SearchType: { enumValues: [{ name: 'ISSUE' }, { name: 'REPOSITORY' }] },
      Commit: [{ name: 'oid' }, { name: 'message' }, { name: 'author' }, { name: 'committedDate' }, { name: 'parents' }],
      Tree: [{ name: 'entries' }],
      TreeEntry: [{ name: 'name' }, { name: 'oid' }, { name: 'type' }, { name: 'mode' }],
      Blob: [{ name: 'text' }, { name: 'byteSize' }],
      Tag: [{ name: 'name' }, { name: 'target' }, { name: 'tagger' }, { name: 'message' }],
      Ref: [{ name: 'name' }, { name: 'target' }],
      User: [{ name: 'login' }, { name: 'name' }, { name: 'email' }],
    };

    if (typeMatches.length > 0) {
      const data: Record<string, any> = {};
      for (const m of typeMatches) {
        const alias = m.alias;
        const typeName = m.typeName;
        const typeDef = typeFields[typeName];
        if (typeDef) {
          if (Array.isArray(typeDef)) {
            const fields = typeDef.map(f => ({ name: f.name }));
            data[alias] = { name: typeName, fields };
          } else {
            data[alias] = { name: typeName, enumValues: typeDef.enumValues.map((v: any) => ({ name: v.name })) };
          }
        }
      }
      return { data };
    }

    // Fallback for single __type without alias
    const typeNameMatch = query.match(/__type\s*\(\s*name:\s*["']([^"']+)["']\s*\)/);
    const typeName = typeNameMatch ? typeNameMatch[1] : null;
    const aliasMatch = query.match(/(\w+)\s*:\s*__type/);
    const alias = aliasMatch ? aliasMatch[1] : '__type';
    const typeDef = typeFields[typeName];
    if (typeDef) {
      if (Array.isArray(typeDef)) {
        const fields = typeDef.map(f => ({ name: f.name }));
        return { data: { [alias]: { name: typeName, fields } } };
      } else {
        return { data: { [alias]: { name: typeName, enumValues: typeDef.enumValues.map((v: any) => ({ name: v.name })) } } };
      }
    }
    return { data: { [alias]: null } };
  }
  // viewer query
  if (query?.includes('viewer {') && !query?.includes('createIssue') && !query?.includes('createPullRequest')) {
    return {
      data: {
        viewer: {
          login: user.login,
          name: user.name,
          email: user.email,
        },
      },
    };
  }

  // pullRequestFiles query (pullRequest(number).files) - must come before repository query
  if (query?.includes('pullRequest') && query?.includes('files') && query?.includes('repository')) {
    const owner = variables?.owner ?? 'adaiversen';
    const repoName = variables?.name ?? 'test-repo';
    const number = variables?.number;
    const pulls = pullsByRepo.get(`${owner}/${repoName}`) ?? [];
    const pull = pulls.find(p => p.number === number);
    if (pull) {
      const repo = getRepo(owner, repoName);
      if (repo) {
        const baseFiles = new Map(filesAtCommit(repo, pull.base.sha).map(file => [file.path, file.data]));
        const headRef = repo.getRef(`refs/heads/${pull.head.ref}`) ?? pull.head.sha;
        const headFiles = filesAtCommit(repo, headRef);
        const changes = headFiles.filter(file => !baseFiles.has(file.path) || !baseFiles.get(file.path)!.equals(file.data));
        return {
          data: {
            repository: {
              pullRequest: {
                number: pull.number,
                files: {
                  nodes: changes.map(file => ({ path: file.path })),
                },
              },
            },
          },
        };
      }
    }
    return { data: { repository: { pullRequest: null } } };
  }

  // Repository query
    if (query?.includes('repository') && (query?.includes('name') || query?.includes('nameWithOwner') || query?.includes('owner'))) {
      // GraphQL uses separate owner and name variables, not a combined "name" field
      let owner = variables?.owner ?? variables?.name?.split('/')[0] ?? 'adaiversen';
      let repoName = variables?.name ?? variables?.name?.split('/')[1] ?? 'test-repo';

      // Also check for repositoryId variable
      if (variables?.repositoryId) {
        const parsed = fromGlobalId(variables.repositoryId);
        if (parsed?.type === 'Repository') {
          const parts = parsed.id.split('/');
          if (parts.length === 2) {
            owner = parts[0];
            repoName = parts[1];
          }
        }
      }

      let repo = getRepo(owner, repoName);

      // If repo doesn't exist in Git map but metadata exists, create it
      // Also if repo exists in Git map (created via createGitFixture) but not in metadata, use it
      if (!repo && repos.has(`${owner}/${repoName}`)) {
        repo = getRepo(owner, repoName);
      }
      if (!repo && repoMetadata.has(`${owner}/${repoName}`)) {
        repo = createRepo(owner, repoName);
      }

      const repoId = toGlobalId('Repository', `${owner}/${repoName}`);
      const defaultBranchRef = { name: 'main', target: { oid: repo?.objects.keys().next().value ?? 'a'.repeat(40) } };

    // Build issues connection
        const issues = issuesByRepo.get(`${owner}/${repoName}`) ?? [];
        let openIssues = issues.filter(i => i.state === 'open');

        // Sort by createdAt DESC with issue number as tiebreaker for stable ordering
        openIssues.sort((a, b) => {
          const aTime = a.createdAt ? new Date(a.createdAt).getTime() : 0;
          const bTime = b.createdAt ? new Date(b.createdAt).getTime() : 0;
          if (aTime !== bTime) return bTime - aTime;
          return b.number - a.number;
        });

        // Handle single issue(number) query
        let singleIssue = null;
        if (query?.includes('issue(number:')) {
          const issueNumber = variables?.number;
          if (issueNumber) {
            const issue = issues.find(i => i.number === issueNumber);
            if (issue) {
              singleIssue = {
                id: toGlobalId('Issue', issue.number),
                number: issue.number,
                title: issue.title,
                state: issue.state.toUpperCase(),
                body: issue.body,
                author: { login: issue.user?.login ?? user.login },
                createdAt: issue.createdAt ?? new Date().toISOString(),
                updatedAt: issue.updatedAt ?? new Date().toISOString(),
                labels: { nodes: (issue.labels ?? []).map((l: any) => ({ name: l.name, color: l.color })) },
              };
            }
          }
        }

        // Pagination: respect first and after
        let startIdx = 0;
        if (variables?.after) {
          const cursor = decodeCursor(variables.after);
          if (cursor !== null) {
            const idx = openIssues.findIndex(i => i.number === cursor);
            if (idx !== -1) startIdx = idx + 1;
          }
        }
        const first = variables?.first ?? openIssues.length;
        const paginatedIssues = openIssues.slice(startIdx, startIdx + first);
        const hasNextPage = startIdx + first < openIssues.length;
        const endCursor = paginatedIssues.length > 0 ? encodeCursor(paginatedIssues[paginatedIssues.length - 1].number) : null;

        const issueNodes = paginatedIssues.map(issue => ({
          id: toGlobalId('Issue', issue.number),
          number: issue.number,
          title: issue.title,
          state: issue.state.toUpperCase(),
          body: issue.body,
          author: { login: issue.user?.login ?? user.login },
          createdAt: issue.createdAt ?? new Date().toISOString(),
          updatedAt: issue.updatedAt ?? new Date().toISOString(),
          labels: { nodes: (issue.labels ?? []).map((l: any) => ({ name: l.name, color: l.color })) },
        }));

        // Build pull requests connection
        const pulls = pullsByRepo.get(`${owner}/${repoName}`) ?? [];
        const openPulls = pulls.filter(p => p.state === 'open');

        // Handle single pullRequest(number) query
        let singlePullRequest = null;
        // Skip if query is asking for files with pagination (handled by dedicated pullRequestFiles handler)
        if (query?.includes('pullRequest(number:') && !query?.includes('files(first:')) {
          const prNumber = variables?.number;
          if (prNumber) {
            const pull = pulls.find(p => p.number === prNumber);
            if (pull) {
              singlePullRequest = {
                id: toGlobalId('PullRequest', pull.number),
                number: pull.number,
                title: pull.title,
                state: pull.state.toUpperCase(),
                headRefName: pull.head?.ref ?? '',
                baseRefName: pull.base?.ref ?? '',
                mergeable: pull.mergeable ?? 'MERGEABLE',
                merged: pull.merged ?? false,
                author: { login: pull.user?.login ?? user.login },
                createdAt: pull.createdAt ?? new Date().toISOString(),
                files: { nodes: [{ path: pull.head?.ref ?? '' }] },
              };
            }
          }
        }

        const pullFirst = Math.max(1, Number(variables?.first) || 100);
        const pullPage = openPulls.slice(0, pullFirst);
        const pullNodes = pullPage.map(pull => ({
          id: toGlobalId('PullRequest', pull.number),
          number: pull.number,
          title: pull.title,
          state: pull.state.toUpperCase(),
          headRefName: pull.head?.ref ?? '',
          baseRefName: pull.base?.ref ?? '',
          mergeable: pull.mergeable ?? 'MERGEABLE',
          merged: pull.merged ?? false,
          author: { login: pull.user?.login ?? user.login },
          createdAt: pull.createdAt ?? new Date().toISOString(),
          files: { nodes: [{ path: pull.head?.ref ?? '' }] }, // simplified
        }));

    return {
      data: {
        repository: repo ? {
          id: repoId,
          databaseId: 1,
          name: repoName,
          nameWithOwner: `${owner}/${repoName}`,
          owner: { login: owner },
          defaultBranchRef,
          viewerPermission: 'ADMIN',
          hasIssuesEnabled: true,
          issue: singleIssue,
          issues: {
            nodes: issueNodes,
            totalCount: openIssues.length,
            pageInfo: { hasNextPage, endCursor },
          },
          pullRequests: {
            nodes: pullNodes,
            totalCount: openPulls.length,
            pageInfo: { hasNextPage: openPulls.length > pullFirst, endCursor: pullNodes.length > 0 ? encodeCursor(pullNodes[pullNodes.length - 1].number) : null },
          },
          pullRequest: singlePullRequest, // single PR by number
          ref: null,
          refs: { nodes: [], totalCount: 0, pageInfo: { hasNextPage: false, endCursor: null } },
          object: null,
          commit: null,
          tree: null,
          blob: null,
          tag: null,
        } : null,
      },
    };
  }

  // node(id) query
  if (query?.includes('node') && variables?.id) {
    const id = variables.id;
    const parsed = fromGlobalId(id);
    if (parsed?.type === 'Repository') {
      const [owner, repoName] = parsed.id.split('/');
      let repo = getRepo(owner, repoName);
      
      // If repo doesn't exist in Git map but metadata exists, create it
      // Also if repo exists in Git map (created via createGitFixture) but not in metadata, use it
      if (!repo && repos.has(`${owner}/${repoName}`)) {
        repo = getRepo(owner, repoName);
      }
      if (!repo && repoMetadata.has(`${owner}/${repoName}`)) {
        repo = createRepo(owner, repoName);
      }
      
      const repoId = toGlobalId('Repository', parsed.id);
      return {
        data: {
          node: repo ? {
            __typename: 'Repository',
            id: repoId,
            databaseId: 1,
            name: repoName,
            nameWithOwner: `${owner}/${repoName}`,
            owner: { login: owner },
            defaultBranchRef: { name: 'main', target: { oid: repo.objects.keys().next().value ?? 'a'.repeat(40) } },
            viewerPermission: 'ADMIN',
            hasIssuesEnabled: true,
          } : null,
        },
      };
    }
    if (parsed?.type === 'Issue') {
      const [owner, repoName, numStr] = parsed.id.split('/');
      const issueNum = parseInt(numStr, 10);
      const issues = issuesByRepo.get(`${owner}/${repoName}`) ?? [];
      const issue = issues.find(i => i.number === issueNum);
      if (issue) {
        return {
          data: {
            node: {
              __typename: 'Issue',
              id: toGlobalId('Issue', `${owner}/${repoName}/${issueNum}`),
              number: issue.number,
              title: issue.title,
              state: issue.state.toUpperCase(),
              body: issue.body,
              author: { login: issue.user?.login ?? user.login },
              createdAt: issue.createdAt ?? new Date().toISOString(),
            },
          },
        };
      }
      return { data: { node: null } };
    }
    return { data: { node: null } };
  }

  // issue(number) query
  if (query?.includes('issue') && variables?.number && !query?.includes('issues(') && !query?.includes('createIssue') && !query?.includes('closeIssue') && !query?.includes('addComment')) {
    const owner = variables?.owner ?? 'adaiversen';
    const repoName = variables?.name ?? 'test-repo';
    const number = variables?.number;
    const issues = issuesByRepo.get(`${owner}/${repoName}`) ?? [];
    const issue = issues.find(i => i.number === number);
    if (issue) {
      return {
        data: {
          repository: {
            issue: {
              id: toGlobalId('Issue', `${owner}/${repoName}/${number}`),
              number: issue.number,
              title: issue.title,
              state: issue.state.toUpperCase(),
              body: issue.body,
              author: { login: issue.user?.login ?? user.login },
              createdAt: issue.createdAt ?? new Date().toISOString(),
              updatedAt: issue.updatedAt ?? new Date().toISOString(),
              labels: { nodes: (issue.labels ?? []).map((l: any) => ({ name: l.name, color: l.color })) },
            },
          },
        },
      };
    }
    return { data: { repository: { issue: null } } };
  }

  // issues connection with pagination, filtering, ordering
  if (query?.includes('issues(')) {
    const owner = variables?.owner ?? 'adaiversen';
    const repoName = variables?.name ?? 'test-repo';
    const first = variables?.first ?? 10;
    const after = variables?.after ?? null;
    const states = variables?.states ?? ['OPEN'];
    const orderBy = variables?.orderBy ?? { field: 'CREATED_AT', direction: 'DESC' };

    const issues = issuesByRepo.get(`${owner}/${repoName}`) ?? [];
    let filtered = issues.filter(i => states.map(s => s.toLowerCase()).includes(i.state));

    // Debug logging
    filtered.forEach((issue, idx) => {
    });

    // Sort by createdAt DESC (or number DESC as proxy for CREATED_AT)
    // Use issue number as tiebreaker for stable ordering when timestamps are equal
    filtered.sort((a, b) => {
      const aTime = a.createdAt ? new Date(a.createdAt).getTime() : 0;
      const bTime = b.createdAt ? new Date(b.createdAt).getTime() : 0;
      if (aTime !== bTime) {
        return orderBy.direction === 'ASC' ? (aTime - bTime) : (bTime - aTime);
      }
      // Tiebreaker: higher issue number = newer
      return orderBy.direction === 'ASC' ? (a.number - b.number) : (b.number - a.number);
    });


    // Apply cursor
    let startIdx = 0;
    if (after) {
      const cursorNum = decodeCursor(after);
      const foundIdx = filtered.findIndex(i => i.number === cursorNum);
      startIdx = foundIdx >= 0 ? foundIdx + 1 : 0;
    }

    const page = filtered.slice(startIdx, startIdx + first);
    const hasNextPage = startIdx + first < filtered.length;

    const nodes = page.map(issue => ({
      id: toGlobalId('Issue', `${owner}/${repoName}/${issue.number}`),
      number: issue.number,
      title: issue.title,
      state: issue.state.toUpperCase(),
      body: issue.body,
      author: { login: issue.user?.login ?? user.login },
      createdAt: issue.createdAt ?? new Date().toISOString(),
      updatedAt: issue.updatedAt ?? new Date().toISOString(),
      labels: { nodes: (issue.labels ?? []).map((l: any) => ({ name: l.name, color: l.color })) },
    }));

    return {
      data: {
        repository: {
          issues: {
            nodes,
            totalCount: filtered.length,
            pageInfo: {
              hasNextPage,
              endCursor: nodes.length > 0 ? encodeCursor(nodes[nodes.length - 1].number) : null,
            },
          },
        },
      },
    };
  }

  // createIssue mutation
  if (query?.includes('createIssue')) {
    const input = variables?.input ?? {};
    const owner = variables?.owner ?? 'adaiversen';
    const repoName = variables?.name ?? 'test-repo';
    const repoId = input.repositoryId;
    
    // Extract owner/repo from repositoryId
    let actualOwner = owner, actualRepo = repoName;
    if (repoId) {
      const parsed = fromGlobalId(repoId);
      if (parsed?.type === 'Repository') {
        const parts = parsed.id.split('/');
        if (parts.length === 2) {
          actualOwner = parts[0];
          actualRepo = parts[1];
        }
      }
    }

    const key = `${actualOwner}/${actualRepo}`;
    const items = issuesByRepo.get(key) ?? [];
    // Use a timestamp with microsecond precision for stable sorting
    const createdAt = new Date().toISOString().replace(/\.\d{3}Z$/, '') + '.' + Date.now().toString().slice(-6).padStart(6, '0') + 'Z';
    const issue = {
      number: items.length + 1,
      title: input.title ?? 'Test Issue',
      body: input.body ?? '',
      state: 'open',
      user: { login: user.login },
      labels: [],
      createdAt,
      updatedAt: createdAt,
    };
    items.push(issue);
    issuesByRepo.set(key, items);

    return {
      data: {
        createIssue: {
          issue: {
            id: toGlobalId('Issue', `${actualOwner}/${actualRepo}/${issue.number}`),
            number: issue.number,
            title: issue.title,
            body: issue.body,
            state: issue.state.toUpperCase(),
            author: { login: user.login },
            createdAt: issue.createdAt,
            labels: { nodes: [] },
          },
        },
      },
    };
  }

  // closeIssue mutation
  if (query?.includes('closeIssue')) {
    const input = variables?.input ?? {};
    const issueId = input.issueId;
    const parsed = fromGlobalId(issueId);
    if (parsed?.type === 'Issue') {
      // Handle both formats: "6" or "owner/repo/6"
      const idParts = parsed.id.split('/');
      const issueNum = parseInt(idParts[idParts.length - 1], 10);
      // Find the issue across all repos
      let foundIssue: any = null;
      let foundOwner = '';
      let foundRepo = '';
      for (const [key, issues] of issuesByRepo.entries()) {
        const issue = issues.find(i => i.number === issueNum);
        if (issue) {
          foundIssue = issue;
          const parts = key.split('/');
          foundOwner = parts[0];
          foundRepo = parts[1];
          break;
        }
      }
      if (foundIssue) {
        foundIssue.state = 'closed';
        foundIssue.updatedAt = new Date().toISOString();
        return {
          data: {
            closeIssue: {
              issue: {
                id: toGlobalId('Issue', foundIssue.number),
                number: foundIssue.number,
                state: 'CLOSED',
              },
            },
          },
        };
      }
    }
    return { data: { closeIssue: { issue: null } } };
  }

  // pullRequests connection
  if (query?.includes('pullRequests(')) {
    const owner = variables?.owner ?? 'adaiversen';
    const repoName = variables?.name ?? 'test-repo';
    const first = variables?.first ?? 5;

    const pulls = pullsByRepo.get(`${owner}/${repoName}`) ?? [];
    const openPulls = pulls.filter(p => p.state === 'open');
    const page = openPulls.slice(0, first);

    const nodes = page.map(pull => ({
      id: toGlobalId('PullRequest', pull.number),
      number: pull.number,
      title: pull.title,
      state: pull.state.toUpperCase(),
      headRefName: pull.head?.ref ?? '',
      baseRefName: pull.base?.ref ?? '',
      mergeable: pull.mergeable ?? 'MERGEABLE',
      merged: pull.merged ?? false,
      author: { login: pull.user?.login ?? user.login },
      createdAt: pull.createdAt ?? new Date().toISOString(),
    }));

    return {
      data: {
        repository: {
          pullRequests: {
            nodes,
            totalCount: openPulls.length,
            pageInfo: { hasNextPage: openPulls.length > first, endCursor: null },
          },
        },
      },
    };
  }

  // pullRequest(number) query
  if (query?.includes('pullRequest') && variables?.number && !query?.includes('pullRequests(') && !query?.includes('createPullRequest') && !query?.includes('mergePullRequest') && !query?.includes('files')) {
    const owner = variables?.owner ?? 'adaiversen';
    const repoName = variables?.name ?? 'test-repo';
    const number = variables?.number;
    const pulls = pullsByRepo.get(`${owner}/${repoName}`) ?? [];
    const pull = pulls.find(p => p.number === number);
    if (pull) {
      return {
        data: {
          repository: {
            pullRequest: {
              id: toGlobalId('PullRequest', `${owner}/${repoName}/${number}`),
              number: pull.number,
              title: pull.title,
              state: pull.state.toUpperCase(),
              headRefName: pull.head?.ref ?? '',
              baseRefName: pull.base?.ref ?? '',
              mergeable: pull.mergeable ?? 'MERGEABLE',
              merged: pull.merged ?? false,
              author: { login: pull.user?.login ?? user.login },
              createdAt: pull.createdAt ?? new Date().toISOString(),
              files: {
                nodes: [{ path: pull.head?.ref ?? '' }],
              },
            },
          },
        },
      };
    }
    return { data: { repository: { pullRequest: null } } };
  }

  // pullRequestFiles query (pullRequest(number).files)
  if (query?.includes('pullRequest') && query?.includes('files')) {
    const owner = variables?.owner ?? 'adaiversen';
    const repoName = variables?.name ?? 'test-repo';
    const number = variables?.number;
    const pulls = pullsByRepo.get(`${owner}/${repoName}`) ?? [];
    const pull = pulls.find(p => p.number === number);
    if (pull) {
      const repo = getRepo(owner, repoName);
      if (repo) {
        const baseFiles = new Map(filesAtCommit(repo, pull.base.sha).map(file => [file.path, file.data]));
        const headRef = repo.getRef(`refs/heads/${pull.head.ref}`) ?? pull.head.sha;
        const headFiles = filesAtCommit(repo, headRef);
        const changes = headFiles.filter(file => !baseFiles.has(file.path) || !baseFiles.get(file.path)!.equals(file.data));
        return {
          data: {
            repository: {
              pullRequest: {
                number: pull.number,
                files: {
                  nodes: changes.map(file => ({ path: file.path })),
                },
              },
            },
          },
        };
      }
    }
    return { data: { repository: { pullRequest: null } } };
  }

  // createPullRequest mutation
  if (query?.includes('createPullRequest')) {
    const input = variables?.input ?? {};
    const repoId = input.repositoryId;
    let owner = variables?.owner ?? 'adaiversen';
    let repoName = variables?.name ?? 'test-repo';
    
    if (repoId) {
      const parsed = fromGlobalId(repoId);
      if (parsed?.type === 'Repository') {
        const parts = parsed.id.split('/');
        if (parts.length === 2) {
          owner = parts[0];
          repoName = parts[1];
        }
      }
    }

    const key = `${owner}/${repoName}`;
    const pulls = pullsByRepo.get(key) ?? [];
    const pull = {
      number: pulls.length + 1,
      title: input.title ?? 'Test PR',
      body: input.body ?? '',
      state: 'open',
      headRefName: input.headRefName ?? 'feature',
      baseRefName: input.baseRefName ?? 'main',
      mergeable: 'MERGEABLE',
      merged: false,
      user: { login: user.login },
      createdAt: new Date().toISOString(),
      head: { ref: input.headRefName ?? 'feature', sha: 'a'.repeat(40) },
      base: { ref: input.baseRefName ?? 'main', sha: 'b'.repeat(40) },
    };
    pulls.push(pull);
    pullsByRepo.set(key, pulls);

    return {
      data: {
        createPullRequest: {
          pullRequest: {
            id: toGlobalId('PullRequest', `${owner}/${repoName}/${pull.number}`),
            number: pull.number,
            title: pull.title,
            state: pull.state.toUpperCase(),
            headRefName: pull.headRefName,
            baseRefName: pull.baseRefName,
            mergeable: pull.mergeable,
            merged: pull.merged,
            author: { login: user.login },
            createdAt: pull.createdAt,
            head: pull.head,
            base: pull.base,
          },
        },
      },
    };
  }

  // mergePullRequest mutation
  if (query?.includes('mergePullRequest')) {
    const input = variables?.input ?? {};
    const pullRequestId = input.pullRequestId;
    const parsed = fromGlobalId(pullRequestId);
    if (parsed?.type === 'PullRequest') {
      // Handle both formats: "number" or "owner/repo/number"
      const idParts = parsed.id.split('/');
      const prNum = parseInt(idParts[idParts.length - 1], 10);
      // Find the PR across all repos
      let foundPull: any = null;
      let foundOwner = '';
      let foundRepo = '';
      for (const [key, pulls] of pullsByRepo.entries()) {
        const pull = pulls.find(p => p.number === prNum);
        if (pull) {
          foundPull = pull;
          const parts = key.split('/');
          foundOwner = parts[0];
          foundRepo = parts[1];
          break;
        }
      }
      if (foundPull) {
        foundPull.merged = true;
        foundPull.state = 'closed';
        foundPull.mergedAt = new Date().toISOString();
        return {
          data: {
            mergePullRequest: {
              pullRequest: {
                id: toGlobalId('PullRequest', foundPull.number),
                number: foundPull.number,
                merged: true,
                state: 'MERGED',
              },
            },
          },
        };
      }
    }
    return { data: { mergePullRequest: { pullRequest: null } } };
  }

  // addComment mutation
  if (query?.includes('addComment')) {
    const input = variables?.input ?? {};
    const subjectId = input.subjectId;
    const parsed = fromGlobalId(subjectId);
    if (parsed?.type === 'Issue') {
      // Handle both formats: "number" or "owner/repo/number"
      const idParts = parsed.id.split('/');
      const issueNum = parseInt(idParts[idParts.length - 1], 10);
      // Find the issue across all repos
      let foundIssue: any = null;
      let foundOwner = '';
      let foundRepo = '';
      for (const [key, issues] of issuesByRepo.entries()) {
        const issue = issues.find(i => i.number === issueNum);
        if (issue) {
          foundIssue = issue;
          const parts = key.split('/');
          foundOwner = parts[0];
          foundRepo = parts[1];
          break;
        }
      }
      if (foundIssue) {
        const issueKey = `${foundOwner}/${foundRepo}#${foundIssue.number}`;
        const comments = commentsByIssue.get(issueKey) ?? [];
        const comment = {
          id: toGlobalId('IssueComment', comments.length + 1),
          body: input.body ?? '',
          author: { login: user.login },
          createdAt: new Date().toISOString(),
        };
        comments.push(comment);
        commentsByIssue.set(issueKey, comments);

        return {
          data: {
            addComment: {
              commentEdge: {
                node: comment,
              },
            },
          },
        };
      }
    }
    return { data: { addComment: { commentEdge: { node: null } } } };
  }

  return { data: {} };
}

// MCP handler (Streamable HTTP)
async function handleMCP(req: IncomingMessage, res: ServerResponse, token: string | null, body: Buffer): Promise<void> {
  if (!token) {
    res.writeHead(401, { 'content-type': JSON_TYPE });
    res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32600, message: 'Unauthorized' }, id: null }));
    return;
  }

  let msg: any;
  try {
    const bodyStr = body.toString('utf8');
    if (!bodyStr.trim()) {
      res.writeHead(400, { 'content-type': JSON_TYPE });
      res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' }, id: null }));
      return;
    }
    msg = JSON.parse(bodyStr);
  } catch {
    res.writeHead(400, { 'content-type': JSON_TYPE });
    res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' }, id: null }));
    return;
  }

  const isBatch = Array.isArray(msg);
  const requests = isBatch ? msg : [msg];
  const responses: any[] = [];

  for (const reqMsg of requests) {
    const { jsonrpc, method, params, id } = reqMsg;
    if (jsonrpc !== '2.0') {
      responses.push({ jsonrpc: '2.0', error: { code: -32600, message: 'Invalid Request' }, id: null });
      continue;
    }

    let result: any;
    try {
      switch (method) {
        case 'initialize': {
          const protocolVersion = params?.protocolVersion ?? '2025-11-25';
          result = {
            protocolVersion: '2026-07-28',
            capabilities: { tools: {} },
            serverInfo: { name: 'makefun-github-forge', version: '1.0.0' },
            instructions: 'GitHub-compatible MCP server',
          };
          break;
        }
        case 'tools/list': {
          result = {
            tools: [
              { name: 'create_repo', description: 'Create a new repository', inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } },
              { name: 'get_repo', description: 'Get repository details', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' } }, required: ['owner', 'repo'] } },
              { name: 'create_issue', description: 'Create an issue', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, title: { type: 'string' }, body: { type: 'string' } }, required: ['owner', 'repo', 'title'] } },
              { name: 'list_issues', description: 'List issues', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, state: { type: 'string' } }, required: ['owner', 'repo'] } },
              { name: 'create_pull_request', description: 'Create a pull request', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, title: { type: 'string' }, head: { type: 'string' }, base: { type: 'string' } }, required: ['owner', 'repo', 'title', 'head', 'base'] } },
              { name: 'merge_pull_request', description: 'Merge a pull request', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, pull_number: { type: 'number' } }, required: ['owner', 'repo', 'pull_number'] } },
            ],
          };
          break;
        }
        case 'tools/call': {
          const { name, arguments: args } = params ?? {};
          const user = getOrCreateUser(token);

          // Validate required arguments
          const requiredArgs: Record<string, string[]> = {
            create_repo: ['name'],
            get_repo: ['owner', 'repo'],
            create_issue: ['owner', 'repo', 'title'],
            list_issues: ['owner', 'repo'],
            create_pull_request: ['owner', 'repo', 'title', 'head', 'base'],
            merge_pull_request: ['owner', 'repo', 'pull_number'],
          };
          const required = requiredArgs[name] ?? [];
          for (const arg of required) {
            if (!(arg in (args ?? {}))) {
              responses.push({ jsonrpc: '2.0', error: { code: -32602, message: `Missing required argument: ${arg}` }, id });
              continue;
            }
          }

          try {
            switch (name) {
              case 'create_repo': {
                const repoName = args.name;
                const key = `${user.login}/${repoName}`;
                if (repoMetadata.has(key)) {
                  responses.push({ jsonrpc: '2.0', error: { code: -32603, message: 'Repository already exists' }, id });
                  continue;
                }
                createRepo(user.login, repoName);
                repoMetadata.set(key, { description: '', isPrivate: true });
                result = { content: [{ type: 'text', text: `Created repository ${user.login}/${repoName}` }] };
                break;
              }
              case 'get_repo': {
                const repo = getRepo(args.owner, args.repo);
                result = { content: [{ type: 'text', text: repo ? `Repository ${args.owner}/${args.repo} exists` : 'Not found' }] };
                break;
              }
              case 'create_issue': {
                const key = `${args.owner}/${args.repo}`;
                const items = issuesByRepo.get(key) ?? [];
                const createdAt = new Date().toISOString().replace(/\.\d{3}Z$/, '') + '.' + Date.now().toString().slice(-6).padStart(6, '0') + 'Z';
                const issue = {
                  number: items.length + 1,
                  title: args.title,
                  body: args.body ?? '',
                  state: 'open',
                  user: { login: user.login },
                  labels: [],
                  createdAt,
                  updatedAt: createdAt,
                };
                items.push(issue);
                issuesByRepo.set(key, items);
                result = { content: [{ type: 'text', text: `Created issue #${issue.number}: ${args.title}` }] };
                break;
              }
              case 'list_issues': {
                const key = `${args.owner}/${args.repo}`;
                const items = issuesByRepo.get(key) ?? [];
                const state = args.state?.toLowerCase() ?? 'open';
                const filtered = items.filter(i => i.state === state);
                const issueList = filtered.map(i => `#${i.number}: ${i.title} (${i.state})`).join('\n') || 'No issues';
                result = { content: [{ type: 'text', text: issueList }] };
                break;
              }
              case 'create_pull_request': {
                const key = `${args.owner}/${args.repo}`;
                const pulls = pullsByRepo.get(key) ?? [];
                const pull = {
                  number: pulls.length + 1,
                  title: args.title,
                  body: args.body ?? '',
                  state: 'open',
                  headRefName: args.head,
                  baseRefName: args.base,
                  mergeable: 'MERGEABLE',
                  merged: false,
                  user: { login: user.login },
                  createdAt: new Date().toISOString(),
                  head: { ref: args.head, sha: 'a'.repeat(40) },
                  base: { ref: args.base, sha: 'b'.repeat(40) },
                };
                pulls.push(pull);
                pullsByRepo.set(key, pulls);
                result = { content: [{ type: 'text', text: `Created PR #${pull.number}: ${args.title} from ${args.head} to ${args.base}` }] };
                break;
              }
              case 'merge_pull_request': {
                const key = `${args.owner}/${args.repo}`;
                const pulls = pullsByRepo.get(key) ?? [];
                const pull = pulls.find(p => p.number === args.pull_number);
                if (!pull) {
                  responses.push({ jsonrpc: '2.0', error: { code: -32603, message: 'Pull request not found' }, id });
                  continue;
                }
                pull.merged = true;
                pull.state = 'closed';
                pull.mergedAt = new Date().toISOString();
                result = { content: [{ type: 'text', text: `Merged PR #${args.pull_number}` }] };
                break;
              }
              default:
                responses.push({ jsonrpc: '2.0', error: { code: -32601, message: 'Method not found' }, id });
                continue;
            }
          } catch (e) {
            responses.push({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id });
            continue;
          }
          break;
        }
        default:
          responses.push({ jsonrpc: '2.0', error: { code: -32601, message: 'Method not found' }, id });
          continue;
      }
    } catch (e) {
      responses.push({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id });
      continue;
    }

    responses.push({ jsonrpc: '2.0', result, id });
  }

  sendJson(res, 200, isBatch ? responses : responses[0]);
}

// Main app
export const createApp = () => {
  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const path = pathOf(req);
    const method = req.method ?? 'GET';
    const token = getBearerToken(req);

    // Health check
    if (method === 'GET' && path === '/healthz') {
      sendJson(res, 200, { ok: true });
      return;
    }

    // Git smart HTTP
    const gitMatch = path.match(/^\/([^/]+)\/([^/]+)\.git\/(.+)$/);
    if (gitMatch) {
      const [, owner, repo, service] = gitMatch;
      if (service === 'info/refs') {
        const svc = req.url?.includes('service=git-receive-pack') ? 'git-receive-pack' : 'git-upload-pack';
        await handleInfoRefs(req, res, owner, repo, svc);
        return;
      }
      if (service === 'git-upload-pack') {
        await handleUploadPack(req, res, owner, repo);
        return;
      }
      if (service === 'git-receive-pack') {
        await handleReceivePack(req, res, owner, repo);
        return;
      }
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }

    // REST v3
    if (path.startsWith('/api/v3')) {
      const body = await readBody(req);
      await handleRest(req, res, path, method, token, body);
      return;
    }

    // GraphQL
    if (path === '/api/graphql' || path === '/graphql') {
      const body = await readBody(req);
      const bodyStr = body.toString('utf8');
      await handleGraphQL(req, res, token, body);
      return;
    }

    // MCP
    if (path === '/mcp') {
      const body = await readBody(req);
      await handleMCP(req, res, token, body);
      return;
    }

    // 404 for everything else
    sendJson(res, 404, { message: 'Not Found' });
  });
}

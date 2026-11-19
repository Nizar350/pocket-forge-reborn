// Git object primitives, written from the pack and loose-object formats.
//
// Everything in this module is a pure function over an object store shaped
// as Map<oid, GitObject>. The surfaces (smart HTTP, REST contents, merges)
// share these helpers so an object means the same bytes everywhere.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export type ObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: ObjectType;
  data: Buffer;
}

export type ObjectStore = Map<string, GitObject>;

export const ZERO_OID = '0000000000000000000000000000000000000000';

const TYPE_TO_CODE: Record<ObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TO_TYPE: Record<number, ObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

export function isOid(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}

/** SHA-1 over "<type> <length>\0" followed by the raw object bytes. */
export function hashObject(type: ObjectType, data: Buffer): string {
  const hash = createHash('sha1');
  hash.update(`${type} ${data.length}\0`, 'utf8');
  hash.update(data);
  return hash.digest('hex');
}

/** Insert an object into the store and answer its id (idempotent). */
export function putObject(store: ObjectStore, type: ObjectType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!store.has(oid)) store.set(oid, { type, data });
  return oid;
}

// ---------------------------------------------------------------- trees

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let at = 0;
  while (at < data.length) {
    const space = data.indexOf(0x20, at);
    const nul = data.indexOf(0x00, space + 1);
    const mode = data.subarray(at, space).toString('ascii');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    at = nul + 21;
  }
  return entries;
}

function treeSortKey(entry: TreeEntry): string {
  // Directories sort as if their name carried a trailing slash.
  return entry.mode === '40000' ? `${entry.name}/` : entry.name;
}

export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const ordered = [...entries].sort((a, b) => {
    const ka = treeSortKey(a);
    const kb = treeSortKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const entry of ordered) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- commits and tags

export interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Buffer): CommitView {
  const blank = data.indexOf('\n\n');
  const head = blank < 0 ? data : data.subarray(0, blank);
  const message = blank < 0 ? '' : data.subarray(blank + 2).toString('utf8');
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of head.toString('utf8').split('\n')) {
    const space = line.indexOf(' ');
    if (space < 0) continue;
    const key = line.slice(0, space);
    const value = line.slice(space + 1);
    if (key === 'tree') tree = value;
    else if (key === 'parent') parents.push(value);
    else if (key === 'author') author = value;
    else if (key === 'committer') committer = value;
  }
  return { tree, parents, author, committer, message };
}

export function buildCommit(fields: {
  tree: string;
  parents: readonly string[];
  message: string;
  author: string;
  committer: string;
}): Buffer {
  const lines = [`tree ${fields.tree}`];
  for (const parent of fields.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${fields.author}`);
  lines.push(`committer ${fields.committer}`);
  const body = fields.message.endsWith('\n') ? fields.message : `${fields.message}\n`;
  return Buffer.from(`${lines.join('\n')}\n\n${body}`, 'utf8');
}

export interface TagView {
  object: string;
  type: string;
  tag: string;
  tagger: string;
  message: string;
}

export function parseTag(data: Buffer): TagView {
  const blank = data.indexOf('\n\n');
  const head = blank < 0 ? data : data.subarray(0, blank);
  const fields = new Map<string, string>();
  for (const line of head.toString('utf8').split('\n')) {
    const space = line.indexOf(' ');
    if (space > 0) fields.set(line.slice(0, space), line.slice(space + 1));
  }
  return {
    object: fields.get('object') ?? '',
    type: fields.get('type') ?? '',
    tag: fields.get('tag') ?? '',
    tagger: fields.get('tagger') ?? '',
    message: blank < 0 ? '' : data.subarray(blank + 2).toString('utf8'),
  };
}

/** Peel a ref target through tag objects until a commit (or anything else). */
export function peelToCommit(store: ObjectStore, oid: string): string {
  let current = oid;
  for (let hops = 0; hops < 16; hops += 1) {
    const object = store.get(current);
    if (object === undefined || object.type !== 'tag') return current;
    current = parseTag(object.data).object;
  }
  return current;
}

// ---------------------------------------------------------------- packfiles

/** Apply a git delta stream to its base bytes. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let at = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[at];
      at += 1;
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if ((byte & 0x80) === 0) return value;
    }
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== base.length) throw new Error('delta base size mismatch');
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (at < delta.length) {
    const op = delta[at];
    at += 1;
    if (op & 0x80) {
      let copyAt = 0;
      let copyLen = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) {
          copyAt += delta[at] * 2 ** (bit * 8);
          at += 1;
        }
      }
      for (let bit = 0; bit < 3; bit += 1) {
        if (op & (0x10 << bit)) {
          copyLen += delta[at] * 2 ** (bit * 8);
          at += 1;
        }
      }
      if (copyLen === 0) copyLen = 0x10000;
      base.copy(out, written, copyAt, copyAt + copyLen);
      written += copyLen;
    } else if (op !== 0) {
      delta.copy(out, written, at, at + op);
      at += op;
      written += op;
    } else {
      throw new Error('delta opcode zero');
    }
  }
  if (written !== targetSize) throw new Error('delta target size mismatch');
  return out;
}

interface RawPackEntry {
  offset: number;
  typeCode: number;
  inflated: Buffer;
  baseOffset: number;
  baseOid: string;
}

/**
 * Read a whole packfile into the store. Delta bases may live in the pack
 * itself or, for a thin pack, in the store already (resolveBase covers the
 * second case by consulting the same store). Returns the object ids read.
 */
export function readPack(store: ObjectStore, pack: Buffer): string[] {
  if (pack.length < 32 || pack.subarray(0, 4).toString('ascii') !== 'PACK') {
    throw new Error('not a packfile');
  }
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const trailerAt = pack.length - 20;
  const raw: RawPackEntry[] = [];
  const byOffset = new Map<number, RawPackEntry & { resolvedOid?: string }>();
  let at = 12;
  for (let index = 0; index < count; index += 1) {
    const entryAt = at;
    let byte = pack[at];
    at += 1;
    const typeCode = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = pack[at];
      at += 1;
      size += (byte & 0x7f) * 2 ** shift;
      shift += 7;
    }
    let baseOffset = 0;
    let baseOid = '';
    if (typeCode === 6) {
      let b = pack[at];
      at += 1;
      let value = b & 0x7f;
      while (b & 0x80) {
        b = pack[at];
        at += 1;
        value = (value + 1) * 128 + (b & 0x7f);
      }
      baseOffset = entryAt - value;
    } else if (typeCode === 7) {
      baseOid = pack.subarray(at, at + 20).toString('hex');
      at += 20;
    }
    // Inflate exactly one stream: hand zlib the rest and ask how far it got.
    const sliced = pack.subarray(at, trailerAt);
    const result = inflateSync(sliced, { info: true }) as unknown as {
      buffer: Buffer;
      engine: { bytesWritten: number };
    };
    if (result.buffer.length !== size) throw new Error('pack entry size mismatch');
    at += result.engine.bytesWritten;
    const entry: RawPackEntry = { offset: entryAt, typeCode, inflated: result.buffer, baseOffset, baseOid };
    raw.push(entry);
    byOffset.set(entryAt, entry);
  }

  const resolved = new Map<number, { type: ObjectType; data: Buffer; oid: string }>();
  const resolve = (entry: RawPackEntry): { type: ObjectType; data: Buffer; oid: string } => {
    const memo = resolved.get(entry.offset);
    if (memo !== undefined) return memo;
    let type: ObjectType;
    let data: Buffer;
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset);
      if (baseEntry === undefined) throw new Error('ofs-delta base missing');
      const base = resolve(baseEntry);
      type = base.type;
      data = applyDelta(base.data, entry.inflated);
    } else if (entry.typeCode === 7) {
      const inPack = raw.find((candidate) => {
        if (candidate.typeCode === 6 || candidate.typeCode === 7) return false;
        return hashObject(CODE_TO_TYPE[candidate.typeCode], candidate.inflated) === entry.baseOid;
      });
      if (inPack !== undefined) {
        const base = resolve(inPack);
        type = base.type;
        data = applyDelta(base.data, entry.inflated);
      } else {
        const external = store.get(entry.baseOid);
        if (external === undefined) throw new Error('ref-delta base missing');
        type = external.type;
        data = applyDelta(external.data, entry.inflated);
      }
    } else {
      type = CODE_TO_TYPE[entry.typeCode];
      data = entry.inflated;
    }
    const done = { type, data, oid: hashObject(type, data) };
    resolved.set(entry.offset, done);
    return done;
  };

  const ids: string[] = [];
  for (const entry of raw) {
    const object = resolve(entry);
    if (!store.has(object.oid)) store.set(object.oid, { type: object.type, data: object.data });
    ids.push(object.oid);
  }
  return ids;
}

function packEntryHeader(type: ObjectType, size: number): Buffer {
  const code = TYPE_TO_CODE[type];
  const bytes: number[] = [];
  let rest = Math.floor(size / 16);
  let head = (code << 4) | (size & 0x0f);
  while (rest > 0) {
    bytes.push(head | 0x80);
    head = rest & 0x7f;
    rest = Math.floor(rest / 128);
  }
  bytes.push(head);
  return Buffer.from(bytes);
}

/** Build a plain (delta-free) packfile from whole objects, in the given order. */
export function writePack(objects: readonly GitObject[]): Buffer {
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  const parts: Buffer[] = [header];
  for (const object of objects) {
    parts.push(packEntryHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

// ---------------------------------------------------------------- reachability

/**
 * Every object reachable from the roots. When `cutParentsOf` names a commit,
 * that commit itself counts as reached but its parents are not followed:
 * this is how a shallow boundary on the client side limits what a "have"
 * actually proves the client holds.
 */
export function closureOf(
  store: ObjectStore,
  roots: Iterable<string>,
  cutParentsOf?: ReadonlySet<string>,
): Set<string> {
  const seen = new Set<string>();
  const stack: string[] = [];
  for (const root of roots) if (isOid(root) && root !== ZERO_OID) stack.push(root);
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    const object = store.get(oid);
    if (object === undefined) continue;
    seen.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      stack.push(commit.tree);
      if (cutParentsOf === undefined || !cutParentsOf.has(oid)) {
        for (const parent of commit.parents) stack.push(parent);
      }
    } else if (object.type === 'tag') {
      stack.push(parseTag(object.data).object);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) {
        if (entry.mode !== '160000') stack.push(entry.oid);
      }
    }
  }
  return seen;
}

/** True when `ancestor` is `descendant` itself or one of its ancestors. */
export function isAncestor(store: ObjectStore, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const target = store.get(descendant);
  if (target !== undefined && target.type === 'commit') {
    // The common push case: the new commit sits directly on the old tip.
    if (parseCommit(target.data).parents.includes(ancestor)) return true;
  }
  const seen = new Set<string>();
  const stack = [descendant];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (oid === ancestor) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = store.get(oid);
    if (object === undefined) continue;
    if (object.type === 'commit') {
      for (const parent of parseCommit(object.data).parents) stack.push(parent);
    } else if (object.type === 'tag') {
      stack.push(parseTag(object.data).object);
    }
  }
  return false;
}

/** The nearest common ancestor of two commits, by breadth-first ancestry. */
export function mergeBaseOf(store: ObjectStore, a: string, b: string): string | null {
  const ancestorsOf = (tip: string): Set<string> => {
    const found = new Set<string>();
    const stack = [tip];
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (found.has(oid)) continue;
      const object = store.get(oid);
      if (object === undefined || object.type !== 'commit') continue;
      found.add(oid);
      for (const parent of parseCommit(object.data).parents) stack.push(parent);
    }
    return found;
  };
  const fromA = ancestorsOf(a);
  // Walk b breadth-first so the first shared commit is a nearest one.
  const seen = new Set<string>();
  const queue = [b];
  while (queue.length > 0) {
    const oid = queue.shift() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    if (fromA.has(oid)) return oid;
    const object = store.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) queue.push(parent);
  }
  return null;
}

// ---------------------------------------------------------------- file snapshots

/** Flatten a commit's tree into path -> blob id. Missing commit: empty map. */
export function snapshotFiles(store: ObjectStore, commitOid: string): Map<string, string> {
  const files = new Map<string, string>();
  const commit = store.get(commitOid);
  if (commit === undefined || commit.type !== 'commit') return files;
  const walk = (treeOid: string, prefix: string): void => {
    const tree = store.get(treeOid);
    if (tree === undefined || tree.type !== 'tree') return;
    for (const entry of parseTree(tree.data)) {
      if (entry.mode === '40000') walk(entry.oid, `${prefix}${entry.name}/`);
      else files.set(`${prefix}${entry.name}`, entry.oid);
    }
  };
  walk(parseCommit(commit.data).tree, '');
  return files;
}

/** The blob id at one path inside a commit, or null. */
export function fileAt(store: ObjectStore, commitOid: string, path: string): string | null {
  const commit = store.get(commitOid);
  if (commit === undefined || commit.type !== 'commit') return null;
  let treeOid = parseCommit(commit.data).tree;
  const segments = path.split('/');
  for (let index = 0; index < segments.length; index += 1) {
    const tree = store.get(treeOid);
    if (tree === undefined || tree.type !== 'tree') return null;
    const entry = parseTree(tree.data).find((candidate) => candidate.name === segments[index]);
    if (entry === undefined) return null;
    if (index === segments.length - 1) return entry.mode === '40000' ? null : entry.oid;
    if (entry.mode !== '40000') return null;
    treeOid = entry.oid;
  }
  return null;
}

export interface DirEntry {
  name: string;
  path: string;
  type: 'file' | 'dir';
  sha: string;
}

/** One directory level of a commit's tree; null when the path is no directory. */
export function dirAt(store: ObjectStore, commitOid: string, dirPath: string): DirEntry[] | null {
  const commit = store.get(commitOid);
  if (commit === undefined || commit.type !== 'commit') return null;
  let treeOid = parseCommit(commit.data).tree;
  if (dirPath !== '') {
    for (const segment of dirPath.split('/')) {
      const tree = store.get(treeOid);
      if (tree === undefined || tree.type !== 'tree') return null;
      const entry = parseTree(tree.data).find((candidate) => candidate.name === segment);
      if (entry === undefined || entry.mode !== '40000') return null;
      treeOid = entry.oid;
    }
  }
  const tree = store.get(treeOid);
  if (tree === undefined || tree.type !== 'tree') return null;
  const prefix = dirPath === '' ? '' : `${dirPath}/`;
  return parseTree(tree.data).map((entry) => ({
    name: entry.name,
    path: `${prefix}${entry.name}`,
    type: entry.mode === '40000' ? ('dir' as const) : ('file' as const),
    sha: entry.oid,
  }));
}

/** Materialise a path -> blob id map as nested tree objects; returns the root tree id. */
export function treeFromFiles(store: ObjectStore, files: ReadonlyMap<string, string>): string {
  interface Node {
    files: Map<string, string>;
    dirs: Map<string, Node>;
  }
  const root: Node = { files: new Map(), dirs: new Map() };
  for (const [path, oid] of files) {
    const segments = path.split('/');
    let node = root;
    for (let index = 0; index < segments.length - 1; index += 1) {
      let next = node.dirs.get(segments[index]);
      if (next === undefined) {
        next = { files: new Map(), dirs: new Map() };
        node.dirs.set(segments[index], next);
      }
      node = next;
    }
    node.files.set(segments[segments.length - 1], oid);
  }
  const build = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, oid] of node.files) entries.push({ mode: '100644', name, oid });
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
    return putObject(store, 'tree', buildTree(entries));
  };
  return build(root);
}

// ---------------------------------------------------------------- diffs and merges

export interface FileChange {
  path: string;
  status: 'added' | 'modified' | 'removed';
  before: string | null;
  after: string | null;
}

export function diffFiles(
  before: ReadonlyMap<string, string>,
  after: ReadonlyMap<string, string>,
): FileChange[] {
  const changes: FileChange[] = [];
  for (const [path, oid] of after) {
    const old = before.get(path);
    if (old === undefined) changes.push({ path, status: 'added', before: null, after: oid });
    else if (old !== oid) changes.push({ path, status: 'modified', before: old, after: oid });
  }
  for (const [path, oid] of before) {
    if (!after.has(path)) changes.push({ path, status: 'removed', before: oid, after: null });
  }
  changes.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return changes;
}

/**
 * Three-way merge of file snapshots by blob identity. A path conflicts when
 * both sides changed it to different blobs (a delete counts as a change).
 */
export function mergeFiles(
  base: ReadonlyMap<string, string>,
  ours: ReadonlyMap<string, string>,
  theirs: ReadonlyMap<string, string>,
): { merged: Map<string, string> } | { conflict: string } {
  const merged = new Map<string, string>();
  const paths = new Set<string>([...base.keys(), ...ours.keys(), ...theirs.keys()]);
  for (const path of paths) {
    const b = base.get(path);
    const o = ours.get(path);
    const t = theirs.get(path);
    if (o === t) {
      if (o !== undefined) merged.set(path, o);
    } else if (b === o) {
      if (t !== undefined) merged.set(path, t);
    } else if (b === t) {
      if (o !== undefined) merged.set(path, o);
    } else {
      return { conflict: path };
    }
  }
  return { merged };
}

/** Line-level addition/deletion counts between two texts (LCS over lines). */
export function lineDiffCounts(before: string, after: string): { additions: number; deletions: number } {
  const a = before === '' ? [] : before.split('\n');
  const b = after === '' ? [] : after.split('\n');
  // Trailing newline produces a phantom empty final line on both sides; it
  // cancels out in the LCS, so no special handling is needed.
  if (a.length * b.length > 4_000_000) {
    // Very large inputs: fall back to whole-file accounting.
    return { additions: b.length, deletions: a.length };
  }
  const dp = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i += 1) {
    let diagonal = 0;
    for (let j = 1; j <= b.length; j += 1) {
      const above = dp[j];
      if (a[i - 1] === b[j - 1]) dp[j] = diagonal + 1;
      else dp[j] = Math.max(dp[j], dp[j - 1]);
      diagonal = above;
    }
  }
  const common = dp[b.length];
  return { additions: b.length - common, deletions: a.length - common };
}

// Git smart HTTP: info/refs advertisements, protocol v2 ls-refs and fetch,
// protocol v0 fetch, and v0 receive-pack pushes.
//
// The wire shapes here follow the git protocol as the suite's own client
// speaks it: pkt-line framing everywhere, side-band-64k around pack data
// and around the push report, shallow boundaries reported in a
// shallow-info section, and per-ref ok/ng lines in report-status.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  ZERO_OID,
  closureOf,
  isAncestor,
  isOid,
  parseTag,
  peelToCommit,
  readPack,
  writePack,
  type GitObject,
} from './gitcore.ts';
import type { Forge, Repo } from './store.ts';
import { sendBuffer } from './http.ts';

// ---------------------------------------------------------------- pkt-lines

function pkt(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const header = Buffer.from((data.length + 4).toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([header, data]);
}

const FLUSH = Buffer.from('0000', 'ascii');
const DELIM = Buffer.from('0001', 'ascii');

interface Decoded {
  lines: Buffer[];
  rest: Buffer;
  ok: boolean;
}

/** Decode pkt-lines until a flush packet; whatever follows is `rest`. */
function decodeUntilFlush(body: Buffer): Decoded {
  const lines: Buffer[] = [];
  let at = 0;
  while (at + 4 <= body.length) {
    const header = body.subarray(at, at + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(header)) return { lines, rest: body.subarray(at), ok: false };
    const length = Number.parseInt(header, 16);
    if (length === 0) return { lines, rest: body.subarray(at + 4), ok: true };
    if (length === 1 || length === 2) {
      at += 4;
      continue;
    }
    if (length < 4 || at + length > body.length) return { lines, rest: body.subarray(at), ok: false };
    lines.push(body.subarray(at + 4, at + length));
    at += length;
  }
  return { lines, rest: body.subarray(at), ok: lines.length > 0 };
}

/** Decode a whole pkt-line stream (v2 requests: two sections split by a delim). */
function decodeSections(body: Buffer): { head: string[]; args: string[] } | null {
  const head: string[] = [];
  const args: string[] = [];
  let section = 0;
  let at = 0;
  while (at + 4 <= body.length) {
    const header = body.subarray(at, at + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(header)) return null;
    const length = Number.parseInt(header, 16);
    if (length === 0) return { head, args };
    if (length === 1) {
      section = 1;
      at += 4;
      continue;
    }
    if (length === 2) {
      at += 4;
      continue;
    }
    if (length < 4 || at + length > body.length) return null;
    const text = body.subarray(at + 4, at + length).toString('utf8');
    (section === 0 ? head : args).push(text);
    at += length;
  }
  return { head, args };
}

/** Wrap bytes in side-band-64k band-1 packets. */
function sideband(data: Buffer): Buffer {
  const parts: Buffer[] = [];
  const maxChunk = 65515;
  if (data.length === 0) {
    parts.push(pkt(Buffer.from([1])));
    return Buffer.concat(parts);
  }
  for (let at = 0; at < data.length; at += maxChunk) {
    const chunk = data.subarray(at, Math.min(data.length, at + maxChunk));
    parts.push(pkt(Buffer.concat([Buffer.from([1]), chunk])));
  }
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- advertisements

function sortedRefs(repo: Repo): [string, string][] {
  return [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

function defaultTip(forge: Forge, repo: Repo): string | null {
  return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
}

function advertisementV0(forge: Forge, repo: Repo, service: string): Buffer {
  const caps =
    service === 'git-receive-pack'
      ? 'report-status report-status-v2 delete-refs side-band-64k ofs-delta agent=forge/1.0 symref=HEAD:refs/heads/main'
      : 'multi_ack_detailed side-band-64k ofs-delta shallow thin-pack agent=forge/1.0 symref=HEAD:refs/heads/main';
  const parts: Buffer[] = [pkt(`# service=${service}\n`), FLUSH];
  const tip = defaultTip(forge, repo);
  const refs = sortedRefs(repo);
  if (refs.length === 0) {
    parts.push(pkt(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    parts.push(pkt(`${tip ?? ZERO_OID} HEAD\0${caps}\n`));
    for (const [ref, oid] of refs) {
      parts.push(pkt(`${oid} ${ref}\n`));
      const object = forge.objects.get(oid);
      if (object !== undefined && object.type === 'tag') {
        parts.push(pkt(`${peelToCommit(forge.objects, oid)} ${ref}^{}\n`));
      }
    }
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

function advertisementV2(): Buffer {
  const lines = [
    'version 2\n',
    'agent=forge/1.0\n',
    'ls-refs=unborn\n',
    'fetch=shallow wait-for-done\n',
    'object-format=sha1\n',
  ];
  return Buffer.concat([...lines.map((line) => pkt(line)), FLUSH]);
}

// ---------------------------------------------------------------- ls-refs

function handleLsRefs(forge: Forge, repo: Repo, args: readonly string[], res: ServerResponse): void {
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  for (const raw of args) {
    const arg = raw.replace(/\n$/, '');
    if (arg === 'peel') peel = true;
    else if (arg === 'symrefs') symrefs = true;
    else if (arg === 'unborn') unborn = true;
    else if (arg.startsWith('ref-prefix ')) prefixes.push(arg.slice('ref-prefix '.length));
  }
  const matches = (name: string): boolean =>
    prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const lines: string[] = [];
  const tip = defaultTip(forge, repo);
  if (matches('HEAD')) {
    if (tip === null) {
      if (unborn) lines.push(`unborn HEAD${symrefs ? ` symref-target:refs/heads/${repo.defaultBranch}` : ''}\n`);
    } else {
      lines.push(`${tip} HEAD${symrefs ? ` symref-target:refs/heads/${repo.defaultBranch}` : ''}\n`);
    }
  }
  for (const [ref, oid] of sortedRefs(repo)) {
    if (!matches(ref)) continue;
    let line = `${oid} ${ref}`;
    if (peel) {
      const object = forge.objects.get(oid);
      if (object !== undefined && object.type === 'tag') {
        line += ` peeled:${peelToCommit(forge.objects, oid)}`;
      }
    }
    lines.push(`${line}\n`);
  }
  const body = Buffer.concat([...lines.map((line) => pkt(line)), FLUSH]);
  sendBuffer(res, 200, body, 'application/x-git-upload-pack-result');
}

// ---------------------------------------------------------------- fetch

interface FetchAsk {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
}

function selectFetch(
  forge: Forge,
  ask: FetchAsk,
): { objects: GitObject[]; shallow: string[]; unshallow: string[] } {
  const store = forge.objects;
  const haveSet = closureOf(store, ask.haves, new Set(ask.shallow));
  if (ask.depth === null) {
    const wantSet = closureOf(store, ask.wants);
    const objects: GitObject[] = [];
    for (const oid of wantSet) {
      if (haveSet.has(oid)) continue;
      const object = store.get(oid);
      if (object !== undefined) objects.push(object);
    }
    return { objects, shallow: [], unshallow: [] };
  }
  const depth = ask.depth;
  const included = new Set<string>();
  const boundary = new Set<string>();
  const levels = new Map<string, number>();
  const queue: { oid: string; level: number }[] = [];
  for (const want of ask.wants) queue.push({ oid: want, level: 1 });
  while (queue.length > 0) {
    const { oid, level } = queue.shift() as { oid: string; level: number };
    const known = levels.get(oid);
    if (known !== undefined && known <= level) continue;
    const object = store.get(oid);
    if (object === undefined) continue;
    levels.set(oid, level);
    included.add(oid);
    if (object.type === 'tag') {
      queue.push({ oid: parseTag(object.data).object, level });
    } else if (object.type === 'commit') {
      const commit = ((): { tree: string; parents: string[] } => {
        const text = object.data;
        const blank = text.indexOf('\n\n');
        const head = blank < 0 ? text : text.subarray(0, blank);
        let tree = '';
        const parents: string[] = [];
        for (const line of head.toString('utf8').split('\n')) {
          if (line.startsWith('tree ')) tree = line.slice(5);
          else if (line.startsWith('parent ')) parents.push(line.slice(7));
        }
        return { tree, parents };
      })();
      for (const oidInTree of closureOf(store, [commit.tree])) included.add(oidInTree);
      if (level < depth) {
        for (const parent of commit.parents) queue.push({ oid: parent, level: level + 1 });
      } else if (commit.parents.length > 0) {
        boundary.add(oid);
      }
    }
  }
  const objects: GitObject[] = [];
  for (const oid of included) {
    if (haveSet.has(oid)) continue;
    const object = store.get(oid);
    if (object !== undefined) objects.push(object);
  }
  const shallow = [...boundary].filter((oid) => included.has(oid));
  const unshallow = ask.shallow.filter((oid) => included.has(oid) && !boundary.has(oid));
  return { objects, shallow, unshallow };
}

function packForFetch(forge: Forge, ask: FetchAsk, selected: { objects: GitObject[] }): Buffer {
  const key = [
    [...ask.wants].sort().join(','),
    [...ask.haves].sort().join(','),
    [...ask.shallow].sort().join(','),
    ask.depth === null ? 'full' : `d${ask.depth}`,
  ].join('|');
  const cached = forge.packCache.get(key);
  if (cached !== undefined) return cached;
  const pack = writePack(selected.objects);
  if (forge.packCache.size > 256) forge.packCache.clear();
  forge.packCache.set(key, pack);
  return pack;
}

function handleFetchV2(forge: Forge, repo: Repo, args: readonly string[], res: ServerResponse): void {
  const ask: FetchAsk = { wants: [], haves: [], shallow: [], depth: null };
  for (const raw of args) {
    const arg = raw.replace(/\n$/, '');
    if (arg.startsWith('want ')) ask.wants.push(arg.slice(5).trim());
    else if (arg.startsWith('have ')) ask.haves.push(arg.slice(5).trim());
    else if (arg.startsWith('shallow ')) ask.shallow.push(arg.slice(8).trim());
    else if (arg.startsWith('deepen ')) ask.depth = Number.parseInt(arg.slice(7), 10);
  }
  const selected = selectFetch(forge, ask);
  const pack = packForFetch(forge, ask, selected);
  const parts: Buffer[] = [];
  if (selected.shallow.length > 0 || selected.unshallow.length > 0) {
    parts.push(pkt('shallow-info\n'));
    for (const oid of selected.shallow) parts.push(pkt(`shallow ${oid}\n`));
    for (const oid of selected.unshallow) parts.push(pkt(`unshallow ${oid}\n`));
    parts.push(FLUSH);
  }
  parts.push(pkt('packfile\n'));
  parts.push(sideband(pack));
  parts.push(FLUSH);
  sendBuffer(res, 200, Buffer.concat(parts), 'application/x-git-upload-pack-result');
}

function handleFetchV0(forge: Forge, body: Buffer, res: ServerResponse): void {
  const first = decodeUntilFlush(body);
  if (!first.ok) {
    sendBuffer(res, 400, Buffer.from('bad fetch request\n'), 'text/plain');
    return;
  }
  const ask: FetchAsk = { wants: [], haves: [], shallow: [], depth: null };
  for (const lineBuf of first.lines) {
    const line = lineBuf.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('want ')) {
      const oid = line.slice(5, 45);
      if (isOid(oid)) ask.wants.push(oid);
    } else if (line.startsWith('shallow ')) ask.shallow.push(line.slice(8, 48));
    else if (line.startsWith('deepen ')) ask.depth = Number.parseInt(line.slice(7), 10);
  }
  const second = decodeUntilFlush(first.rest);
  for (const lineBuf of second.lines) {
    const line = lineBuf.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('have ')) ask.haves.push(line.slice(5, 45));
  }
  const selected = selectFetch(forge, ask);
  const pack = packForFetch(forge, ask, selected);
  const parts: Buffer[] = [];
  for (const oid of selected.shallow) parts.push(pkt(`shallow ${oid}\n`));
  for (const oid of selected.unshallow) parts.push(pkt(`unshallow ${oid}\n`));
  parts.push(pkt('NAK\n'));
  parts.push(sideband(pack));
  parts.push(FLUSH);
  sendBuffer(res, 200, Buffer.concat(parts), 'application/x-git-upload-pack-result');
}

// ---------------------------------------------------------------- receive-pack

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

function handleReceivePack(forge: Forge, repo: Repo, body: Buffer, res: ServerResponse): void {
  const decoded = decodeUntilFlush(body);
  if (!decoded.ok || decoded.lines.length === 0) {
    sendBuffer(res, 400, Buffer.from('bad push request\n'), 'text/plain');
    return;
  }
  const commands: PushCommand[] = [];
  let capabilities = '';
  decoded.lines.forEach((lineBuf, index) => {
    let line = lineBuf.toString('utf8').replace(/\n$/, '');
    if (index === 0) {
      const nul = line.indexOf('\0');
      if (nul >= 0) {
        capabilities = line.slice(nul + 1);
        line = line.slice(0, nul);
      }
    }
    const parts = line.split(' ');
    if (parts.length >= 3) {
      commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts.slice(2).join(' ') });
    }
  });

  let unpackOk = true;
  let unpackDetail = 'ok';
  const pack = decoded.rest;
  if (pack.length > 0) {
    try {
      readPack(forge.objects, pack);
    } catch {
      unpackOk = false;
      unpackDetail = 'pack parse error';
    }
  }

  const reports: { ref: string; ok: boolean; reason: string }[] = [];
  if (unpackOk) {
    for (const command of commands) {
      reports.push(applyPushCommand(forge, repo, command));
    }
  } else {
    for (const command of commands) reports.push({ ref: command.ref, ok: false, reason: 'unpack failed' });
  }

  const wantsReport =
    capabilities.includes('report-status-v2') || capabilities.includes('report-status');
  if (!wantsReport) {
    sendBuffer(res, 200, Buffer.alloc(0), 'application/x-git-receive-pack-result');
    return;
  }
  const reportLines = [`unpack ${unpackDetail}\n`];
  for (const report of reports) {
    reportLines.push(report.ok ? `ok ${report.ref}\n` : `ng ${report.ref} ${report.reason}\n`);
  }
  const reportStream = Buffer.concat([...reportLines.map((line) => pkt(line)), FLUSH]);
  const payload = capabilities.includes('side-band-64k') ? sideband(reportStream) : reportStream;
  sendBuffer(res, 200, payload, 'application/x-git-receive-pack-result');
}

function applyPushCommand(
  forge: Forge,
  repo: Repo,
  command: PushCommand,
): { ref: string; ok: boolean; reason: string } {
  const { oldOid, newOid, ref } = command;
  const current = repo.refs.get(ref) ?? null;
  if (newOid === ZERO_OID) {
    repo.refs.delete(ref);
    return { ref, ok: true, reason: '' };
  }
  const object = forge.objects.get(newOid);
  if (object === undefined) return { ref, ok: false, reason: 'missing object' };
  if (oldOid === ZERO_OID && current === null) {
    repo.refs.set(ref, newOid);
    return { ref, ok: true, reason: '' };
  }
  const from = current ?? oldOid;
  if (from === newOid) return { ref, ok: true, reason: '' };
  if (object.type === 'commit') {
    if (isAncestor(forge.objects, from, newOid)) {
      repo.refs.set(ref, newOid);
      return { ref, ok: true, reason: '' };
    }
    return { ref, ok: false, reason: 'non-fast-forward' };
  }
  // Tag and other non-commit tips move without an ancestry rule.
  repo.refs.set(ref, newOid);
  return { ref, ok: true, reason: '' };
}

// ---------------------------------------------------------------- entry point

/**
 * Serve one git smart-HTTP request. `tail` is the path after ".git"
 * ("/info/refs", "/git-upload-pack" or "/git-receive-pack").
 */
export function handleGit(
  forge: Forge,
  req: IncomingMessage,
  res: ServerResponse,
  owner: string,
  repoName: string,
  tail: string,
  query: Map<string, string>,
  body: Buffer,
): void {
  const repo = forge.getRepo(owner, repoName);
  if (tail === '/info/refs') {
    if (repo === null) {
      sendBuffer(res, 404, Buffer.from('{"message":"Not Found"}\n'), 'application/json; charset=utf-8');
      return;
    }
    const service = query.get('service') ?? '';
    if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
      sendBuffer(res, 400, Buffer.from('unknown service\n'), 'text/plain');
      return;
    }
    const wantsV2 =
      service === 'git-upload-pack' && (req.headers['git-protocol'] ?? '').includes('version=2');
    const payload = wantsV2 ? advertisementV2() : advertisementV0(forge, repo, service);
    sendBuffer(res, 200, payload, `application/x-${service}-advertisement`, {
      'cache-control': 'no-cache',
    });
    return;
  }
  if (repo === null) {
    sendBuffer(res, 404, Buffer.from('{"message":"Not Found"}\n'), 'application/json; charset=utf-8');
    return;
  }
  if (tail === '/git-upload-pack') {
    const sections = decodeSections(body);
    const commandLine = sections?.head[0]?.replace(/\n$/, '') ?? '';
    if (sections !== null && commandLine === 'command=ls-refs') {
      handleLsRefs(forge, repo, sections.args, res);
      return;
    }
    if (sections !== null && commandLine === 'command=fetch') {
      handleFetchV2(forge, repo, sections.args, res);
      return;
    }
    if (body.length > 0 && body.subarray(0, 4).toString('ascii') !== 'zzzz') {
      handleFetchV0(forge, body, res);
      return;
    }
    sendBuffer(res, 400, Buffer.from('bad upload-pack request\n'), 'text/plain');
    return;
  }
  if (tail === '/git-receive-pack') {
    handleReceivePack(forge, repo, body, res);
    return;
  }
  sendBuffer(res, 404, Buffer.from('{"message":"Not Found"}\n'), 'application/json; charset=utf-8');
}

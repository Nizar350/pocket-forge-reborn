// The REST v3 surface under /api/v3.
//
// Routing is a flat segment dispatch: the caller has already split the path,
// so each request walks a small chain of literal comparisons and lands in
// one handler. Issue reads — the benchmark's hot path — answer from a
// per-issue cache of serialised JSON that is dropped whenever the issue (or
// its comment count view) could have changed.

import type { ServerResponse } from 'node:http';
import { dirAt, fileAt, parseCommit, peelToCommit } from './gitcore.ts';
import {
  VIEWER_ID,
  VIEWER_LOGIN,
  type CommentRec,
  type Forge,
  type IssueRec,
  type PullRec,
  type Repo,
} from './store.ts';
import { JSON_CONTENT_TYPE, isRecord, nextRequestId, sendBuffer, sendError, sendJson } from './http.ts';

export interface RestRequest {
  method: string;
  segments: string[];
  query: Map<string, string>;
  body: unknown;
  bodyMalformed: boolean;
  host: string;
}

// ---------------------------------------------------------------- serialisers

export function repoJson(forge: Forge, repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: `R_${repo.id}`,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    private: repo.priv,
    description: repo.description,
    default_branch: repo.defaultBranch,
    owner: { login: repo.owner, id: VIEWER_ID, type: 'User' },
    html_url: `/${repo.owner}/${repo.name}`,
    created_at: '2025-01-01T00:00:00Z',
    updated_at: '2025-01-01T00:00:00Z',
    has_issues: true,
  };
}

function labelJson(repo: Repo, name: string): { name: string; color: string } {
  const label = repo.labels.get(name);
  return { name, color: label?.color ?? 'ededed' };
}

export function issueJson(repo: Repo, issue: IssueRec): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: `I_${issue.id}`,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => labelJson(repo, name)),
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    comments: (repo.comments.get(issue.number) ?? []).length,
    created_at: '2025-01-01T00:00:00Z',
    updated_at: '2025-01-01T00:00:00Z',
  };
}

/** The cached serialised body for one issue read (the read workload's path). */
function issueBody(forge: Forge, repo: Repo, issue: IssueRec): Buffer {
  const cached = repo.issueJsonCache.get(issue.number);
  if (cached !== undefined) return cached;
  const body = Buffer.from(`${JSON.stringify(issueJson(repo, issue))}\n`, 'utf8');
  repo.issueJsonCache.set(issue.number, body);
  return body;
}

export function pullJson(forge: Forge, repo: Repo, pull: PullRec): Record<string, unknown> {
  return {
    id: pull.id,
    node_id: `PR_${pull.id}`,
    number: pull.number,
    state: pull.state,
    title: pull.title,
    body: pull.body,
    head: {
      ref: pull.head,
      sha: forge.pullHeadSha(repo, pull),
      label: `${repo.owner}:${pull.head}`,
    },
    base: {
      ref: pull.base,
      sha: forge.pullBaseSha(repo, pull),
      label: `${repo.owner}:${pull.base}`,
    },
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    created_at: '2025-01-01T00:00:00Z',
    updated_at: '2025-01-01T00:00:00Z',
  };
}

function commentJson(comment: CommentRec): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: `C_${comment.id}`,
    body: comment.body,
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    created_at: '2025-01-01T00:00:00Z',
    updated_at: '2025-01-01T00:00:00Z',
  };
}

// ---------------------------------------------------------------- helpers

function pageParams(query: Map<string, string>): { page: number; perPage: number } {
  const perPage = Math.min(100, Math.max(1, Number.parseInt(query.get('per_page') ?? '30', 10) || 30));
  const page = Math.max(1, Number.parseInt(query.get('page') ?? '1', 10) || 1);
  return { page, perPage };
}

function paginate<T>(items: T[], query: Map<string, string>): T[] {
  const { page, perPage } = pageParams(query);
  return items.slice((page - 1) * perPage, page * perPage);
}

function linkHeader(
  host: string,
  path: string,
  query: Map<string, string>,
  total: number,
): Record<string, string> {
  const { page, perPage } = pageParams(query);
  const lastPage = Math.max(1, Math.ceil(total / perPage));
  if (page >= lastPage) return {};
  const params = new URLSearchParams();
  for (const [key, value] of query) if (key !== 'page') params.set(key, value);
  params.set('per_page', String(perPage));
  params.set('page', String(page + 1));
  const next = `http://${host}${path}?${params.toString()}`;
  params.set('page', String(lastPage));
  const last = `http://${host}${path}?${params.toString()}`;
  return { link: `<${next}>; rel="next", <${last}>; rel="last"` };
}

function bodyObject(req: RestRequest): Record<string, unknown> {
  return isRecord(req.body) ? req.body : {};
}

function stringField(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  return typeof value === 'string' ? value : undefined;
}

/** Resolve a ref-ish value (branch name, full ref or sha) to a commit id. */
function resolveRef(forge: Forge, repo: Repo, ref: string | undefined): string | null {
  if (ref === undefined || ref === '') return forge.branchTip(repo, repo.defaultBranch);
  const byRef = repo.refs.get(ref);
  if (byRef !== undefined) return byRef;
  const byBranch = repo.refs.get(`refs/heads/${ref}`);
  if (byBranch !== undefined) return byBranch;
  const object = forge.objects.get(ref);
  if (object !== undefined && object.type === 'commit') return ref;
  if (object !== undefined && object.type === 'tag') return peelToCommit(forge.objects, ref);
  return null;
}

// ---------------------------------------------------------------- top-level dispatch

export function handleRest(forge: Forge, req: RestRequest, res: ServerResponse): void {
  const { segments, method } = req;
  if (req.bodyMalformed && (method === 'POST' || method === 'PUT' || method === 'PATCH')) {
    sendError(res, 400, 'Malformed JSON body');
    return;
  }
  if (segments.length === 0) {
    if (method === 'GET') {
      sendJson(
        res,
        200,
        { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' },
        { 'x-oauth-scopes': 'repo, read:org' },
      );
      return;
    }
    sendError(res, 404, 'Not Found');
    return;
  }
  if (segments[0] === 'meta' && segments.length === 1) {
    if (method === 'GET') sendJson(res, 200, { installed_version: '1.0.0', verifiable_password_authentication: false });
    else sendError(res, 404, 'Not Found');
    return;
  }
  if (segments[0] === 'user') {
    handleUser(forge, req, res);
    return;
  }
  if (segments[0] === 'repos' && segments.length >= 3) {
    handleRepo(forge, req, res);
    return;
  }
  sendError(res, 404, 'Not Found');
}

function handleUser(forge: Forge, req: RestRequest, res: ServerResponse): void {
  const { segments, method } = req;
  if (segments.length === 1) {
    if (method === 'GET') {
      sendJson(res, 200, { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User', name: 'Forge Viewer' });
      return;
    }
    sendError(res, 404, 'Not Found');
    return;
  }
  if (segments[1] === 'repos' && segments.length === 2) {
    if (method === 'GET') {
      const all = forge.listRepos();
      const page = paginate(all, req.query);
      const headers = linkHeader(req.host, '/api/v3/user/repos', req.query, all.length);
      sendJson(res, 200, page.map((repo) => repoJson(forge, repo)), headers);
      return;
    }
    if (method === 'POST') {
      const body = bodyObject(req);
      const name = stringField(body, 'name');
      if (name === undefined || name === '') {
        sendError(res, 422, 'name is required');
        return;
      }
      const repo = forge.createRepo(name, {
        description: stringField(body, 'description') ?? '',
        priv: typeof body.private === 'boolean' ? body.private : false,
      });
      if (repo === null) {
        sendError(res, 422, 'name already exists on this account');
        return;
      }
      sendJson(res, 201, repoJson(forge, repo));
      return;
    }
  }
  sendError(res, 404, 'Not Found');
}

// ---------------------------------------------------------------- one repository

function handleRepo(forge: Forge, req: RestRequest, res: ServerResponse): void {
  const { segments, method } = req;
  const owner = segments[1];
  const name = segments[2];
  const rest = segments.slice(3);
  const repo = forge.getRepo(owner, name);

  if (rest.length === 0) {
    if (repo === null) {
      sendError(res, 404, 'Not Found');
      return;
    }
    if (method === 'GET') {
      sendJson(res, 200, repoJson(forge, repo));
      return;
    }
    if (method === 'PATCH') {
      const body = bodyObject(req);
      const description = stringField(body, 'description');
      if (description !== undefined) repo.description = description;
      const newName = stringField(body, 'name');
      if (typeof body.private === 'boolean') repo.priv = body.private;
      if (newName !== undefined && newName !== '' && newName !== repo.name) {
        forge.repos.delete(`${repo.owner}/${repo.name}`);
        repo.name = newName;
        forge.repos.set(`${repo.owner}/${repo.name}`, repo);
      }
      sendJson(res, 200, repoJson(forge, repo));
      return;
    }
    if (method === 'DELETE') {
      forge.deleteRepo(owner, name);
      res.writeHead(204, { 'x-github-request-id': 'forge-del' });
      res.end();
      return;
    }
    sendError(res, 404, 'Not Found');
    return;
  }

  if (repo === null) {
    sendError(res, 404, 'Not Found');
    return;
  }

  const head = rest[0];
  if (head === 'branches') return branchesRoute(forge, req, res, repo, rest.slice(1));
  if (head === 'commits') return commitsRoute(forge, req, res, repo, rest.slice(1));
  if (head === 'contents') return contentsRoute(forge, req, res, repo, rest.slice(1));
  if (head === 'labels') return labelsRoute(forge, req, res, repo, rest.slice(1));
  if (head === 'issues') return issuesRoute(forge, req, res, repo, rest.slice(1));
  if (head === 'pulls') return pullsRoute(forge, req, res, repo, rest.slice(1));
  if (head === 'git' && rest[1] === 'refs') return gitRefsRoute(forge, req, res, repo, rest.slice(2));
  sendError(res, 404, 'Not Found');
}

function branchesRoute(
  forge: Forge,
  req: RestRequest,
  res: ServerResponse,
  repo: Repo,
  rest: string[],
): void {
  if (rest.length === 0) {
    if (req.method !== 'GET') return sendError(res, 404, 'Not Found');
    const branches: Record<string, unknown>[] = [];
    for (const [ref, oid] of repo.refs) {
      if (ref.startsWith('refs/heads/')) {
        branches.push({ name: ref.slice('refs/heads/'.length), commit: { sha: oid }, protected: false });
      }
    }
    branches.sort((a, b) => String(a.name) < String(b.name) ? -1 : 1);
    sendJson(res, 200, branches);
    return;
  }
  const branch = rest.join('/');
  if (req.method === 'GET') {
    const tip = forge.branchTip(repo, branch);
    if (tip === null) return sendError(res, 404, 'Not Found');
    sendJson(res, 200, { name: branch, commit: { sha: tip }, protected: false });
    return;
  }
  sendError(res, 404, 'Not Found');
}

function commitsRoute(
  forge: Forge,
  req: RestRequest,
  res: ServerResponse,
  repo: Repo,
  rest: string[],
): void {
  if (req.method !== 'GET') return sendError(res, 404, 'Not Found');
  if (rest.length === 1) {
    const object = forge.objects.get(rest[0]);
    if (object === undefined || object.type !== 'commit') return sendError(res, 404, 'Not Found');
    const commit = parseCommit(object.data);
    sendJson(res, 200, {
      sha: rest[0],
      commit: { message: commit.message.replace(/\n$/, ''), author: { name: commit.author }, committer: { name: commit.committer }, tree: { sha: commit.tree } },
      parents: commit.parents.map((sha) => ({ sha })),
    });
    return;
  }
  const from = resolveRef(forge, repo, req.query.get('sha') ?? undefined);
  if (from === null) {
    sendJson(res, 200, []);
    return;
  }
  const commits = forge.listCommits(repo, from).map((entry) => {
    const object = forge.objects.get(entry.sha);
    const commit = object !== undefined && object.type === 'commit' ? parseCommit(object.data) : null;
    return {
      sha: entry.sha,
      commit: {
        message: entry.message,
        author: { name: commit?.author ?? '' },
        committer: { name: commit?.committer ?? '' },
        tree: { sha: commit?.tree ?? '' },
      },
      parents: (commit?.parents ?? []).map((sha) => ({ sha })),
    };
  });
  sendJson(res, 200, paginate(commits, req.query));
}

function contentsRoute(
  forge: Forge,
  req: RestRequest,
  res: ServerResponse,
  repo: Repo,
  rest: string[],
): void {
  const path = rest.join('/');
  const body = bodyObject(req);
  if (req.method === 'PUT') {
    const message = stringField(body, 'message') ?? 'Update file';
    const encoded = stringField(body, 'content');
    if (encoded === undefined) return sendError(res, 422, 'content is required');
    const content = Buffer.from(encoded.replace(/\s+/g, ''), 'base64');
    const branch = stringField(body, 'branch') ?? repo.defaultBranch;
    const tip = forge.branchTip(repo, branch) ?? forge.branchTip(repo, repo.defaultBranch);
    const existing = tip === null ? null : fileAt(forge.objects, tip, path);
    const givenSha = stringField(body, 'sha');
    if (existing !== null && givenSha !== undefined && givenSha !== existing) {
      return sendError(res, 409, 'sha does not match the current file');
    }
    const result = forge.commitFile(repo, branch, path, content, message);
    const status = existing === null ? 201 : 200;
    sendJson(res, status, {
      content: {
        name: path.split('/').pop() ?? path,
        path,
        sha: result.blobSha,
        size: content.length,
        type: 'file',
        encoding: 'base64',
      },
      commit: { sha: result.commitSha, message },
    });
    return;
  }
  if (req.method === 'GET') {
    const commit = resolveRef(forge, repo, req.query.get('ref') ?? undefined);
    if (commit === null) return sendError(res, 404, 'Not Found');
    if (path !== '') {
      const blob = fileAt(forge.objects, commit, path);
      if (blob !== null) {
        const data = forge.objects.get(blob)?.data ?? Buffer.alloc(0);
        sendJson(res, 200, {
          name: path.split('/').pop() ?? path,
          path,
          sha: blob,
          size: data.length,
          type: 'file',
          encoding: 'base64',
          content: data.toString('base64'),
        });
        return;
      }
    }
    const dir = dirAt(forge.objects, commit, path);
    if (dir !== null) {
      sendJson(
        res,
        200,
        dir.map((entry) => ({ name: entry.name, path: entry.path, sha: entry.sha, type: entry.type })),
      );
      return;
    }
    return sendError(res, 404, 'Not Found');
  }
  if (req.method === 'DELETE') {
    const message = stringField(body, 'message') ?? 'Delete file';
    const branch = stringField(body, 'branch') ?? repo.defaultBranch;
    const tip = forge.branchTip(repo, branch);
    const existing = tip === null ? null : fileAt(forge.objects, tip, path);
    if (existing === null) return sendError(res, 404, 'Not Found');
    const givenSha = stringField(body, 'sha');
    if (givenSha !== undefined && givenSha !== existing) {
      return sendError(res, 409, 'sha does not match the current file');
    }
    const result = forge.commitFile(repo, branch, path, null, message);
    sendJson(res, 200, { content: null, commit: { sha: result.commitSha, message } });
    return;
  }
  sendError(res, 404, 'Not Found');
}

function labelsRoute(
  forge: Forge,
  req: RestRequest,
  res: ServerResponse,
  repo: Repo,
  rest: string[],
): void {
  if (rest.length !== 0) return sendError(res, 404, 'Not Found');
  if (req.method === 'GET') {
    sendJson(res, 200, [...repo.labels.values()].map((label) => ({ name: label.name, color: label.color })));
    return;
  }
  if (req.method === 'POST') {
    const body = bodyObject(req);
    const name = stringField(body, 'name');
    if (name === undefined || name === '') return sendError(res, 422, 'name is required');
    if (repo.labels.has(name)) return sendError(res, 422, 'label already exists');
    const color = stringField(body, 'color') ?? 'ededed';
    repo.labels.set(name, { name, color });
    sendJson(res, 201, { name, color });
    return;
  }
  sendError(res, 404, 'Not Found');
}

function gitRefsRoute(
  forge: Forge,
  req: RestRequest,
  res: ServerResponse,
  repo: Repo,
  rest: string[],
): void {
  if (rest.length === 0) {
    if (req.method === 'GET') {
      const refs = [...repo.refs.entries()].map(([ref, oid]) => ({
        ref,
        object: { sha: oid, type: forge.objects.get(oid)?.type ?? 'commit' },
      }));
      sendJson(res, 200, refs);
      return;
    }
    if (req.method === 'POST') {
      const body = bodyObject(req);
      const ref = stringField(body, 'ref');
      const sha = stringField(body, 'sha');
      if (ref === undefined || sha === undefined) return sendError(res, 422, 'ref and sha are required');
      const object = forge.objects.get(sha);
      if (object === undefined) return sendError(res, 422, 'sha does not exist');
      if (repo.refs.has(ref)) return sendError(res, 422, 'reference already exists');
      repo.refs.set(ref, sha);
      sendJson(res, 201, { ref, object: { sha, type: object.type } });
      return;
    }
    return sendError(res, 404, 'Not Found');
  }
  const ref = `refs/${rest.join('/')}`;
  if (req.method === 'GET') {
    const oid = repo.refs.get(ref);
    if (oid === undefined) return sendError(res, 404, 'Not Found');
    sendJson(res, 200, { ref, object: { sha: oid, type: forge.objects.get(oid)?.type ?? 'commit' } });
    return;
  }
  if (req.method === 'DELETE') {
    if (!repo.refs.delete(ref)) return sendError(res, 404, 'Not Found');
    res.writeHead(204, { 'x-github-request-id': 'forge-del' });
    res.end();
    return;
  }
  sendError(res, 404, 'Not Found');
}

// ---------------------------------------------------------------- issues

function issuesRoute(
  forge: Forge,
  req: RestRequest,
  res: ServerResponse,
  repo: Repo,
  rest: string[],
): void {
  if (rest.length === 0) {
    if (req.method === 'POST') {
      const body = bodyObject(req);
      const title = stringField(body, 'title');
      if (title === undefined) return sendError(res, 422, 'title is required');
      const labels = Array.isArray(body.labels)
        ? body.labels.filter((value): value is string => typeof value === 'string')
        : [];
      for (const label of labels) {
        if (!repo.labels.has(label)) return sendError(res, 422, `label "${label}" does not exist`);
      }
      const issue = forge.createIssue(repo, title, stringField(body, 'body') ?? '', labels);
      sendJson(res, 201, issueJson(repo, issue));
      return;
    }
    if (req.method === 'GET') {
      const state = req.query.get('state') ?? 'open';
      let issues = [...repo.issues.values()];
      if (state === 'open' || state === 'closed') issues = issues.filter((issue) => issue.state === state);
      const direction = req.query.get('direction') ?? 'desc';
      issues.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
      sendJson(res, 200, paginate(issues, req.query).map((issue) => issueJson(repo, issue)));
      return;
    }
    return sendError(res, 404, 'Not Found');
  }
  const number = Number.parseInt(rest[0], 10);
  const issue = Number.isSafeInteger(number) ? repo.issues.get(number) : undefined;
  if (rest.length === 1) {
    if (issue === undefined) return sendError(res, 404, 'Not Found');
    if (req.method === 'GET') {
      // Hot path: answer from the serialised cache when we can.
      sendBuffer(res, 200, issueBody(forge, repo, issue), JSON_CONTENT_TYPE, {
        'x-github-request-id': nextRequestId(),
      });
      return;
    }
    if (req.method === 'PATCH') {
      const body = bodyObject(req);
      const state = stringField(body, 'state');
      if (state === 'open' || state === 'closed') issue.state = state;
      const title = stringField(body, 'title');
      if (title !== undefined) issue.title = title;
      const text = stringField(body, 'body');
      if (text !== undefined) issue.body = text;
      if (Array.isArray(body.labels)) {
        const labels = body.labels.filter((value): value is string => typeof value === 'string');
        for (const label of labels) {
          if (!repo.labels.has(label)) return sendError(res, 422, `label "${label}" does not exist`);
        }
        issue.labels = labels;
      }
      repo.issueJsonCache.delete(issue.number);
      sendJson(res, 200, issueJson(repo, issue));
      return;
    }
    return sendError(res, 404, 'Not Found');
  }
  if (rest.length === 2 && rest[1] === 'comments') {
    if (issue === undefined) return sendError(res, 404, 'Not Found');
    if (req.method === 'GET') {
      const comments = repo.comments.get(issue.number) ?? [];
      sendJson(res, 200, comments.map(commentJson));
      return;
    }
    if (req.method === 'POST') {
      const body = bodyObject(req);
      const text = stringField(body, 'body');
      if (text === undefined) return sendError(res, 422, 'body is required');
      const comment = forge.addComment(repo, issue.number, text);
      repo.issueJsonCache.delete(issue.number);
      sendJson(res, 201, commentJson(comment));
      return;
    }
  }
  sendError(res, 404, 'Not Found');
}

// ---------------------------------------------------------------- pull requests

function pullsRoute(
  forge: Forge,
  req: RestRequest,
  res: ServerResponse,
  repo: Repo,
  rest: string[],
): void {
  if (rest.length === 0) {
    if (req.method === 'POST') {
      const body = bodyObject(req);
      const title = stringField(body, 'title') ?? '';
      let head = stringField(body, 'head') ?? '';
      let base = stringField(body, 'base') ?? repo.defaultBranch;
      if (head.includes(':')) head = head.split(':').pop() as string;
      if (base.includes(':')) base = base.split(':').pop() as string;
      const pull = forge.createPull(repo, title, stringField(body, 'body') ?? '', head, base);
      if (pull === null) return sendError(res, 422, 'head or base branch does not exist');
      sendJson(res, 201, pullJson(forge, repo, pull));
      return;
    }
    if (req.method === 'GET') {
      const state = req.query.get('state') ?? 'open';
      let pulls = [...repo.pulls.values()];
      if (state === 'open' || state === 'closed') pulls = pulls.filter((pull) => pull.state === state);
      pulls.sort((a, b) => a.number - b.number);
      sendJson(res, 200, paginate(pulls, req.query).map((pull) => pullJson(forge, repo, pull)));
      return;
    }
    return sendError(res, 404, 'Not Found');
  }
  const number = Number.parseInt(rest[0], 10);
  const pull = Number.isSafeInteger(number) ? repo.pulls.get(number) : undefined;
  if (rest.length === 1 && req.method === 'GET') {
    if (pull === undefined) return sendError(res, 404, 'Not Found');
    sendJson(res, 200, pullJson(forge, repo, pull));
    return;
  }
  if (rest.length === 2 && rest[1] === 'files' && req.method === 'GET') {
    if (pull === undefined) return sendError(res, 404, 'Not Found');
    const files = forge.pullFiles(repo, pull).map((change) => ({
      filename: change.path,
      status: change.status === 'removed' ? 'removed' : change.status === 'added' ? 'added' : 'modified',
      additions: change.additions,
      deletions: change.deletions,
      changes: change.additions + change.deletions,
      sha: change.after ?? change.before ?? '',
    }));
    sendJson(res, 200, files);
    return;
  }
  if (rest.length === 2 && rest[1] === 'merge' && req.method === 'PUT') {
    if (pull === undefined) return sendError(res, 404, 'Not Found');
    const body = bodyObject(req);
    const method = stringField(body, 'merge_method') ?? 'merge';
    const outcome = forge.mergePull(repo, pull, method);
    if (!outcome.ok) {
      if (outcome.reason === 'conflict') return sendError(res, 405, 'Pull Request is not mergeable: conflict');
      if (outcome.reason === 'already') return sendError(res, 405, 'Pull Request is already merged');
      return sendError(res, 404, 'Not Found');
    }
    sendJson(res, 200, { sha: outcome.sha, merged: true, message: 'Pull Request successfully merged' });
    return;
  }
  sendError(res, 404, 'Not Found');
}

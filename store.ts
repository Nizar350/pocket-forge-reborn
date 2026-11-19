// The shared in-memory store behind every surface.
//
// One Forge instance holds the object store, the repositories and their
// issues, pull requests, labels and comments. REST, GraphQL and MCP all call
// into the operations defined here, so an object created on one surface is
// the same object on the others, with the same ids.
//
// Ids and timestamps come from plain counters, never from the wall clock:
// the same sequence of requests always produces the same state.

import {
  buildCommit,
  closureOf,
  diffFiles,
  isAncestor,
  lineDiffCounts,
  mergeBaseOf,
  mergeFiles,
  parseCommit,
  putObject,
  snapshotFiles,
  treeFromFiles,
  type FileChange,
  type GitObject,
  type ObjectStore,
} from './gitcore.ts';

/** The login the trial token belongs to (the scenario's viewer). */
export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_ID = 1000;

const EPOCH_BASE_MS = Date.UTC(2025, 0, 1, 0, 0, 0);
const COMMIT_BASE_SEC = 1735689600;

export interface IssueRec {
  number: number;
  id: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
}

export interface PullRec {
  number: number;
  id: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  head: string;
  base: string;
  headShaAtCreate: string;
  baseShaAtCreate: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
}

export interface CommentRec {
  id: number;
  issueNumber: number;
  body: string;
}

export interface Repo {
  id: number;
  owner: string;
  name: string;
  description: string;
  priv: boolean;
  defaultBranch: string;
  refs: Map<string, string>;
  labels: Map<string, { name: string; color: string }>;
  issues: Map<number, IssueRec>;
  pulls: Map<number, PullRec>;
  comments: Map<number, CommentRec[]>;
  nextNumber: number;
  /** Serialised REST issue bodies, keyed by issue number; dropped on change. */
  issueJsonCache: Map<number, Buffer>;
}

export type MergeOutcome =
  | { ok: true; sha: string }
  | { ok: false; reason: 'missing' | 'conflict' | 'already' };

export class Forge {
  readonly objects: ObjectStore = new Map();
  readonly repos = new Map<string, Repo>();
  readonly reposById = new Map<number, Repo>();
  /** Finished packfiles for fetch, keyed by a canonical request string. */
  readonly packCache = new Map<string, Buffer>();
  private repoSeq = 0;
  private itemSeq = 0;
  private tick = 0;

  /** A deterministic ISO timestamp, one second later per call. */
  nowIso(): string {
    this.tick += 1;
    return new Date(EPOCH_BASE_MS + this.tick * 1000).toISOString();
  }

  /** A git author/committer line on the same logical clock. */
  private ident(): string {
    this.tick += 1;
    return `Forge <forge@example.invalid> ${COMMIT_BASE_SEC + this.tick} +0000`;
  }

  nextItemId(): number {
    this.itemSeq += 1;
    return this.itemSeq;
  }

  // -------------------------------------------------------------- repos

  createRepo(name: string, opts: { description?: string; priv?: boolean }): Repo | null {
    const key = `${VIEWER_LOGIN}/${name}`;
    if (this.repos.has(key)) return null;
    this.repoSeq += 1;
    const repo: Repo = {
      id: this.repoSeq,
      owner: VIEWER_LOGIN,
      name,
      description: opts.description ?? '',
      priv: opts.priv ?? false,
      defaultBranch: 'main',
      refs: new Map(),
      labels: new Map(),
      issues: new Map(),
      pulls: new Map(),
      comments: new Map(),
      nextNumber: 1,
      issueJsonCache: new Map(),
    };
    this.repos.set(key, repo);
    this.reposById.set(repo.id, repo);
    return repo;
  }

  getRepo(owner: string, name: string): Repo | null {
    if (owner !== VIEWER_LOGIN) return null;
    return this.repos.get(`${owner}/${name}`) ?? null;
  }

  deleteRepo(owner: string, name: string): boolean {
    const repo = this.getRepo(owner, name);
    if (repo === null) return false;
    this.repos.delete(`${owner}/${name}`);
    this.reposById.delete(repo.id);
    return true;
  }

  listRepos(): Repo[] {
    return [...this.repos.values()].sort((a, b) => a.id - b.id);
  }

  // -------------------------------------------------------------- git helpers on a repo

  branchTip(repo: Repo, branch: string): string | null {
    return repo.refs.get(`refs/heads/${branch}`) ?? null;
  }

  refTip(repo: Repo, ref: string): string | null {
    return repo.refs.get(ref) ?? null;
  }

  /** Record a commit object built from a tree and parents; returns its id. */
  makeCommit(tree: string, parents: readonly string[], message: string): string {
    const who = this.ident();
    const data = buildCommit({ tree, parents, message, author: who, committer: who });
    return putObject(this.objects, 'commit', data);
  }

  /**
   * Commit a single file change (or deletion, when content is null) on a
   * branch, creating the branch from the default branch tip when it does
   * not exist yet and rooting it when the repository is still unborn.
   */
  commitFile(
    repo: Repo,
    branch: string,
    path: string,
    content: Buffer | null,
    message: string,
  ): { commitSha: string; blobSha: string | null } {
    let tip = this.branchTip(repo, branch);
    if (tip === null && branch !== repo.defaultBranch) {
      tip = this.branchTip(repo, repo.defaultBranch);
    }
    const files = tip === null ? new Map<string, string>() : snapshotFiles(this.objects, tip);
    let blobSha: string | null = null;
    if (content === null) {
      files.delete(path);
    } else {
      blobSha = putObject(this.objects, 'blob', content);
      files.set(path, blobSha);
    }
    const tree = treeFromFiles(this.objects, files);
    const commitSha = this.makeCommit(tree, tip === null ? [] : [tip], message);
    repo.refs.set(`refs/heads/${branch}`, commitSha);
    return { commitSha, blobSha };
  }

  /** Commits reachable from a tip, newest first (tip, then breadth by ancestry). */
  listCommits(repo: Repo, fromOid: string): { sha: string; message: string }[] {
    const out: { sha: string; message: string }[] = [];
    const seen = new Set<string>();
    const queue = [fromOid];
    while (queue.length > 0) {
      const oid = queue.shift() as string;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const object = this.objects.get(oid);
      if (object === undefined || object.type !== 'commit') continue;
      const commit = parseCommit(object.data);
      out.push({ sha: oid, message: commit.message.replace(/\n$/, '') });
      for (const parent of commit.parents) queue.push(parent);
    }
    return out;
  }

  // -------------------------------------------------------------- issues

  createIssue(repo: Repo, title: string, body: string, labels: string[]): IssueRec {
    const number = repo.nextNumber;
    repo.nextNumber += 1;
    const issue: IssueRec = {
      number,
      id: this.nextItemId(),
      title,
      body,
      state: 'open',
      labels: [...labels],
    };
    repo.issues.set(number, issue);
    return issue;
  }

  addComment(repo: Repo, issueNumber: number, body: string): CommentRec {
    const comment: CommentRec = { id: this.nextItemId(), issueNumber, body };
    const list = repo.comments.get(issueNumber) ?? [];
    list.push(comment);
    repo.comments.set(issueNumber, list);
    return comment;
  }

  // -------------------------------------------------------------- pull requests

  createPull(repo: Repo, title: string, body: string, head: string, base: string): PullRec | null {
    const headTip = this.branchTip(repo, head);
    const baseTip = this.branchTip(repo, base);
    if (headTip === null || baseTip === null) return null;
    const number = repo.nextNumber;
    repo.nextNumber += 1;
    const pull: PullRec = {
      number,
      id: this.nextItemId(),
      title,
      body,
      state: 'open',
      head,
      base,
      headShaAtCreate: headTip,
      baseShaAtCreate: baseTip,
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
    };
    repo.pulls.set(number, pull);
    return pull;
  }

  pullHeadSha(repo: Repo, pull: PullRec): string {
    return this.branchTip(repo, pull.head) ?? pull.headShaAtCreate;
  }

  pullBaseSha(repo: Repo, pull: PullRec): string {
    return this.branchTip(repo, pull.base) ?? pull.baseShaAtCreate;
  }

  /** Files changed between the merge base and the head tip of a pull. */
  pullFiles(repo: Repo, pull: PullRec): (FileChange & { additions: number; deletions: number })[] {
    const headTip = this.pullHeadSha(repo, pull);
    const baseTip = this.pullBaseSha(repo, pull);
    const base = mergeBaseOf(this.objects, baseTip, headTip) ?? baseTip;
    const before = snapshotFiles(this.objects, base);
    const after = snapshotFiles(this.objects, headTip);
    return diffFiles(before, after).map((change) => {
      const beforeText =
        change.before === null ? '' : (this.objects.get(change.before)?.data.toString('utf8') ?? '');
      const afterText =
        change.after === null ? '' : (this.objects.get(change.after)?.data.toString('utf8') ?? '');
      const counts = lineDiffCounts(beforeText, afterText);
      return { ...change, additions: counts.additions, deletions: counts.deletions };
    });
  }

  /** Whether merging the pull right now would conflict, without changing anything. */
  pullConflicts(repo: Repo, pull: PullRec): boolean {
    const headTip = this.pullHeadSha(repo, pull);
    const baseTip = this.pullBaseSha(repo, pull);
    if (isAncestor(this.objects, headTip, baseTip)) return false;
    const base = mergeBaseOf(this.objects, baseTip, headTip);
    const baseFiles = base === null ? new Map<string, string>() : snapshotFiles(this.objects, base);
    const result = mergeFiles(
      baseFiles,
      snapshotFiles(this.objects, baseTip),
      snapshotFiles(this.objects, headTip),
    );
    return 'conflict' in result;
  }

  /**
   * Merge a pull request into its base branch. 'squash' lands one commit
   * whose only parent is the base tip; any other method lands a two-parent
   * merge commit. Either way the pull closes as merged.
   */
  mergePull(repo: Repo, pull: PullRec, method: string): MergeOutcome {
    if (pull.merged) return { ok: false, reason: 'already' };
    const headTip = this.pullHeadSha(repo, pull);
    const baseTip = this.pullBaseSha(repo, pull);
    let sha: string;
    if (isAncestor(this.objects, headTip, baseTip)) {
      sha = baseTip;
    } else {
      const base = mergeBaseOf(this.objects, baseTip, headTip);
      const baseFiles = base === null ? new Map<string, string>() : snapshotFiles(this.objects, base);
      const result = mergeFiles(
        baseFiles,
        snapshotFiles(this.objects, baseTip),
        snapshotFiles(this.objects, headTip),
      );
      if ('conflict' in result) return { ok: false, reason: 'conflict' };
      const tree = treeFromFiles(this.objects, result.merged);
      const parents = method === 'squash' ? [baseTip] : [baseTip, headTip];
      sha = this.makeCommit(tree, parents, `${pull.title}\n`);
      repo.refs.set(`refs/heads/${pull.base}`, sha);
    }
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = this.nowIso();
    pull.mergeCommitSha = sha;
    return { ok: true, sha };
  }

  /** Object ids reachable from refs, for internal walks. */
  reachable(roots: Iterable<string>): Set<string> {
    return closureOf(this.objects, roots);
  }
}

export type { GitObject };

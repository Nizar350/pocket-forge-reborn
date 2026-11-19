// GraphQL v4 at /api/graphql: a small hand-written parser and executor for
// the documents gh and github-mcp-server send.
//
// The parser covers the grammar those clients use: operations with names
// and variable definitions, aliases, arguments with enum/list/object
// values, variables, inline and named fragments, and directives (parsed
// and ignored). The executor resolves against wrapper nodes whose scalar
// fields are plain properties and whose parameterised fields (repository,
// issue, issues, files, the mutations) are resolver functions.

import type { ServerResponse } from 'node:http';
import { VIEWER_LOGIN, type Forge, type IssueRec, type PullRec, type Repo } from './store.ts';
import { isRecord, sendJson } from './http.ts';

// ---------------------------------------------------------------- tokens

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'number'; value: string }
  | { kind: 'punct'; value: string }
  | { kind: 'spread' }
  | { kind: 'eof' };

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let at = 0;
  const isNameStart = (c: string): boolean => /[A-Za-z_]/.test(c);
  const isNameChar = (c: string): boolean => /[A-Za-z0-9_]/.test(c);
  while (at < source.length) {
    const c = source[at];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',' || c === '﻿') {
      at += 1;
      continue;
    }
    if (c === '#') {
      while (at < source.length && source[at] !== '\n') at += 1;
      continue;
    }
    if (source.startsWith('...', at)) {
      tokens.push({ kind: 'spread' });
      at += 3;
      continue;
    }
    if ('{}()[]:=!$@|&'.includes(c)) {
      tokens.push({ kind: 'punct', value: c });
      at += 1;
      continue;
    }
    if (c === '"') {
      if (source.startsWith('"""', at)) {
        const end = source.indexOf('"""', at + 3);
        const value = end < 0 ? source.slice(at + 3) : source.slice(at + 3, end);
        tokens.push({ kind: 'string', value });
        at = end < 0 ? source.length : end + 3;
        continue;
      }
      let value = '';
      at += 1;
      while (at < source.length && source[at] !== '"') {
        if (source[at] === '\\') {
          const esc = source[at + 1];
          if (esc === 'n') value += '\n';
          else if (esc === 't') value += '\t';
          else if (esc === 'r') value += '\r';
          else if (esc === 'b') value += '\b';
          else if (esc === 'f') value += '\f';
          else if (esc === 'u') {
            value += String.fromCharCode(Number.parseInt(source.slice(at + 2, at + 6), 16));
            at += 4;
          } else value += esc;
          at += 2;
        } else {
          value += source[at];
          at += 1;
        }
      }
      at += 1;
      tokens.push({ kind: 'string', value });
      continue;
    }
    if (isNameStart(c)) {
      let end = at;
      while (end < source.length && isNameChar(source[end])) end += 1;
      tokens.push({ kind: 'name', value: source.slice(at, end) });
      at = end;
      continue;
    }
    if (/[0-9-]/.test(c)) {
      let end = at;
      while (end < source.length && /[0-9.eE+-]/.test(source[end])) end += 1;
      tokens.push({ kind: 'number', value: source.slice(at, end) });
      at = end;
      continue;
    }
    at += 1;
  }
  tokens.push({ kind: 'eof' });
  return tokens;
}

// ---------------------------------------------------------------- AST

export type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; items: ValueNode[] }
  | { kind: 'object'; fields: Map<string, ValueNode> };

export interface FieldNode {
  alias: string | null;
  name: string;
  args: Map<string, ValueNode>;
  selections: SelectionNode[] | null;
}

export type SelectionNode =
  | { kind: 'field'; field: FieldNode }
  | { kind: 'inline'; typeCondition: string | null; selections: SelectionNode[] }
  | { kind: 'spread'; name: string };

export interface OperationNode {
  type: 'query' | 'mutation';
  name: string | null;
  selections: SelectionNode[];
}

interface DocumentNode {
  operations: OperationNode[];
  fragments: Map<string, { typeCondition: string; selections: SelectionNode[] }>;
}

class Parser {
  private tokens: Token[];
  private at = 0;

  constructor(source: string) {
    this.tokens = tokenize(source);
  }

  private peek(): Token {
    return this.tokens[this.at];
  }

  private next(): Token {
    const token = this.tokens[this.at];
    this.at += 1;
    return token;
  }

  private isPunct(value: string): boolean {
    const token = this.peek();
    return token.kind === 'punct' && token.value === value;
  }

  private eatPunct(value: string): boolean {
    if (this.isPunct(value)) {
      this.at += 1;
      return true;
    }
    return false;
  }

  private expectPunct(value: string): void {
    if (!this.eatPunct(value)) throw new Error(`expected "${value}" in GraphQL document`);
  }

  private name(): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error('expected a name in GraphQL document');
    return token.value;
  }

  parseDocument(): DocumentNode {
    const operations: OperationNode[] = [];
    const fragments = new Map<string, { typeCondition: string; selections: SelectionNode[] }>();
    while (this.peek().kind !== 'eof') {
      if (this.isPunct('{')) {
        operations.push({ type: 'query', name: null, selections: this.selectionSet() });
        continue;
      }
      const keyword = this.name();
      if (keyword === 'query' || keyword === 'mutation' || keyword === 'subscription') {
        let opName: string | null = null;
        if (this.peek().kind === 'name') opName = this.name();
        if (this.isPunct('(')) this.skipBalancedParens();
        this.directives();
        operations.push({
          type: keyword === 'mutation' ? 'mutation' : 'query',
          name: opName,
          selections: this.selectionSet(),
        });
      } else if (keyword === 'fragment') {
        const fragName = this.name();
        const on = this.name();
        if (on !== 'on') throw new Error('fragment without type condition');
        const typeCondition = this.name();
        this.directives();
        fragments.set(fragName, { typeCondition, selections: this.selectionSet() });
      } else {
        throw new Error(`unexpected "${keyword}" in GraphQL document`);
      }
    }
    return { operations, fragments };
  }

  private skipBalancedParens(): void {
    let depth = 0;
    do {
      const token = this.next();
      if (token.kind === 'eof') throw new Error('unbalanced parentheses');
      if (token.kind === 'punct' && token.value === '(') depth += 1;
      if (token.kind === 'punct' && token.value === ')') depth -= 1;
    } while (depth > 0);
  }

  private directives(): void {
    while (this.isPunct('@')) {
      this.next();
      this.name();
      if (this.isPunct('(')) this.arguments();
    }
  }

  private arguments(): Map<string, ValueNode> {
    const args = new Map<string, ValueNode>();
    this.expectPunct('(');
    while (!this.isPunct(')')) {
      const key = this.name();
      this.expectPunct(':');
      args.set(key, this.value());
    }
    this.expectPunct(')');
    return args;
  }

  private value(): ValueNode {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') {
      return { kind: 'variable', name: this.name() };
    }
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'number') {
      return token.value.includes('.') || token.value.includes('e')
        ? { kind: 'float', value: Number.parseFloat(token.value) }
        : { kind: 'int', value: Number.parseInt(token.value, 10) };
    }
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    if (token.kind === 'punct' && token.value === '[') {
      const items: ValueNode[] = [];
      while (!this.isPunct(']')) items.push(this.value());
      this.expectPunct(']');
      return { kind: 'list', items };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields = new Map<string, ValueNode>();
      while (!this.isPunct('}')) {
        const key = this.name();
        this.expectPunct(':');
        fields.set(key, this.value());
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    throw new Error('unexpected value in GraphQL document');
  }

  private selectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!this.isPunct('}')) {
      if (this.peek().kind === 'spread') {
        this.next();
        if (this.peek().kind === 'name' && (this.peek() as { value: string }).value === 'on') {
          this.next();
          const typeCondition = this.name();
          this.directives();
          selections.push({ kind: 'inline', typeCondition, selections: this.selectionSet() });
        } else if (this.isPunct('{')) {
          selections.push({ kind: 'inline', typeCondition: null, selections: this.selectionSet() });
        } else {
          selections.push({ kind: 'spread', name: this.name() });
          this.directives();
        }
        continue;
      }
      let fieldName = this.name();
      let alias: string | null = null;
      if (this.isPunct(':')) {
        this.next();
        alias = fieldName;
        fieldName = this.name();
      }
      const args = this.isPunct('(') ? this.arguments() : new Map<string, ValueNode>();
      this.directives();
      const sub = this.isPunct('{') ? this.selectionSet() : null;
      selections.push({ kind: 'field', field: { alias, name: fieldName, args, selections: sub } });
    }
    this.expectPunct('}');
    return selections;
  }
}

function resolveValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable':
      return variables[node.name];
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
    case 'enum':
      return node.value;
    case 'null':
      return null;
    case 'list':
      return node.items.map((item) => resolveValue(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, value] of node.fields) out[key] = resolveValue(value, variables);
      return out;
    }
  }
}

// ---------------------------------------------------------------- global ids

function encodeId(type: string, key: string): string {
  return Buffer.from(`${type}:${key}`, 'utf8').toString('base64url');
}

function decodeId(id: string): { type: string; key: string } | null {
  try {
    const text = Buffer.from(id, 'base64url').toString('utf8');
    const colon = text.indexOf(':');
    if (colon <= 0) return null;
    return { type: text.slice(0, colon), key: text.slice(colon + 1) };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- nodes

type GqlNode = Record<string, unknown> & { __typename: string };

interface Ctx {
  forge: Forge;
  variables: Record<string, unknown>;
  fragments: DocumentNode['fragments'];
  errors: { message: string }[];
}

function userNode(): GqlNode {
  return {
    __typename: 'User',
    login: VIEWER_LOGIN,
    id: encodeId('User', String(1000)),
    name: 'Forge Viewer',
    url: 'https://forge.invalid/',
  };
}

function repoNode(forge: Forge, repo: Repo): GqlNode {
  const tip = forge.branchTip(repo, repo.defaultBranch);
  return {
    __typename: 'Repository',
    _repo: repo,
    id: encodeId('Repository', String(repo.id)),
    databaseId: repo.id,
    name: repo.name,
    nameWithOwner: `${repo.owner}/${repo.name}`,
    description: repo.description,
    isPrivate: repo.priv,
    visibility: repo.priv ? 'PRIVATE' : 'PUBLIC',
    viewerPermission: 'ADMIN',
    hasIssuesEnabled: true,
    hasPullRequestsEnabled: true,
    owner: userNode(),
    defaultBranchRef: tip === null ? null : { __typename: 'Ref', name: repo.defaultBranch },
    url: `https://forge.invalid/${repo.owner}/${repo.name}`,
    createdAt: '2025-01-01T00:00:00Z',
    updatedAt: '2025-01-01T00:00:00Z',
  };
}

function issueNode(forge: Forge, repo: Repo, issue: IssueRec): GqlNode {
  return {
    __typename: 'Issue',
    _repo: repo,
    _rec: issue,
    id: encodeId('Issue', `${repo.id}:${issue.number}`),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state === 'open' ? 'OPEN' : 'CLOSED',
    url: `https://forge.invalid/${repo.owner}/${repo.name}/issues/${issue.number}`,
    createdAt: '2025-01-01T00:00:00Z',
    updatedAt: '2025-01-01T00:00:00Z',
    author: userNode(),
    repository: repoNode(forge, repo),
    labels: {
      __typename: 'LabelConnection',
      nodes: issue.labels.map((name) => ({ __typename: 'Label', name })),
    },
    closed: issue.state === 'closed',
  };
}

function pullNode(forge: Forge, repo: Repo, pull: PullRec): GqlNode {
  return {
    __typename: 'PullRequest',
    _repo: repo,
    _rec: pull,
    id: encodeId('PullRequest', `${repo.id}:${pull.number}`),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED',
    merged: pull.merged,
    headRefName: pull.head,
    baseRefName: pull.base,
    headRef: { __typename: 'Ref', name: pull.head },
    baseRef: { __typename: 'Ref', name: pull.base },
    url: `https://forge.invalid/${repo.owner}/${repo.name}/pull/${pull.number}`,
    createdAt: '2025-01-01T00:00:00Z',
    updatedAt: '2025-01-01T00:00:00Z',
    author: userNode(),
    repository: repoNode(forge, repo),
    isDraft: false,
    additions: 0,
    deletions: 0,
  };
}

// ---------------------------------------------------------------- introspection data

interface TypeInfo {
  kind: string;
  fields: string[];
  enums: string[];
}

const TYPE_INFO: Record<string, TypeInfo> = {
  Issue: {
    kind: 'OBJECT',
    fields: ['id', 'number', 'title', 'state', 'body', 'url', 'createdAt', 'updatedAt', 'author', 'repository', 'labels', 'comments', 'closed'],
    enums: [],
  },
  PullRequest: {
    kind: 'OBJECT',
    fields: ['id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'headRef', 'baseRef', 'files', 'url', 'createdAt', 'updatedAt', 'author', 'repository', 'isDraft', 'additions', 'deletions'],
    enums: [],
  },
  Repository: {
    kind: 'OBJECT',
    fields: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'hasPullRequestsEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'isPrivate', 'visibility', 'url', 'createdAt', 'updatedAt'],
    enums: [],
  },
  SearchType: {
    kind: 'ENUM',
    fields: [],
    enums: ['ISSUE', 'REPOSITORY', 'USER', 'ORGANIZATION', 'PULL_REQUEST', 'DISCUSSION', 'CODE', 'COMMIT', 'MARKETPLACE', 'TOPIC'],
  },
  User: { kind: 'OBJECT', fields: ['id', 'login', 'name', 'url'], enums: [] },
  Query: {
    kind: 'OBJECT',
    fields: ['viewer', 'repository', 'node', 'search', 'user', 'organization', 'rateLimit'],
    enums: [],
  },
  Mutation: {
    kind: 'OBJECT',
    fields: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
    enums: [],
  },
  IssueState: { kind: 'ENUM', fields: [], enums: ['OPEN', 'CLOSED'] },
  PullRequestState: { kind: 'ENUM', fields: [], enums: ['OPEN', 'CLOSED', 'MERGED'] },
  MergeableState: { kind: 'ENUM', fields: [], enums: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'] },
  RepositoryPermission: { kind: 'ENUM', fields: [], enums: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'] },
  IssueOrderField: { kind: 'ENUM', fields: [], enums: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'] },
  OrderDirection: { kind: 'ENUM', fields: [], enums: ['ASC', 'DESC'] },
  PullRequestMergeMethod: { kind: 'ENUM', fields: [], enums: ['MERGE', 'SQUASH', 'REBASE'] },
};

function typeNode(name: string): GqlNode | null {
  const info = TYPE_INFO[name];
  if (info === undefined) return null;
  return { __typename: '__Type', _info: info, _name: name, name, kind: info.kind, description: null };
}

// ---------------------------------------------------------------- connections

function encodeCursor(index: number): string {
  return Buffer.from(`cursor:${index}`, 'utf8').toString('base64url');
}

function decodeCursor(cursor: unknown): number {
  if (typeof cursor !== 'string' || cursor === '') return -1;
  try {
    const text = Buffer.from(cursor, 'base64url').toString('utf8');
    if (!text.startsWith('cursor:')) return -1;
    const value = Number.parseInt(text.slice('cursor:'.length), 10);
    return Number.isSafeInteger(value) ? value : -1;
  } catch {
    return -1;
  }
}

function pageOf<T>(items: T[], args: Record<string, unknown>): { page: T[]; hasNext: boolean; endCursor: string } {
  const first = typeof args.first === 'number' ? Math.max(0, Math.trunc(args.first)) : items.length;
  const afterIndex = decodeCursor(args.after);
  const start = afterIndex + 1;
  const page = items.slice(start, start + first);
  const lastIndex = start + page.length - 1;
  return {
    page,
    hasNext: start + page.length < items.length,
    endCursor: encodeCursor(Math.max(lastIndex, afterIndex)),
  };
}

function issuesConnection(forge: Forge, repo: Repo, args: Record<string, unknown>): GqlNode {
  let issues = [...repo.issues.values()];
  const states = Array.isArray(args.states) ? args.states.map((value) => String(value)) : null;
  if (states !== null) {
    issues = issues.filter((issue) => states.includes(issue.state === 'open' ? 'OPEN' : 'CLOSED'));
  }
  const orderBy = isRecord(args.orderBy) ? args.orderBy : null;
  const direction = orderBy !== null && typeof orderBy.direction === 'string' ? orderBy.direction : 'DESC';
  issues.sort((a, b) => (direction === 'ASC' ? a.number - b.number : b.number - a.number));
  const { page, hasNext, endCursor } = pageOf(issues, args);
  return {
    __typename: 'IssueConnection',
    nodes: page.map((issue) => issueNode(forge, repo, issue)),
    totalCount: issues.length,
    pageInfo: { __typename: 'PageInfo', hasNextPage: hasNext, endCursor, hasPreviousPage: false, startCursor: endCursor },
  };
}

function pullsConnection(forge: Forge, repo: Repo, args: Record<string, unknown>): GqlNode {
  const pulls = [...repo.pulls.values()].sort((a, b) => b.number - a.number);
  const { page, hasNext, endCursor } = pageOf(pulls, args);
  return {
    __typename: 'PullRequestConnection',
    nodes: page.map((pull) => pullNode(forge, repo, pull)),
    totalCount: pulls.length,
    pageInfo: { __typename: 'PageInfo', hasNextPage: hasNext, endCursor, hasPreviousPage: false, startCursor: endCursor },
  };
}

// ---------------------------------------------------------------- resolvers

type Resolver = (node: GqlNode, args: Record<string, unknown>, ctx: Ctx) => unknown;

const RESOLVERS: Record<string, Record<string, Resolver>> = {
  Query: {
    viewer: () => userNode(),
    repository: (node, args, ctx) => {
      const owner = typeof args.owner === 'string' ? args.owner : '';
      const name = typeof args.name === 'string' ? args.name : '';
      const repo = ctx.forge.getRepo(owner, name);
      return repo === null ? null : repoNode(ctx.forge, repo);
    },
    node: (node, args, ctx) => nodeByGlobalId(ctx, typeof args.id === 'string' ? args.id : ''),
    __type: (node, args) => typeNode(typeof args.name === 'string' ? args.name : ''),
    __schema: () => ({
      __typename: '__Schema',
      queryType: typeNode('Query'),
      mutationType: typeNode('Mutation'),
      subscriptionType: null,
    }),
    user: (node, args) => (args.login === VIEWER_LOGIN ? userNode() : null),
    organization: () => null,
    search: () => ({ __typename: 'SearchResultItemConnection', nodes: [], issueCount: 0, repositoryCount: 0, userCount: 0 }),
    rateLimit: () => ({ __typename: 'RateLimit', limit: 5000, remaining: 5000, used: 0, resetAt: '2025-01-01T00:00:00Z' }),
  },
  Mutation: {
    createIssue: (node, args, ctx) => {
      const input = isRecord(args.input) ? args.input : {};
      const decoded = decodeId(typeof input.repositoryId === 'string' ? input.repositoryId : '');
      const repo = decoded !== null && decoded.type === 'Repository'
        ? ctx.forge.reposById.get(Number.parseInt(decoded.key, 10))
        : undefined;
      if (repo === undefined) throw new Error('repository not found for createIssue');
      const issue = ctx.forge.createIssue(
        repo,
        typeof input.title === 'string' ? input.title : '',
        typeof input.body === 'string' ? input.body : '',
        [],
      );
      return { __typename: 'CreateIssuePayload', issue: issueNode(ctx.forge, repo, issue) };
    },
    closeIssue: (node, args, ctx) => {
      const input = isRecord(args.input) ? args.input : {};
      const found = findIssueByGlobalId(ctx, typeof input.issueId === 'string' ? input.issueId : '');
      if (found === null) throw new Error('issue not found for closeIssue');
      found.issue.state = 'closed';
      found.repo.issueJsonCache.delete(found.issue.number);
      return { __typename: 'CloseIssuePayload', issue: issueNode(ctx.forge, found.repo, found.issue) };
    },
    createPullRequest: (node, args, ctx) => {
      const input = isRecord(args.input) ? args.input : {};
      const decoded = decodeId(typeof input.repositoryId === 'string' ? input.repositoryId : '');
      const repo = decoded !== null && decoded.type === 'Repository'
        ? ctx.forge.reposById.get(Number.parseInt(decoded.key, 10))
        : undefined;
      if (repo === undefined) throw new Error('repository not found for createPullRequest');
      const pull = ctx.forge.createPull(
        repo,
        typeof input.title === 'string' ? input.title : '',
        typeof input.body === 'string' ? input.body : '',
        typeof input.headRefName === 'string' ? input.headRefName : '',
        typeof input.baseRefName === 'string' ? input.baseRefName : repo.defaultBranch,
      );
      if (pull === null) throw new Error('head or base branch not found for createPullRequest');
      return { __typename: 'CreatePullRequestPayload', pullRequest: pullNode(ctx.forge, repo, pull) };
    },
    mergePullRequest: (node, args, ctx) => {
      const input = isRecord(args.input) ? args.input : {};
      const found = findPullByGlobalId(ctx, typeof input.pullRequestId === 'string' ? input.pullRequestId : '');
      if (found === null) throw new Error('pull request not found for mergePullRequest');
      const method = typeof input.mergeMethod === 'string' && input.mergeMethod === 'SQUASH' ? 'squash' : 'merge';
      const outcome = ctx.forge.mergePull(found.repo, found.pull, method);
      if (!outcome.ok && outcome.reason === 'conflict') throw new Error('pull request has conflicts');
      return { __typename: 'MergePullRequestPayload', pullRequest: pullNode(ctx.forge, found.repo, found.pull) };
    },
    addComment: (node, args, ctx) => {
      const input = isRecord(args.input) ? args.input : {};
      const found = findIssueByGlobalId(ctx, typeof input.subjectId === 'string' ? input.subjectId : '');
      if (found === null) throw new Error('subject not found for addComment');
      const comment = ctx.forge.addComment(
        found.repo,
        found.issue.number,
        typeof input.body === 'string' ? input.body : '',
      );
      found.repo.issueJsonCache.delete(found.issue.number);
      return {
        __typename: 'AddCommentPayload',
        commentEdge: {
          __typename: 'CommentEdge',
          node: {
            __typename: 'IssueComment',
            id: encodeId('IssueComment', String(comment.id)),
            body: comment.body,
            createdAt: '2025-01-01T00:00:00Z',
            author: userNode(),
          },
        },
      };
    },
  },
  Repository: {
    issue: (node, args, ctx) => {
      const repo = node._repo as Repo;
      const number = typeof args.number === 'number' ? args.number : Number.NaN;
      const issue = repo.issues.get(number);
      return issue === undefined ? null : issueNode(ctx.forge, repo, issue);
    },
    issues: (node, args, ctx) => issuesConnection(ctx.forge, node._repo as Repo, args),
    pullRequest: (node, args, ctx) => {
      const repo = node._repo as Repo;
      const number = typeof args.number === 'number' ? args.number : Number.NaN;
      const pull = repo.pulls.get(number);
      return pull === undefined ? null : pullNode(ctx.forge, repo, pull);
    },
    pullRequests: (node, args, ctx) => pullsConnection(ctx.forge, node._repo as Repo, args),
  },
  PullRequest: {
    mergeable: (node, args, ctx) => {
      const repo = node._repo as Repo;
      const pull = node._rec as PullRec;
      if (pull.merged) return 'UNKNOWN';
      return ctx.forge.pullConflicts(repo, pull) ? 'CONFLICTING' : 'MERGEABLE';
    },
    files: (node, args, ctx) => {
      const repo = node._repo as Repo;
      const pull = node._rec as PullRec;
      const first = typeof args.first === 'number' ? Math.max(0, Math.trunc(args.first)) : 100;
      const files = ctx.forge.pullFiles(repo, pull).slice(0, first);
      return {
        __typename: 'PullRequestChangedFileConnection',
        nodes: files.map((file) => ({ __typename: 'PullRequestChangedFile', path: file.path })),
        totalCount: files.length,
      };
    },
  },
  __Type: {
    fields: (node) => {
      const info = node._info as TypeInfo;
      return info.fields.map((name) => ({ __typename: '__Field', name, description: null }));
    },
    enumValues: (node) => {
      const info = node._info as TypeInfo;
      return info.enums.map((name) => ({ __typename: '__EnumValue', name, description: null }));
    },
  },
};

function findIssueByGlobalId(ctx: Ctx, id: string): { repo: Repo; issue: IssueRec } | null {
  const decoded = decodeId(id);
  if (decoded === null || decoded.type !== 'Issue') return null;
  const [repoId, number] = decoded.key.split(':');
  const repo = ctx.forge.reposById.get(Number.parseInt(repoId, 10));
  if (repo === undefined) return null;
  const issue = repo.issues.get(Number.parseInt(number, 10));
  return issue === undefined ? null : { repo, issue };
}

function findPullByGlobalId(ctx: Ctx, id: string): { repo: Repo; pull: PullRec } | null {
  const decoded = decodeId(id);
  if (decoded === null || decoded.type !== 'PullRequest') return null;
  const [repoId, number] = decoded.key.split(':');
  const repo = ctx.forge.reposById.get(Number.parseInt(repoId, 10));
  if (repo === undefined) return null;
  const pull = repo.pulls.get(Number.parseInt(number, 10));
  return pull === undefined ? null : { repo, pull };
}

function nodeByGlobalId(ctx: Ctx, id: string): GqlNode | null {
  const decoded = decodeId(id);
  if (decoded === null) return null;
  if (decoded.type === 'Repository') {
    const repo = ctx.forge.reposById.get(Number.parseInt(decoded.key, 10));
    return repo === undefined ? null : repoNode(ctx.forge, repo);
  }
  if (decoded.type === 'Issue') {
    const found = findIssueByGlobalId(ctx, id);
    return found === null ? null : issueNode(ctx.forge, found.repo, found.issue);
  }
  if (decoded.type === 'PullRequest') {
    const found = findPullByGlobalId(ctx, id);
    return found === null ? null : pullNode(ctx.forge, found.repo, found.pull);
  }
  if (decoded.type === 'User') return userNode();
  return null;
}

// ---------------------------------------------------------------- execution

function applySelections(
  value: unknown,
  selections: SelectionNode[] | null,
  ctx: Ctx,
): unknown {
  if (value === null || value === undefined) return null;
  if (selections === null) return value;
  if (Array.isArray(value)) return value.map((item) => applySelections(item, selections, ctx));
  if (typeof value !== 'object') return value;
  const node = value as GqlNode;
  const out: Record<string, unknown> = {};
  const walk = (list: SelectionNode[]): void => {
    for (const selection of list) {
      if (selection.kind === 'inline') {
        if (selection.typeCondition === null || typeMatches(node.__typename, selection.typeCondition)) {
          walk(selection.selections);
        }
        continue;
      }
      if (selection.kind === 'spread') {
        const fragment = ctx.fragments.get(selection.name);
        if (fragment !== undefined && typeMatches(node.__typename, fragment.typeCondition)) {
          walk(fragment.selections);
        }
        continue;
      }
      const field = selection.field;
      const key = field.alias ?? field.name;
      if (field.name === '__typename') {
        out[key] = node.__typename;
        continue;
      }
      const args: Record<string, unknown> = {};
      for (const [argName, argValue] of field.args) args[argName] = resolveValue(argValue, ctx.variables);
      const resolver = RESOLVERS[node.__typename]?.[field.name];
      let resolved: unknown;
      if (resolver !== undefined) {
        try {
          resolved = resolver(node, args, ctx);
        } catch (err) {
          ctx.errors.push({ message: err instanceof Error ? err.message : String(err) });
          resolved = null;
        }
      } else if (field.name in node && !field.name.startsWith('_')) {
        resolved = node[field.name];
      } else {
        ctx.errors.push({
          message: `Field '${field.name}' doesn't exist on type '${node.__typename}'`,
        });
        resolved = null;
      }
      out[key] = applySelections(resolved, field.selections, ctx);
    }
  };
  walk(selections);
  return out;
}

function typeMatches(actual: string, condition: string): boolean {
  if (actual === condition) return true;
  // The Node interface is implemented by the object types clients ask about.
  if (condition === 'Node') return ['Repository', 'Issue', 'PullRequest', 'User', 'IssueComment'].includes(actual);
  return false;
}

export interface GqlOutcome {
  data: unknown;
  errors: { message: string }[];
}

export function executeGraphQL(
  forge: Forge,
  queryText: string,
  variables: Record<string, unknown>,
  operationName: string | null,
): GqlOutcome {
  let document: DocumentNode;
  try {
    document = new Parser(queryText).parseDocument();
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }
  if (document.operations.length === 0) {
    return { data: null, errors: [{ message: 'no operation in document' }] };
  }
  const operation =
    operationName !== null
      ? (document.operations.find((candidate) => candidate.name === operationName) ?? document.operations[0])
      : document.operations[0];
  const ctx: Ctx = { forge, variables, fragments: document.fragments, errors: [] };
  const root: GqlNode =
    operation.type === 'mutation' ? { __typename: 'Mutation' } : { __typename: 'Query' };
  const data = applySelections(root, operation.selections, ctx);
  return { data, errors: ctx.errors };
}

/** Serve one POST /api/graphql body (a single operation or a batch array). */
export function handleGraphQL(forge: Forge, body: unknown, res: ServerResponse): void {
  if (Array.isArray(body)) {
    const results = body.map((entry) => {
      if (!isRecord(entry) || typeof entry.query !== 'string') {
        return { data: null, errors: [{ message: 'invalid operation in batch' }] };
      }
      const outcome = executeGraphQL(
        forge,
        entry.query,
        isRecord(entry.variables) ? entry.variables : {},
        typeof entry.operationName === 'string' ? entry.operationName : null,
      );
      return outcome.errors.length > 0
        ? { data: outcome.data, errors: outcome.errors }
        : { data: outcome.data };
    });
    sendJson(res, 200, results);
    return;
  }
  if (!isRecord(body) || typeof body.query !== 'string') {
    sendJson(res, 200, { data: null, errors: [{ message: 'a GraphQL request needs a query string' }] });
    return;
  }
  const outcome = executeGraphQL(
    forge,
    body.query,
    isRecord(body.variables) ? body.variables : {},
    typeof body.operationName === 'string' ? body.operationName : null,
  );
  if (outcome.errors.length > 0) {
    sendJson(res, 200, { data: outcome.data, errors: outcome.errors });
  } else {
    sendJson(res, 200, { data: outcome.data });
  }
}

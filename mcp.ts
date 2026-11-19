// The Model Context Protocol endpoint at /mcp (JSON-RPC 2.0, streamable
// HTTP). It speaks the 2026-07-28 revision through server/discover and also
// answers the older initialize handshake, and its tools act on the same
// Forge store as REST, so objects keep their ids across surfaces.

import type { ServerResponse } from 'node:http';
import { VIEWER_LOGIN, type Forge } from './store.ts';
import { issueJson, pullJson, repoJson } from './rest.ts';
import { isRecord, sendBuffer } from './http.ts';

const SERVER_INFO = { name: 'forge-mcp', version: '1.0.0' };
const REVISION = '2026-07-28';

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

function objectSchema(
  properties: Record<string, unknown>,
  required: string[],
): Record<string, unknown> {
  return { type: 'object', properties, required };
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: objectSchema(
      {
        name: { type: 'string', description: 'Repository name' },
        description: { type: 'string', description: 'Repository description' },
        private: { type: 'boolean', description: 'Whether the repository is private' },
      },
      ['name'],
    ),
  },
  {
    name: 'get_repo',
    description: 'Read one repository by owner and name.',
    inputSchema: objectSchema(
      {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
      },
      ['owner', 'repo'],
    ),
  },
  {
    name: 'create_issue',
    description: 'Open a new issue in a repository.',
    inputSchema: objectSchema(
      {
        owner: { type: 'string' },
        repo: { type: 'string' },
        title: { type: 'string' },
        body: { type: 'string' },
      },
      ['owner', 'repo', 'title'],
    ),
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository, optionally filtered by state.',
    inputSchema: objectSchema(
      {
        owner: { type: 'string' },
        repo: { type: 'string' },
        state: { type: 'string', enum: ['open', 'closed', 'all'] },
      },
      ['owner', 'repo'],
    ),
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: objectSchema(
      {
        owner: { type: 'string' },
        repo: { type: 'string' },
        title: { type: 'string' },
        body: { type: 'string' },
        head: { type: 'string' },
        base: { type: 'string' },
      },
      ['owner', 'repo', 'title', 'head', 'base'],
    ),
  },
  {
    name: 'merge_pull_request',
    description: 'Merge an open pull request into its base branch.',
    inputSchema: objectSchema(
      {
        owner: { type: 'string' },
        repo: { type: 'string' },
        pull_number: { type: 'number' },
        merge_method: { type: 'string', enum: ['merge', 'squash', 'rebase'] },
      },
      ['owner', 'repo', 'pull_number'],
    ),
  },
];

const TOOLS_BY_NAME = new Map(TOOLS.map((tool) => [tool.name, tool]));

function rpcResult(res: ServerResponse, id: unknown, result: unknown): void {
  const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id, result }), 'utf8');
  sendBuffer(res, 200, body, 'application/json; charset=utf-8');
}

function rpcError(res: ServerResponse, id: unknown, code: number, message: string, status = 200): void {
  const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }), 'utf8');
  sendBuffer(res, status, body, 'application/json; charset=utf-8');
}

function toolSuccess(res: ServerResponse, id: unknown, value: unknown): void {
  rpcResult(res, id, {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value,
    isError: false,
  });
}

function toolFailure(res: ServerResponse, id: unknown, message: string): void {
  rpcResult(res, id, {
    content: [{ type: 'text', text: message }],
    isError: true,
  });
}

function argString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function callTool(forge: Forge, res: ServerResponse, id: unknown, params: Record<string, unknown>): void {
  const name = typeof params.name === 'string' ? params.name : '';
  const tool = TOOLS_BY_NAME.get(name);
  if (tool === undefined) {
    rpcError(res, id, -32602, `unknown tool: ${name}`);
    return;
  }
  const args = isRecord(params.arguments) ? params.arguments : {};
  const required = (tool.inputSchema.required as string[]) ?? [];
  for (const key of required) {
    if (args[key] === undefined || args[key] === null || args[key] === '') {
      rpcError(res, id, -32602, `missing required argument: ${key}`);
      return;
    }
  }
  const owner = argString(args, 'owner') ?? VIEWER_LOGIN;
  const repoName = argString(args, 'repo');
  switch (name) {
    case 'create_repo': {
      const repoNameArg = argString(args, 'name') as string;
      const existing = forge.getRepo(VIEWER_LOGIN, repoNameArg);
      const repo =
        existing ??
        forge.createRepo(repoNameArg, {
          description: argString(args, 'description') ?? '',
          priv: typeof args.private === 'boolean' ? args.private : false,
        });
      if (repo === null) return toolFailure(res, id, 'repository could not be created');
      return toolSuccess(res, id, repoJson(forge, repo));
    }
    case 'get_repo': {
      const repo = repoName === undefined ? null : forge.getRepo(owner, repoName);
      if (repo === null) return toolFailure(res, id, 'repository not found');
      return toolSuccess(res, id, repoJson(forge, repo));
    }
    case 'create_issue': {
      const repo = repoName === undefined ? null : forge.getRepo(owner, repoName);
      if (repo === null) return toolFailure(res, id, 'repository not found');
      const issue = forge.createIssue(repo, argString(args, 'title') as string, argString(args, 'body') ?? '', []);
      return toolSuccess(res, id, issueJson(repo, issue));
    }
    case 'list_issues': {
      const repo = repoName === undefined ? null : forge.getRepo(owner, repoName);
      if (repo === null) return toolFailure(res, id, 'repository not found');
      const state = argString(args, 'state') ?? 'open';
      const issues = [...repo.issues.values()]
        .filter((issue) => state === 'all' || issue.state === state)
        .sort((a, b) => a.number - b.number)
        .map((issue) => issueJson(repo, issue));
      return toolSuccess(res, id, issues);
    }
    case 'create_pull_request': {
      const repo = repoName === undefined ? null : forge.getRepo(owner, repoName);
      if (repo === null) return toolFailure(res, id, 'repository not found');
      const pull = forge.createPull(
        repo,
        argString(args, 'title') as string,
        argString(args, 'body') ?? '',
        argString(args, 'head') as string,
        argString(args, 'base') as string,
      );
      if (pull === null) return toolFailure(res, id, 'head or base branch not found');
      return toolSuccess(res, id, pullJson(forge, repo, pull));
    }
    case 'merge_pull_request': {
      const repo = repoName === undefined ? null : forge.getRepo(owner, repoName);
      if (repo === null) return toolFailure(res, id, 'repository not found');
      const number = typeof args.pull_number === 'number' ? args.pull_number : Number.NaN;
      const pull = repo.pulls.get(number);
      if (pull === undefined) return toolFailure(res, id, 'pull request not found');
      const method = argString(args, 'merge_method') === 'squash' ? 'squash' : 'merge';
      const outcome = forge.mergePull(repo, pull, method);
      if (!outcome.ok) return toolFailure(res, id, `merge failed: ${outcome.reason}`);
      return toolSuccess(res, id, pullJson(forge, repo, pull));
    }
    default:
      rpcError(res, id, -32602, `unknown tool: ${name}`);
  }
}

/** Serve one POST /mcp request body. Auth has already been checked. */
export function handleMcp(forge: Forge, rawBody: Buffer, res: ServerResponse): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.toString('utf8')) as unknown;
  } catch {
    rpcError(res, null, -32700, 'Parse error', 400);
    return;
  }
  if (!isRecord(parsed) || typeof parsed.method !== 'string') {
    rpcError(res, null, -32600, 'Invalid Request', 400);
    return;
  }
  const method = parsed.method;
  const params = isRecord(parsed.params) ? parsed.params : {};
  const hasId = 'id' in parsed;
  const id = hasId ? parsed.id : null;
  if (!hasId) {
    // A notification: accepted, never answered.
    res.writeHead(202);
    res.end();
    return;
  }
  switch (method) {
    case 'server/discover':
      rpcResult(res, id, {
        resultType: 'complete',
        supportedVersions: [REVISION, '2025-11-25'],
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
        _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
      });
      return;
    case 'initialize': {
      const asked = typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-11-25';
      const known = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
      rpcResult(res, id, {
        protocolVersion: known.includes(asked) ? asked : '2025-11-25',
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
      return;
    }
    case 'ping':
      rpcResult(res, id, {});
      return;
    case 'tools/list':
      rpcResult(res, id, { tools: TOOLS });
      return;
    case 'tools/call':
      callTool(forge, res, id, params);
      return;
    default:
      rpcError(res, id, -32601, `method not found: ${method}`);
  }
}

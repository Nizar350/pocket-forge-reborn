// The HTTP server: one listener, four surfaces, a single auth rule.
//
// Routing works on raw path segments rather than a URL object so the hot
// REST paths stay cheap: a handful of prefix checks decide which surface a
// request belongs to, and each surface module takes it from there.
//
// Auth: every surface except /healthz requires
// `Authorization: Bearer <$MAKEFUN_SHOP_TOKEN>`. A request with no bearer
// token at all is always a 401; when the environment named a token, the
// token must match it exactly.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Forge } from './store.ts';
import { handleGit } from './git.ts';
import { handleRest, type RestRequest } from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import {
  parseJsonBody,
  pathSegments,
  readBody,
  sendError,
  sendJson,
  splitTarget,
} from './http.ts';

export function createApp(): Server {
  const forge = new Forge();
  const expectedToken = process.env.MAKEFUN_SHOP_TOKEN ?? '';

  const authed = (req: IncomingMessage): boolean => {
    const header = req.headers.authorization ?? '';
    if (!header.startsWith('Bearer ') || header.length <= 'Bearer '.length) return false;
    if (expectedToken === '') return true;
    return header === `Bearer ${expectedToken}`;
  };

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    route(forge, expectedToken, authed, req, res).catch(() => {
      if (!res.headersSent) sendError(res, 500, 'Internal Server Error');
      else res.end();
    });
  });
  server.keepAliveTimeout = 65000;
  return server;
}

async function route(
  forge: Forge,
  expectedToken: string,
  authed: (req: IncomingMessage) => boolean,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const method = req.method ?? 'GET';
  const { path, query } = splitTarget(req.url ?? '/');

  if (method === 'GET' && path === '/healthz') {
    sendJson(res, 200, { ok: true });
    return;
  }

  const segments = pathSegments(path);

  // MCP: JSON-RPC over one POST route.
  if (path === '/mcp') {
    if (method !== 'POST') {
      sendError(res, 404, 'Not Found');
      return;
    }
    if (!authed(req)) {
      sendError(res, 401, 'Unauthorized');
      return;
    }
    const body = await readBody(req);
    handleMcp(forge, body, res);
    return;
  }

  // GraphQL v4.
  if (path === '/api/graphql') {
    if (method !== 'POST') {
      sendError(res, 404, 'Not Found');
      return;
    }
    if (!authed(req)) {
      sendError(res, 401, 'Unauthorized');
      return;
    }
    const body = await readBody(req);
    const parsed = parseJsonBody(body);
    if (parsed === undefined) {
      sendError(res, 400, 'Malformed JSON body');
      return;
    }
    handleGraphQL(forge, parsed, res);
    return;
  }

  // REST v3.
  if (segments[0] === 'api' && segments[1] === 'v3') {
    if (!authed(req)) {
      sendError(res, 401, 'Unauthorized');
      return;
    }
    let parsed: unknown = null;
    let malformed = false;
    if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
      const body = await readBody(req);
      if (body.length > 0) {
        parsed = parseJsonBody(body);
        if (parsed === undefined) malformed = true;
      }
    }
    const restReq: RestRequest = {
      method,
      segments: segments.slice(2),
      query,
      body: parsed,
      bodyMalformed: malformed,
      host: req.headers.host ?? 'localhost',
    };
    handleRest(forge, restReq, res);
    return;
  }

  // Git smart HTTP: /{owner}/{repo}.git/...
  if (segments.length >= 2 && segments[1].endsWith('.git')) {
    if (!authed(req)) {
      sendError(res, 401, 'Unauthorized');
      return;
    }
    const owner = segments[0];
    const repoName = segments[1].slice(0, -'.git'.length);
    const tail = `/${segments.slice(2).join('/')}`;
    const body = method === 'POST' ? await readBody(req) : Buffer.alloc(0);
    handleGit(forge, req, res, owner, repoName, tail, query, body);
    return;
  }

  sendError(res, 404, 'Not Found');
}

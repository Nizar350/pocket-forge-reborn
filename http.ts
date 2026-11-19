// Small HTTP plumbing shared by every surface: body reading and replies.

import type { IncomingMessage, ServerResponse } from 'node:http';

export const JSON_CONTENT_TYPE = 'application/json; charset=utf-8';

let requestSeq = 0;

/** A fresh, non-empty request id for the X-GitHub-Request-Id header. */
export function nextRequestId(): string {
  requestSeq += 1;
  return `forge-${requestSeq.toString(36)}`;
}

/** Read a whole request body. Bodies in this contest stay well under the cap. */
export function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > 96 * 1024 * 1024) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Answer with a pre-built buffer and an explicit content type. */
export function sendBuffer(
  res: ServerResponse,
  status: number,
  body: Buffer,
  contentType: string,
  extra: Readonly<Record<string, string>> = {},
): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    ...extra,
  });
  res.end(body);
}

/** Answer with a JSON value; REST-style replies also carry a request id. */
export function sendJson(
  res: ServerResponse,
  status: number,
  value: unknown,
  extra: Readonly<Record<string, string>> = {},
): void {
  const body = Buffer.from(`${JSON.stringify(value)}\n`, 'utf8');
  sendBuffer(res, status, body, JSON_CONTENT_TYPE, {
    'x-github-request-id': nextRequestId(),
    ...extra,
  });
}

/** The GitHub-shaped error body: a JSON object with a string message. */
export function sendError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { message });
}

/** Parse a JSON body; null when the bytes are not a JSON value. */
export function parseJsonBody(body: Buffer): unknown {
  if (body.length === 0) return null;
  try {
    return JSON.parse(body.toString('utf8')) as unknown;
  } catch {
    return undefined;
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Split a request target into its path and a flat query map, without URL machinery. */
export function splitTarget(target: string): { path: string; query: Map<string, string> } {
  const q = target.indexOf('?');
  const path = q < 0 ? target : target.slice(0, q);
  const query = new Map<string, string>();
  if (q >= 0) {
    for (const pair of target.slice(q + 1).split('&')) {
      if (pair === '') continue;
      const eq = pair.indexOf('=');
      const key = eq < 0 ? pair : pair.slice(0, eq);
      const value = eq < 0 ? '' : pair.slice(eq + 1);
      try {
        query.set(decodeURIComponent(key.replace(/\+/g, ' ')), decodeURIComponent(value.replace(/\+/g, ' ')));
      } catch {
        query.set(key, value);
      }
    }
  }
  return { path, query };
}

/** Path segments, each percent-decoded; a bad escape keeps its raw text. */
export function pathSegments(path: string): string[] {
  const out: string[] = [];
  for (const raw of path.split('/')) {
    if (raw === '') continue;
    try {
      out.push(decodeURIComponent(raw));
    } catch {
      out.push(raw);
    }
  }
  return out;
}

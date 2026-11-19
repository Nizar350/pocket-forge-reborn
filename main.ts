// Entry lifecycle for the trial harness.
//
// The harness runs an environment service next to this program. The contract
// between the two is small and fixed:
//
//   1. This program builds its HTTP server and binds port 0, so the kernel
//      assigns a free ephemeral port. Port 8080 belongs to the environment
//      and is never ours to take.
//   2. It announces the chosen port with POST {"port": N} to
//      $MAKEFUN_ENV_URL/register. The environment notes the source address
//      of that request and treats http://<address>:<port> as our base URL
//      from then on. The first registration wins; a 409 answer simply means
//      somebody else registered first and is not an error for us.
//   3. It then polls GET $MAKEFUN_ENV_URL/done. The environment answers
//      immediately with {"done": false} while its suite is running and
//      {"done": true} once the results are written out.
//   4. Only when done is true do we close the server and exit 0.
//
// MAKEFUN_ENV_URL missing means there is no environment to talk to, so the
// program refuses to start. Every network step is retried with a capped
// exponential backoff, because the environment may still be booting when we
// first call it, and a poll that fails says nothing about doneness.

import { createApp } from './app.ts';

const envOrigin = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');

if (envOrigin === '') {
  process.stderr.write('MAKEFUN_ENV_URL is not set; nowhere to register\n');
  process.exit(1);
}

const TIMEOUT_MS = 30000;
const FIRST_BACKOFF_MS = 250;
const LAST_BACKOFF_MS = 2000;

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function backoffFor(attempt: number): number {
  const grown = FIRST_BACKOFF_MS * 2 ** Math.min(attempt, 8);
  return Math.min(LAST_BACKOFF_MS, grown);
}

async function announce(port: number): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    let fatal: Error | null = null;
    try {
      const res = await fetch(`${envOrigin}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (res.status === 200 || res.status === 409) return;
      if (res.status === 400 || res.status === 405) {
        fatal = new Error(`register refused with HTTP ${res.status}: ${await res.text()}`);
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('register refused')) fatal = err;
    }
    if (fatal !== null) throw fatal;
    await pause(backoffFor(attempt));
  }
}

async function untilDone(): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const res = await fetch(`${envOrigin}/done`, {
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (res.ok) {
        const body = (await res.json()) as { done?: unknown };
        if (body.done === true) return;
      }
    } catch {
      // A silent or slow environment is a busy one, not a finished one.
    }
    await pause(backoffFor(attempt));
  }
}

async function run(): Promise<void> {
  const server = createApp();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('server did not bind a TCP port');
  }
  process.stdout.write(`forge listening on ${address.port}\n`);
  await announce(address.port);
  process.stdout.write('registered with the environment; serving until done\n');
  await untilDone();
  server.close();
  process.stdout.write('environment reports done; exiting\n');
}

try {
  await run();
  process.exit(0);
} catch (err) {
  process.stderr.write(`fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}

// Entry lifecycle for agent-fun/v1: bind an ephemeral port, announce it to the env, then wait
// for the env's done flag and exit 0. The forge itself lives in app.ts.
import { createApp } from './app.ts';

const ENV_ORIGIN = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
if (!ENV_ORIGIN) {
  process.stderr.write('MAKEFUN_ENV_URL missing; no env to announce to\n');
  process.exit(1);
}

const REQUEST_TIMEOUT_MS = 30_000;
const MIN_WAIT_MS = 200;
const MAX_WAIT_MS = 2_000;

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function backoff(tries: number): number {
  return Math.min(MAX_WAIT_MS, MIN_WAIT_MS * 2 ** Math.min(tries, 8));
}

async function announce(port: number): Promise<void> {
  for (let tries = 0; ; tries += 1) {
    try {
      const reply = await fetch(ENV_ORIGIN + '/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (reply.status === 200 || reply.status === 409) return;
      if (reply.status === 400 || reply.status === 405) {
        throw new Error('register refused: HTTP ' + reply.status + ' ' + (await reply.text()));
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('register refused')) throw error;
    }
    await pause(backoff(tries));
  }
}

async function pollUntilDone(): Promise<void> {
  for (let tries = 0; ; tries += 1) {
    try {
      const reply = await fetch(ENV_ORIGIN + '/done', { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (reply.ok) {
        const payload = (await reply.json()) as { done?: unknown };
        if (payload.done === true) return;
      }
    } catch {
      // env not answering yet: keep polling
    }
    await pause(backoff(tries));
  }
}

async function run(): Promise<void> {
  const server = createApp();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, resolve);
  });
  const bound = server.address();
  if (bound === null || typeof bound === 'string') throw new Error('no ephemeral TCP port bound');
  process.stdout.write('[forge] listening on port ' + bound.port + '\n');
  await announce(bound.port);
  await pollUntilDone();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

try {
  await run();
  process.exit(0);
} catch (error) {
  process.stderr.write((error instanceof Error ? error.message : String(error)) + '\n');
  process.exit(1);
}

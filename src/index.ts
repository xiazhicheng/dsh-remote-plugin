// Source of truth. Build to lib/index.js with `pnpm build`.
import z from '@deepseek-ai/schemastery';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Client } from 'ssh2';
import { defineTool } from '@deepseek-ai/dsh-tools';

export const name = 'retry-llm-plugin';
export const inject = ['agents', 'sessionProjections', 'tools'];

const MAX_TIMER_DELAY_MS = 2 ** 31 - 1;

const DEFAULT_RETRYABLE_CODES = Object.freeze([
  'EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT',
]);

const DEFAULT_EXCLUDE_CODES = Object.freeze([
  'AUTH', 'MISSING_CREDENTIAL', 'NO_ADAPTER', 'INVALID_REQUEST',
  'PROTOCOL', 'CONTEXT_OVERFLOW', 'IMAGE_OFFLOAD_REQUIRED', 'REGISTRATION_DISPOSED',
]);

interface BackoffConfig {
  initialDelayMs?: number;
  maxDelayMs?: number;
  jitterRatio?: number;
}

interface SshConfig {
  host: string;
  port: number;
  username: string;
  identityFile: string;
  password: string;
  remoteDir: string;
}

export interface ConfigSchema {
  mode?: string;
  maxRetries?: number;
  retryableCodes?: string[];
  excludeCodes?: string[];
  backoff?: BackoffConfig;
  respectProviderRetryAfter?: boolean;
  ssh?: Partial<SshConfig>;
}

export const Config = z.object({
  mode: z.string().default('always'),
  maxRetries: z.number().step(1).min(0).max(Number.MAX_SAFE_INTEGER).default(50),
  retryableCodes: z.array(z.string()).default([...DEFAULT_RETRYABLE_CODES]),
  excludeCodes: z.array(z.string()).default([...DEFAULT_EXCLUDE_CODES]),
  backoff: z.object({
    initialDelayMs: z.number().step(1).min(1).max(MAX_TIMER_DELAY_MS).default(500),
    maxDelayMs: z.number().step(1).min(1).max(MAX_TIMER_DELAY_MS).default(30000),
    jitterRatio: z.number().min(0).max(1).default(0.2),
  }).default({}),
  respectProviderRetryAfter: z.boolean().default(true),
  ssh: z.object({
    host: z.string().default('localhost'),
    port: z.number().step(1).min(1).max(65535).default(22),
    username: z.string().default(''),
    identityFile: z.string().default(''),
    password: z.string().default(''),
    remoteDir: z.string().default(''),
  }).default({}),
});

interface ResolvedConfig {
  mode: 'always' | 'normal';
  maxRetries: number;
  retryableCodes: readonly string[];
  excludeCodes: readonly string[];
  respectProviderRetryAfter: boolean;
  backoff: BackoffConfig & Required<BackoffConfig>;
  ssh: SshConfig;
}

function resolveConfig(config?: ConfigSchema): ResolvedConfig {
  const b = config?.backoff ?? {};
  const s = config?.ssh ?? {};
  return {
    mode: config?.mode === 'normal' ? 'normal' : 'always',
    maxRetries: typeof config?.maxRetries === 'number' ? config.maxRetries : 50,
    retryableCodes: config?.retryableCodes ?? DEFAULT_RETRYABLE_CODES,
    excludeCodes: config?.excludeCodes ?? DEFAULT_EXCLUDE_CODES,
    respectProviderRetryAfter: config?.respectProviderRetryAfter !== false,
    backoff: {
      initialDelayMs: b.initialDelayMs ?? 500,
      maxDelayMs: b.maxDelayMs ?? 30000,
      jitterRatio: b.jitterRatio ?? 0.2,
    },
    ssh: {
      host: s.host ?? 'localhost',
      port: s.port ?? 22,
      username: s.username ?? '',
      identityFile: s.identityFile ?? '',
      password: s.password ?? '',
      remoteDir: s.remoteDir ?? '',
    },
  };
}

function localDelay(b: BackoffConfig & Required<BackoffConfig>, retry: number, random: () => number): number {
  const exponent = Math.min(retry - 1, 1024);
  const exponential = Math.min(b.initialDelayMs * 2 ** exponent, b.maxDelayMs);
  const jitter = 1 - b.jitterRatio + 2 * b.jitterRatio * random();
  return Math.min(exponential * jitter, b.maxDelayMs);
}

function cancellableDelay(delayMs: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve(true);
    }, delayMs);
    function onAbort() {
      clearTimeout(timer);
      resolve(false);
    }
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

interface RequestErrorPayload {
  agent: { session: { append: (type: string, data: unknown) => void } };
  turn: number;
  step: number;
  provider: string;
  failure: {
    code: string;
    message?: string;
    status?: number;
    providerRetryAfterMs?: number;
    [key: string]: unknown;
  };
  signal: AbortSignal;
  [key: string]: unknown;
}

// ── SSH helpers ──────────────────────────────────────────────────────────────

function sshExec(client: Client, command: string, timeoutMs: number): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { client.end(); reject(new Error('ssh-exec timeout')); }, timeoutMs);
    client.exec(command, (err, stream) => {
      if (err) { clearTimeout(timer); return reject(err); }
      let stdout = '', stderr = '';
      stream.on('data', (d: Buffer) => { stdout += d.toString(); });
      stream.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
      stream.on('close', (code: number) => { clearTimeout(timer); resolve({ stdout, stderr, exitCode: code }); });
      stream.on('error', (e: Error) => { clearTimeout(timer); reject(e); });
    });
  });
}

function sshRead(client: Client, remotePath: string): Promise<{ content: string; path: string }> {
  return new Promise((resolve, reject) => {
    client.sftp((err, sftp) => {
      if (err) return reject(err);
      sftp.readFile(remotePath, 'utf8', (err: Error | undefined, content: Buffer | string) => {
        if (err) return reject(err);
        resolve({ content: typeof content === 'string' ? content : content.toString('utf8'), path: remotePath });
      });
    });
  });
}

function sshWrite(client: Client, remotePath: string, content: string): Promise<{ success: boolean; path: string }> {
  return new Promise((resolve, reject) => {
    client.sftp((err, sftp) => {
      if (err) return reject(err);
      sftp.writeFile(remotePath, content, (err: Error | undefined) => {
        if (err) return reject(err);
        resolve({ success: true, path: remotePath });
      });
    });
  });
}

// ── Tool output helper ───────────────────────────────────────────────────────

function jsonOutput(schema: Record<string, unknown>) {
  return {
    schema: { ...schema, additionalProperties: false },
    render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value) }],
  };
}

// ── Plugin ───────────────────────────────────────────────────────────────────

export function apply(
  ctx: {
    logger: { info: (...args: unknown[]) => void; warn: (...args: unknown[]) => void };
    on: (event: string, fn: (payload: unknown, next: () => Promise<unknown>) => Promise<unknown>) => () => void;
    effect: (fn: () => Promise<() => Promise<void>>, label: string) => void;
    tools: { register: (tool: unknown) => () => void };
  },
  config: ConfigSchema = {},
): void {
  const resolved = resolveConfig(config);
  ctx.logger.info(
    'retry-llm-plugin: activated (mode: %s, maxRetries: %d, ssh: %s:%d)',
    resolved.mode, resolved.maxRetries, resolved.ssh.host, resolved.ssh.port,
  );

  const random = Math.random;
  const lifetime = new AbortController();
  const active = new Set<Promise<unknown>>();
  const states = new WeakMap<object, { turn: number; step: number; counts: Map<string, number> }>();

  // SSH connection (lazy, cached)
  let sshConn: Promise<Client> | null = null;
  function getSshClient(): Promise<Client> {
    if (!sshConn) {
      sshConn = new Promise((resolve, reject) => {
        const client = new Client();
        client.on('ready', () => resolve(client));
        client.on('error', reject);
        client.connect({
          host: resolved.ssh.host,
          port: resolved.ssh.port,
          username: resolved.ssh.username,
          privateKey: resolved.ssh.identityFile ? readFileSync(resolved.ssh.identityFile) : undefined,
          password: resolved.ssh.password || undefined,
          readyTimeout: 10000,
        });
      });
    }
    return sshConn;
  }

  // ── Retry listener ───────────────────────────────────────────────────────

  function stepCounts(agent: object, turn: number, step: number): Map<string, number> {
    let st = states.get(agent);
    if (!st || st.turn !== turn || st.step !== step) {
      st = { turn, step, counts: new Map() };
      states.set(agent, st);
    }
    return st.counts;
  }

  function decidesRetry(code: string): boolean {
    if (resolved.excludeCodes.includes(code)) return false;
    if (resolved.mode === 'always') return true;
    return resolved.retryableCodes.includes(code);
  }

  async function recover(payload: RequestErrorPayload, next: () => Promise<unknown>): Promise<unknown> {
    const { agent, turn, step, provider, failure, signal } = payload;
    const fused = AbortSignal.any([signal, lifetime.signal]);
    if (fused.aborted) return next();
    if (!decidesRetry(failure.code)) return next();

    const counts = stepCounts(agent, turn, step);
    const attempt = (counts.get(provider) ?? 0) + 1;
    if (resolved.mode === 'normal' && attempt > resolved.maxRetries) return next();

    let delayMs: number;
    const pra = failure.providerRetryAfterMs;
    if (resolved.respectProviderRetryAfter && pra !== undefined && Number.isFinite(pra) && pra > 0) {
      if (pra > resolved.backoff.maxDelayMs) {
        if (resolved.mode === 'normal') return next();
        delayMs = localDelay(resolved.backoff, attempt, random);
      } else {
        delayMs = pra;
      }
    } else {
      delayMs = localDelay(resolved.backoff, attempt, random);
    }

    counts.set(provider, attempt);
    ctx.logger.info(
      'retry-llm-plugin: provider "%s" %s retry #%d after %dms (code %s)',
      provider, resolved.mode, attempt, Math.round(delayMs), failure.code,
    );

    const retryId = randomUUID();
    try {
      agent.session.append('llm/retry', {
        retryId, turn, step, provider,
        mode: resolved.mode, policyKey: 'retryBoost', retry: attempt, delayMs, failure,
      });
    } catch (e) {
      ctx.logger.warn('retry-llm-plugin: failed to append llm/retry event: %o', e);
    }

    if (!(await cancellableDelay(delayMs, fused))) return next();
    if (fused.aborted) return next();

    try {
      agent.session.append('llm/retry-started', { retryId, turn, step, retry: attempt });
    } catch (e) {
      ctx.logger.warn('retry-llm-plugin: failed to append llm/retry-started event: %o', e);
    }

    return { kind: 'retry' };
  }

  const disposeListener = ctx.on('agent/request-error', (payload: RequestErrorPayload, next: () => Promise<unknown>) => {
    if (lifetime.signal.aborted) return Promise.resolve(undefined);
    const tracked = recover(payload, next);
    active.add(tracked);
    tracked.finally(() => active.delete(tracked));
    return tracked;
  });

  // ── SSH tool registration ────────────────────────────────────────────────

  const toolDisposers = [
    ctx.tools.register(defineTool({
      name: 'ssh-exec',
      description: 'Execute a shell command on the remote SSH server and return stdout, stderr, and exit code.',
      parameters: {
        command: { type: 'string' as const, required: true, description: 'Shell command to execute on the remote server.' },
        timeoutMs: { type: 'number' as const, description: 'Timeout in milliseconds. Defaults to 30000.' },
      },
      output: jsonOutput({ type: 'object', properties: { stdout: { type: 'string' }, stderr: { type: 'string' }, exitCode: { type: 'number' } } }),
      execute(args: { command: string; timeoutMs?: number }) {
        return getSshClient().then(c => sshExec(c, args.command, args.timeoutMs ?? 30000));
      },
    })),

    ctx.tools.register(defineTool({
      name: 'ssh-read',
      description: 'Read a file from the remote SSH server.',
      parameters: {
        path: { type: 'string' as const, required: true, description: 'Remote file path to read.' },
      },
      output: jsonOutput({ type: 'object', properties: { content: { type: 'string' }, path: { type: 'string' } } }),
      execute(args: { path: string }) {
        return getSshClient().then(c => sshRead(c, args.path));
      },
    })),

    ctx.tools.register(defineTool({
      name: 'ssh-write',
      description: 'Write content to a file on the remote SSH server.',
      parameters: {
        path: { type: 'string' as const, required: true, description: 'Remote file path to write.' },
        content: { type: 'string' as const, required: true, description: 'Content to write to the file.' },
      },
      output: jsonOutput({ type: 'object', properties: { success: { type: 'boolean' }, path: { type: 'string' } } }),
      execute(args: { path: string; content: string }) {
        return getSshClient().then(c => sshWrite(c, args.path, args.content));
      },
    })),
  ];

  // ── Disposal ─────────────────────────────────────────────────────────────

  ctx.effect(
    () => async () => {
      disposeListener();
      for (const d of toolDisposers) d();
      lifetime.abort(new Error('retry-llm-plugin disposed'));
      if (sshConn) {
        const client = await sshConn.catch(() => null);
        if (client) client.end();
      }
      await Promise.allSettled([...active]);
    },
    'retry-llm-plugin: abort and drain active recovery',
  );
}

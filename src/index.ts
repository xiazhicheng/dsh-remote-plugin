// Source of truth. Build to lib/index.js with `pnpm build`.
import z from '@deepseek-ai/schemastery';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

export const name = 'retry-llm-plugin';
export const inject = ['agents'];

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

// ── Lazy native/heavy imports ────────────────────────────────────────────────
// ssh2 (native binding) and @deepseek-ai/dsh-tools are loaded on demand so a
// resolution or load failure never blocks plugin activation or DSH startup:
// the retry feature keeps working, SSH tools just report unavailable.

let ssh2ClientCtor: (new (...args: unknown[]) => { on: (...a: unknown[]) => unknown }) | null = null;
let ssh2Failed = false;

async function loadSsh2Client(): Promise<{ on: (...a: unknown[]) => unknown } | null> {
  if (ssh2ClientCtor) return new ssh2ClientCtor();
  if (ssh2Failed) return null;
  try {
    const mod = await import('ssh2');
    ssh2ClientCtor = mod.Client;
    return new ssh2ClientCtor();
  } catch {
    ssh2Failed = true;
    return null;
  }
}

type DefineToolFn = (options: Record<string, unknown>) => { name: string; description: string; parameters: unknown; output: unknown; execute(args: unknown, exec: unknown): Promise<unknown> };
let defineToolFn: DefineToolFn | null = null;
let toolsFailed = false;

async function loadDefineTool(): Promise<DefineToolFn | null> {
  if (defineToolFn) return defineToolFn;
  if (toolsFailed) return null;
  try {
    const mod = await import('@deepseek-ai/dsh-tools');
    defineToolFn = mod.defineTool as DefineToolFn;
    return defineToolFn;
  } catch {
    toolsFailed = true;
    return null;
  }
}

// ── SSH helpers (receive an already-connected client) ───────────────────────

function sshExec(client: { exec: (cmd: string, cb: (err: Error | undefined, stream: { on: (e: string, cb: (d: { toString(): string }) => void) => void; stderr: { on: (e: string, cb: (d: { toString(): string }) => void) => void } }) => void) => void; end: () => void }, command: string, timeoutMs: number): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { client.end(); reject(new Error('ssh-exec timeout')); }, timeoutMs);
    client.exec(command, (err, stream) => {
      if (err) { clearTimeout(timer); return reject(err); }
      let stdout = '', stderr = '';
      stream.on('data', (d) => { stdout += d.toString(); });
      stream.stderr.on('data', (d) => { stderr += d.toString(); });
      // ssh2 streams close with an exit-code 'close' event carrying the code
      (stream as unknown as { on: (e: string, cb: (code: number) => void) => void }).on('close', (code) => { clearTimeout(timer); resolve({ stdout, stderr, exitCode: code }); });
      (stream as unknown as { on: (e: string, cb: (e: Error) => void) => void }).on('error', (e) => { clearTimeout(timer); reject(e); });
    });
  });
}

function sshRead(client: { sftp: (cb: (err: Error | undefined, sftp: { readFile: (p: string, enc: string, cb: (err: Error | undefined, content: Buffer | string) => void) => void }) => void) => void }, remotePath: string): Promise<{ content: string; path: string }> {
  return new Promise((resolve, reject) => {
    client.sftp((err, sftp) => {
      if (err) return reject(err);
      sftp.readFile(remotePath, 'utf8', (err, content) => {
        if (err) return reject(err);
        resolve({ content: typeof content === 'string' ? content : content.toString('utf8'), path: remotePath });
      });
    });
  });
}

function sshWrite(client: { sftp: (cb: (err: Error | undefined, sftp: { writeFile: (p: string, content: string, cb: (err: Error | undefined) => void) => void }) => void) => void }, remotePath: string, content: string): Promise<{ success: boolean; path: string }> {
  return new Promise((resolve, reject) => {
    client.sftp((err, sftp) => {
      if (err) return reject(err);
      sftp.writeFile(remotePath, content, (err) => {
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
    on: (event: string, fn: (payload: never, next: (() => Promise<unknown>) | undefined) => unknown) => () => void;
    effect: (fn: () => () => void | Promise<void>) => void;
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
  let sshConn: Promise<unknown> | null = null;
  function getSshClient(): Promise<unknown> {
    if (!sshConn) {
      sshConn = (async () => {
        const client = await loadSsh2Client();
        if (!client) throw new Error('ssh2 is not available');
        return client;
      })();
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

  // ── SSH tool registration (per-agent, lazy) ──────────────────────────────

  const agentToolDisposers = new Map<object, Array<() => void>>();

  async function registerSshTools(agent: {
    ctx: { tools: { register: (tool: unknown) => () => void } };
  }): Promise<void> {
    const defineTool = await loadDefineTool();
    if (!defineTool) {
      ctx.logger.warn('retry-llm-plugin: @deepseek-ai/dsh-tools unavailable, SSH tools disabled');
      return;
    }
    const disposers: Array<() => void> = [];
    try {
      disposers.push(agent.ctx.tools.register(defineTool({
        name: 'ssh-exec',
        description: 'Execute a shell command on the remote SSH server and return stdout, stderr, and exit code.',
        parameters: {
          command: { type: 'string', required: true, description: 'Shell command to execute on the remote server.' },
          timeoutMs: { type: 'number', description: 'Timeout in milliseconds. Defaults to 30000.' },
        },
        output: jsonOutput({ type: 'object', properties: { stdout: { type: 'string' }, stderr: { type: 'string' }, exitCode: { type: 'number' } } }),
        execute: (args: { command: string; timeoutMs?: number }) =>
          getSshClient().then((c) => sshExec(c as never, args.command, args.timeoutMs ?? 30000)),
      })));

      disposers.push(agent.ctx.tools.register(defineTool({
        name: 'ssh-read',
        description: 'Read a file from the remote SSH server.',
        parameters: {
          path: { type: 'string', required: true, description: 'Remote file path to read.' },
        },
        output: jsonOutput({ type: 'object', properties: { content: { type: 'string' }, path: { type: 'string' } } }),
        execute: (args: { path: string }) =>
          getSshClient().then((c) => sshRead(c as never, args.path)),
      })));

      disposers.push(agent.ctx.tools.register(defineTool({
        name: 'ssh-write',
        description: 'Write content to a file on the remote SSH server.',
        parameters: {
          path: { type: 'string', required: true, description: 'Remote file path to write.' },
          content: { type: 'string', required: true, description: 'Content to write to the file.' },
        },
        output: jsonOutput({ type: 'object', properties: { success: { type: 'boolean' }, path: { type: 'string' } } }),
        execute: (args: { path: string; content: string }) =>
          getSshClient().then((c) => sshWrite(c as never, args.path, args.content)),
      })));
    } catch (e) {
      ctx.logger.warn('retry-llm-plugin: failed to register SSH tools for agent: %s', e instanceof Error ? e.message : String(e));
      for (const d of disposers) d();
      return;
    }
    agentToolDisposers.set(agent, disposers);
  }

  const disposeAgentListener = ctx.on('agent/created', (payload: never) => {
    const agent = (payload as { agent?: { ctx: { tools: { register: (tool: unknown) => () => void } } } }).agent;
    if (agent) void registerSshTools(agent);
  });

  const disposeAgentDisposeListener = ctx.on('agent/disposed', (payload: never) => {
    const agent = (payload as { agent?: object }).agent;
    if (!agent) return;
    const disposers = agentToolDisposers.get(agent);
    if (disposers) {
      for (const d of disposers) d();
      agentToolDisposers.delete(agent);
    }
  });

  // ── Disposal ─────────────────────────────────────────────────────────────

  ctx.effect(() => async () => {
    disposeListener();
    disposeAgentListener();
    disposeAgentDisposeListener();
    for (const disposers of agentToolDisposers.values()) {
      for (const d of disposers) d();
    }
    agentToolDisposers.clear();
    lifetime.abort(new Error('retry-llm-plugin disposed'));
    if (sshConn) {
      const client = await sshConn.catch(() => null);
      if (client && typeof (client as { end?: () => void }).end === 'function') {
        (client as { end: () => void }).end();
      }
    }
    await Promise.allSettled([...active]);
  });
}

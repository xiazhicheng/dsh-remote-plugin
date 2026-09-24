/**
 * dsh-llm-retry-boost — boost model-request retries on the agent loop's
 * `agent/request-error` waterfall.
 *
 * Mount this bundle when your LLM endpoint is unstable or rate-limited and the
 * default normal-mode retry budget (5) ends turns too eagerly. It installs an
 * additional recovery listener that retries failed model requests either a
 * configurable finite number of times (`normal`, default 50) or without an
 * attempt limit (`always`, the default), stopping only on success, turn
 * cancellation, or plugin disposal.
 *
 * It cooperates with the built-in `@deepseek-ai/dsh-llm-retry`: both listen on
 * the same waterfall, and whichever owns a given retry returns `{ kind: 'retry' }`.
 * This plugin keeps its own per-step retry count in memory and never registers
 * a duplicate session projection, so it is safe to mount alongside it.
 *
 * @module dsh-llm-retry-boost
 */
import z from '@deepseek-ai/schemastery';
import type { Context } from '@deepseek-ai/cordis';
import type { LlmFailure } from '@deepseek-ai/dsh-llm';
import type { Agent } from '@deepseek-ai/dsh-agent';

export const name = 'llm-retry-boost';
export const inject = ['agents'];

/** Largest delay a single `setTimeout` can accept (2^31 - 1 ms). */
const MAX_TIMER_DELAY_MS = 2 ** 31 - 1;

/** Transient failure codes retried by DSH's normal-mode default policy. */
const DEFAULT_RETRYABLE_CODES = Object.freeze([
  'EMPTY_RESPONSE',
  'RATE_LIMIT',
  'SERVER',
  'TIMEOUT',
  'TRANSPORT',
]);

/**
 * Failure codes that never succeed on a plain retry, or are owned by other
 * recovery policies (context overflow, image offload). Excluded even in
 * `always` mode so the plugin does not hammer a fundamentally broken route.
 */
const DEFAULT_EXCLUDE_CODES = Object.freeze([
  'AUTH',
  'MISSING_CREDENTIAL',
  'NO_ADAPTER',
  'INVALID_REQUEST',
  'PROTOCOL',
  'CONTEXT_OVERFLOW',
  'IMAGE_OFFLOAD_REQUIRED',
  'REGISTRATION_DISPOSED',
]);

/** Bounded exponential backoff with symmetric jitter around each local delay. */
export interface BackoffConfig {
  /** Initial local delay in milliseconds (default 500). */
  initialDelayMs?: number;
  /** Maximum locally scheduled or accepted delay in milliseconds (default 30000). */
  maxDelayMs?: number;
  /** Symmetric random multiplier range around one (default 0.2). */
  jitterRatio?: number;
}

/** Plugin configuration. */
export interface RetryBoostConfig {
  /** `always` retries every eligible failure without a limit; `normal` honors `maxRetries`. Default `always`. */
  mode?: 'always' | 'normal';
  /** Maximum eligible retries after the first request in `normal` mode (default 50). */
  maxRetries?: number;
  /** Stable failure codes eligible for retry in `normal` mode (default transient set). */
  retryableCodes?: string[];
  /** Codes never retried, even in `always` mode (default permanent / owned-elsewhere set). */
  excludeCodes?: string[];
  /** Local exponential-backoff and jitter configuration. */
  backoff?: BackoffConfig;
  /** Honor a valid provider `Retry-After` when it fits `maxDelayMs` (default true). */
  respectProviderRetryAfter?: boolean;
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
});

/** A recovery decision returned from the `agent/request-error` waterfall. */
type RequestErrorAction = { kind: 'retry' } | undefined;

/** Payload of the `agent/request-error` waterfall (the fields this plugin uses). */
interface RequestErrorPayload {
  agent: Agent;
  turn: number;
  step: number;
  provider: string;
  failure: LlmFailure;
  signal: AbortSignal;
}

interface ResolvedBackoff {
  readonly initialDelayMs: number;
  readonly maxDelayMs: number;
  readonly jitterRatio: number;
}

interface ResolvedBoostConfig {
  readonly mode: 'always' | 'normal';
  readonly maxRetries: number;
  readonly retryableCodes: readonly string[];
  readonly excludeCodes: readonly string[];
  readonly backoff: ResolvedBackoff;
  readonly respectProviderRetryAfter: boolean;
}

function resolveConfig(config: RetryBoostConfig): ResolvedBoostConfig {
  const b = config.backoff ?? {};
  return {
    mode: config.mode === 'normal' ? 'normal' : 'always',
    maxRetries: typeof config.maxRetries === 'number' ? config.maxRetries : 50,
    retryableCodes: config.retryableCodes ?? DEFAULT_RETRYABLE_CODES,
    excludeCodes: config.excludeCodes ?? DEFAULT_EXCLUDE_CODES,
    respectProviderRetryAfter: config.respectProviderRetryAfter !== false,
    backoff: {
      initialDelayMs: b.initialDelayMs ?? 500,
      maxDelayMs: b.maxDelayMs ?? 30000,
      jitterRatio: b.jitterRatio ?? 0.2,
    },
  };
}

/** Bounded exponential backoff with symmetric jitter, matching the built-in policy. */
function localDelay(b: ResolvedBackoff, retry: number, random: () => number): number {
  const exponent = Math.min(retry - 1, 1024);
  const exponential = Math.min(b.initialDelayMs * 2 ** exponent, b.maxDelayMs);
  const jitter = 1 - b.jitterRatio + 2 * b.jitterRatio * random();
  return Math.min(exponential * jitter, b.maxDelayMs);
}

/** Wait `delayMs`, resolving `true` unless `signal` aborted first. */
function cancellableDelay(delayMs: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise<boolean>((resolve) => {
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

/** In-memory per-step retry counter, keyed by agent object identity. */
interface StepState {
  turn: number;
  step: number;
  counts: Map<string, number>;
}

/**
 * Install the boost recovery listener.
 *
 * @param ctx - plugin context that owns the listener and active waits.
 * @param config - resolved by {@link Config}; omission selects `always` mode.
 */
export function apply(ctx: Context, config: RetryBoostConfig = {}): void {
  const resolved = resolveConfig(config);
  const random = Math.random;
  const lifetime = new AbortController();
  const active = new Set<Promise<RequestErrorAction>>();
  const states = new WeakMap<Agent, StepState>();

  function stepCounts(agent: Agent, turn: number, step: number): Map<string, number> {
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

  async function recover(
    payload: RequestErrorPayload,
    next: () => Promise<RequestErrorAction>,
  ): Promise<RequestErrorAction> {
    const { agent, turn, step, provider, failure, signal } = payload;
    const fused = AbortSignal.any([signal, lifetime.signal]);
    if (fused.aborted) return next();

    if (!decidesRetry(failure.code)) return next();

    const counts = stepCounts(agent, turn, step);
    const attempt = (counts.get(provider) ?? 0) + 1;
    if (resolved.mode === 'normal' && attempt > resolved.maxRetries) return next();

    let delayMs: number;
    const pra = failure.providerRetryAfterMs;
    if (
      resolved.respectProviderRetryAfter &&
      pra !== undefined &&
      Number.isFinite(pra) &&
      pra > 0
    ) {
      if (pra > resolved.backoff.maxDelayMs) {
        // Provider wants to wait longer than we allow. In normal mode defer;
        // in always mode fall back to local backoff so the policy never
        // terminates on a provider delay instruction.
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
      'llm-retry-boost: provider "%s" %s retry #%d after %dms (code %s)',
      provider,
      resolved.mode,
      attempt,
      Math.round(delayMs),
      failure.code,
    );

    if (!(await cancellableDelay(delayMs, fused))) return next();
    if (fused.aborted) return next();
    return { kind: 'retry' };
  }

  const disposeListener = ctx.on(
    'agent/request-error',
    (payload: RequestErrorPayload, next: () => Promise<RequestErrorAction>) => {
      if (lifetime.signal.aborted) return Promise.resolve(undefined);
      const tracked = recover(payload, next);
      active.add(tracked);
      tracked.finally(() => active.delete(tracked));
      return tracked;
    },
  );

  ctx.effect(
    () => async () => {
      disposeListener();
      lifetime.abort(new Error('llm-retry-boost disposed'));
      await Promise.allSettled([...active]);
    },
    'llm-retry-boost: abort and drain active recovery',
  );
}

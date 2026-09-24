// Committed build output of src/index.ts (types erased). Regenerate with `pnpm build`.
import z from '@deepseek-ai/schemastery';

export const name = 'llm-retry-boost';
export const inject = ['agents'];

const MAX_TIMER_DELAY_MS = 2 ** 31 - 1;

const DEFAULT_RETRYABLE_CODES = Object.freeze([
  'EMPTY_RESPONSE',
  'RATE_LIMIT',
  'SERVER',
  'TIMEOUT',
  'TRANSPORT',
]);

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

function resolveConfig(config) {
  const b = config?.backoff ?? {};
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
  };
}

function localDelay(b, retry, random) {
  const exponent = Math.min(retry - 1, 1024);
  const exponential = Math.min(b.initialDelayMs * 2 ** exponent, b.maxDelayMs);
  const jitter = 1 - b.jitterRatio + 2 * b.jitterRatio * random();
  return Math.min(exponential * jitter, b.maxDelayMs);
}

function cancellableDelay(delayMs, signal) {
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

export function apply(ctx, config = {}) {
  const resolved = resolveConfig(config);
  const random = Math.random;
  const lifetime = new AbortController();
  const active = new Set();
  const states = new WeakMap();

  function stepCounts(agent, turn, step) {
    let st = states.get(agent);
    if (!st || st.turn !== turn || st.step !== step) {
      st = { turn, step, counts: new Map() };
      states.set(agent, st);
    }
    return st.counts;
  }

  function decidesRetry(code) {
    if (resolved.excludeCodes.includes(code)) return false;
    if (resolved.mode === 'always') return true;
    return resolved.retryableCodes.includes(code);
  }

  async function recover(payload, next) {
    const { agent, turn, step, provider, failure, signal } = payload;
    const fused = AbortSignal.any([signal, lifetime.signal]);
    if (fused.aborted) return next();

    if (!decidesRetry(failure.code)) return next();

    const counts = stepCounts(agent, turn, step);
    const attempt = (counts.get(provider) ?? 0) + 1;
    if (resolved.mode === 'normal' && attempt > resolved.maxRetries) return next();

    let delayMs;
    const pra = failure.providerRetryAfterMs;
    if (
      resolved.respectProviderRetryAfter &&
      pra !== undefined &&
      Number.isFinite(pra) &&
      pra > 0
    ) {
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

  const disposeListener = ctx.on('agent/request-error', (payload, next) => {
    if (lifetime.signal.aborted) return Promise.resolve(undefined);
    const tracked = recover(payload, next);
    active.add(tracked);
    tracked.finally(() => active.delete(tracked));
    return tracked;
  });

  ctx.effect(
    () => async () => {
      disposeListener();
      lifetime.abort(new Error('llm-retry-boost disposed'));
      await Promise.allSettled([...active]);
    },
    'llm-retry-boost: abort and drain active recovery',
  );
}

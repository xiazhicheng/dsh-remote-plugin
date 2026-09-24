/// <reference types="node" />
import z from '@deepseek-ai/schemastery';
import type { Context } from '@deepseek-ai/cordis';
import type { LlmFailure } from '@deepseek-ai/dsh-llm';
import type { Agent } from '@deepseek-ai/dsh-agent';

export declare const name = 'retry-llm-plugin';
export declare const inject = ['agents'];

/** Bounded exponential backoff with symmetric jitter around each local delay. */
export interface BackoffConfig {
  initialDelayMs?: number;
  maxDelayMs?: number;
  jitterRatio?: number;
}

/** Plugin configuration. */
export interface RetryBoostConfig {
  mode?: 'always' | 'normal';
  maxRetries?: number;
  retryableCodes?: string[];
  excludeCodes?: string[];
  backoff?: BackoffConfig;
  respectProviderRetryAfter?: boolean;
}

export declare const Config: z<RetryBoostConfig>;

/** A recovery decision returned from the `agent/request-error` waterfall. */
export type RequestErrorAction = { kind: 'retry' } | undefined;

/**
 * Install the boost recovery listener.
 * @param ctx - plugin context that owns the listener and active waits.
 * @param config - resolved by {@link Config}; omission selects `always` mode.
 */
export declare function apply(ctx: Context, config?: RetryBoostConfig): void;

export type { LlmFailure, Agent };

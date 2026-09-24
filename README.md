# dsh-retry-llm-plugin

English | [中文](README.zh.md)

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin that **boosts model-request retries** for unstable or rate-limited LLM endpoints.

When your LLM is flaky — frequent `429`/`RATE_LIMIT`, `5xx`/`SERVER`, timeouts, empty responses — the built-in recovery ends the turn after just **5 retries**. This plugin installs an additional listener on the agent loop's `agent/request-error` recovery waterfall that retries **50 times** by default, or **forever** in `always` mode, stopping only on success, turn cancellation, or plugin disposal.

> Written in TypeScript. Host-only — no client/UI bundle. Safe to mount alongside the built-in `@deepseek-ai/dsh-llm-retry`.

---

## Why

The user request, verbatim:

> 因为我连的 LLM 不稳定，经常被限制，所以我需要你给 dsh 增加一个功能就是重试支持多次，目前默认的是就 5 次，我希望改成更多次，比如 50 次，一直不断重试，一直到 LLM 能正常返回。

Translation: "The LLM I connect to is unstable and frequently gets rate-limited. Add a feature to DSH that retries many times — the default is only 5, I want more, like 50, keep retrying until the LLM returns normally."

This plugin does exactly that, as an installable bundle.

## How it works

DSH executes provider retry policy on the `agent/request-error` waterfall — an open-step extension point where each listener receives a failed request's `{ agent, turn, step, provider, failure, retryPolicy, signal }` and returns `{ kind: 'retry' }` to re-run the step, or calls `next()` to delegate. The built-in `@deepseek-ai/dsh-llm-retry` already listens there and enforces the **provider-owned** `retryPolicy` (normal = 5 retries by default).

This plugin adds a **second listener** on the same waterfall with its own, more aggressive policy:

- **`always`** (default) — retry every eligible failure without an attempt limit.
- **`normal`** — retry only `retryableCodes` up to `maxRetries` (default **50**).

Both plugins cooperate by waterfall order: whichever owns a given retry returns `{ kind: 'retry' }`. This plugin keeps its own per-step retry count **in memory** (keyed by agent object identity + turn + step + provider) and registers **no session projection**, so it never conflicts with the built-in retry plugin's `llmRetry` projection. It respects the turn abort signal and disposes cleanly (aborts active waits, drains them), so it never blocks turn quiescence or plugin disposal.

Retries are not logged as separate `llm/retry` session events (that durability is owned by the built-in retry plugin); this plugin only schedules the wait and returns `{ kind: 'retry' }`. Each retry is still a real, billed provider request.

## Install

### From a local clone (recommended for development)

```bash
git clone https://github.com/<you>/dsh-retry-llm-plugin.git
cd dsh-retry-llm-plugin
pnpm install            # optional: only needed to rebuild lib/ from src/
pnpm build              # optional: regenerates lib/ (already committed)
```

Then in DSH, install the bundle from the absolute package directory:

```
plugin_manager → install_bundle → target: /absolute/path/to/dsh-retry-llm-plugin
```

The repo **commits `lib/`**, so the bundle loads without a build step and without pnpm build-script approval.

### From GitHub directly

Point `plugin_manager` `install_bundle` at the GitHub URL; DSH runs `pnpm add` and selects the bundle.

## Configure

The row ships with sensible defaults in [`cordis.patch.yml`](cordis.patch.yml). Edit `config` there (HMR applies changes live in YAML-enabled profiles), or change it in Settings → Plugins:

```yaml
- id: retry-llm-plugin
  name: dsh-retry-llm-plugin
  config:
    mode: always                 # 'always' (default, no limit) | 'normal' (honor maxRetries)
    maxRetries: 50               # normal-mode budget after the first request (default 50)
    retryableCodes:              # normal-mode eligible codes (default transient set)
      - EMPTY_RESPONSE
      - RATE_LIMIT
      - SERVER
      - TIMEOUT
      - TRANSPORT
    excludeCodes:                # never retried, even in always mode
      - AUTH
      - MISSING_CREDENTIAL
      - NO_ADAPTER
      - INVALID_REQUEST
      - PROTOCOL
      - CONTEXT_OVERFLOW
      - IMAGE_OFFLOAD_REQUIRED
      - REGISTRATION_DISPOSED
    backoff:
      initialDelayMs: 500        # first local delay (default 500)
      maxDelayMs: 30000          # cap (default 30000; built-in uses 10000)
      jitterRatio: 0.2           # symmetric jitter range (default 0.2)
    respectProviderRetryAfter: true   # honor a valid provider Retry-After within maxDelayMs
```

### Defaults at a glance

| Option | Default | Notes |
|---|---|---|
| `mode` | `always` | Retry every eligible failure until success / cancel / dispose |
| `maxRetries` | `50` | Used only in `normal` mode |
| `retryableCodes` | `EMPTY_RESPONSE, RATE_LIMIT, SERVER, TIMEOUT, TRANSPORT` | Normal-mode eligible set |
| `excludeCodes` | `AUTH, MISSING_CREDENTIAL, NO_ADAPTER, INVALID_REQUEST, PROTOCOL, CONTEXT_OVERFLOW, IMAGE_OFFLOAD_REQUIRED, REGISTRATION_DISPOSED` | Permanent failures + codes owned by other recovery policies |
| `backoff.initialDelayMs` | `500` | |
| `backoff.maxDelayMs` | `30000` | Wider than the built-in 10s, for slow-recovering remote endpoints |
| `backoff.jitterRatio` | `0.2` | |
| `respectProviderRetryAfter` | `true` | |

Backoff is bounded exponential with symmetric jitter, matching the built-in policy's formula.

## Simpler alternative (no plugin)

You can also get unlimited retries **without this plugin** by setting `retryPolicy.mode: always` on your provider route directly — this is the native DSH knob:

```yaml
- name: '@deepseek-ai/dsh-llm-deepseek'
  config:
    apiKeyEnv: DEEPSEEK_API_KEY
    retryPolicy:
      mode: always
      backoff:
        initialDelayMs: 1000
        maxDelayMs: 30000
        jitterRatio: 0.2

- name: '@deepseek-ai/dsh-llm-retry'
```

Use this plugin when you want the boost **regardless of each provider's own policy**, or a finite 50-retry budget that's larger than the default 5.

## Repository layout

```
dsh-retry-llm-plugin/
├── cordis.patch.yml      # Loader patch: installs the retry-llm-plugin plugin row + defaults
├── icon.svg              # Plugin Manager card icon
├── lib/                  # Committed build output (loads without a build step)
│   ├── index.js          # Host plugin: the agent/request-error recovery listener
│   └── types/
│       └── index.d.ts    # Type declarations
├── locale/
│   ├── en.json           # Plugin Manager display title + description (English)
│   └── zh.json           # (中文)
├── src/
│   └── index.ts          # TypeScript source — the plugin (source of truth)
├── tsdown.config.ts      # Build config: src/ -> lib/
├── tsconfig.json         # Type-check config (pnpm typecheck)
├── package.json          # Bundle manifest: dsh.bundle.patch, exports, icon, devDeps
├── README.md             # This file (English)
├── README.zh.md          # 中文说明
├── LICENSE               # Apache-2.0
└── .gitignore
```

## Build

```bash
pnpm install
pnpm build        # tsdown: src/index.ts -> lib/index.js + lib/types/index.d.ts
pnpm typecheck   # tsc --noEmit
```

`lib/` is committed so installations that skip the build still work. Rebuild after editing `src/`.

## Compatibility

Built and tested against DeepSeek Harness `0.1.7-rc.1` (Cordis `4.0.4`, schemastery `3.18.4`). The only runtime import is `@deepseek-ai/schemastery`, resolved from the host's module graph; the `@deepseek-ai/*` entries in `devDependencies` are for type-checking and building only.

## License

Apache-2.0 — see [LICENSE](LICENSE).

# dsh-remote-retry-llm-plugin

English | [中文](README.zh.md)

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin that provides **SSH remote development tools** (exec, read, write) and **boosts LLM retries** to 50+ for unstable endpoints.

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

Retries emit `llm/retry` and `llm/retry-started` session events so every retry is visible in the UI (matching the built-in retry plugin's format).

## SSH Remote Development

This plugin also provides **SSH tools** that let the agent execute commands, read files, and write files on a remote server — enabling remote development without SSH-ing manually.

### Tools

| Tool | Description | Parameters |
|---|---|---|
| `ssh-exec` | Execute a shell command on the remote server | `command` (required), `timeoutMs` (optional, default 30000), `target` (optional) |
| `ssh-read` | Read a file from the remote server | `path` (required), `target` (optional) |
| `ssh-write` | Write content to a file on the remote server | `path` (required), `content` (required), `target` (optional) |
| `ssh-targets` | Manage saved remote workspaces | `action` (required: `list`/`test`/`save`/`remove`/`default`), plus `target`/`name`/`host`/`port`/`username`/`identityFile`/`passwordEnv`/`remoteDir` |

`target` names a saved remote workspace (see [Remote workspaces](#remote-workspaces-configure--test--save-in-the-ui)); omit it to use the default target, then the plugin config `ssh.*`.

### Example usage

```
Agent: ssh-exec { command: "ls -la /home/user/project" }
→ { stdout: "total 48\ndrwxr-xr-x ...", stderr: "", exitCode: 0 }

Agent: ssh-read { path: "/home/user/project/config.yaml" }
→ { content: "host: ...\nport: 22", path: "/home/user/project/config.yaml" }

Agent: ssh-write { path: "/home/user/project/README.md", content: "# My Project" }
→ { success: true, path: "/home/user/project/README.md" }
```

The SSH connection is established lazily on first tool call and cached for the plugin's lifetime; a failed or timed-out call drops the connection so the next call reconnects. Connection parameters come from the plugin config (see below):

- `identityFile` — private key path (`~` is expanded); when set, key auth is used.
- `password` — used when no `identityFile` is set. Both `password` and `keyboard-interactive` are offered, so PAM/AD-backed servers (which commonly advertise only keyboard-interactive) log in exactly like `ssh(1)` does.
- neither — `SSH_AUTH_SOCK` (ssh-agent) when available, otherwise the default `~/.ssh/id_ed25519`, `id_ecdsa`, `id_rsa` keys.
- `username` — defaults to `$USER`.

`remoteDir` is the default remote working directory: `ssh-exec` runs commands as `cd '<remoteDir>' && <command>`, and `ssh-read`/`ssh-write` resolve relative paths against it (absolute paths and `~` are used as-is).

> The plugin talks SSH directly through `ssh2`, so it does **not** read `~/.ssh/config`. Put the host, port, username, and key in the plugin config instead; a `Host` alias from your ssh config will not resolve.

### Enabling the tools for the current agent

Tools are registered per agent. On activation the plugin registers them for every agent that already exists (via the `agents` service) **and** for every agent created later, so a freshly installed bundle takes effect in the running session without a restart.

## Remote workspaces (configure · test · save in the UI)

The package ships a **browser half** with two entry points:

1. **Settings → 远程工作区**: the full target manager (add / edit / test connection / set default / delete).
2. The **add-workspace flow itself**: clicking "Add workspace…" in the sidebar or the blank-session hero first offers a parallel choice — **本地目录…** (the platform directory picker, same as shipped) or **远程 SSH…** (form → test connection → save).

A saved target *is* a remote workspace. Form fields:

| Field | Meaning |
|---|---|
| Name | Display name; also the value tools accept as `target` |
| Host / Port | SSH address (port defaults to 22) |
| Username | Defaults to `$USER` |
| Private key | `~` is expanded; when empty, `passwordEnv`, ssh-agent, then the default keys are tried |
| Password ref | The `passwordEnv` name doubles as a DSH **credential reference**: the password you type can be stored in DSH's credential store under it (and it also resolves from the process environment and `.env` files) |
| Remote dir | Working directory **on the remote host**; the "浏览远端…" button lists the remote filesystem over SSH so you can pick it (it is not a local picker) |
| Password | Used for the test and, when "保存密码" is ticked, stored in DSH's credential store so later `ssh-exec` calls authenticate without it |

Each row states **远程目录 / 本地目录 / password state** explicitly (a saved password reads 已保存 · 引用 …; 显示密码 reveals it). The form auto-loads the saved password whenever host+port+username match a saved target — including from 添加 — so it never has to be retyped, and the save confirmation spells out what was stored (connection, remote dir, local dir, default).

Inside "浏览远端…" you can also **type a path** (Enter or 跳到) instead of clicking through the tree; 用这个目录 adopts it.

The password field has its own **显示/隐藏 (show/hide)** toggle, so you can check what you typed before saving. The connection fields (host, port, username, key, remote dir — **never the password**) are remembered in the browser, so reopening the form prefills them.

Every target with a saved password has a **显示密码 (reveal)** button: the plaintext is fetched from the host only when you click, can be copied, and can be hidden again — the list response itself never carries it.

Resolution order: tool `target` argument → **the target bound to the session's workspace** → the default target → the plugin config `ssh.*`.

**Per-workspace binding**: opening a target gives it its own session directory `~/dsh-remote/<target id>`, created and bound by the host. To change it, click **会话目录…** on the target's row, or use the **会话目录** field of the new/edit form (empty derives it). A target keeps exactly one session directory — moving it releases the old binding, and taking over a directory that belonged to another target is reported explicitly. Each `远程 · <name>` workspace is therefore bound to its own host — even after the default target changes, a session opened in the 财经 workspace keeps talking to 财经. Deleting a target releases its bindings but leaves the directory on disk.

Targets and bindings live in `remote-ssh-targets.json` in the profile directory (0600); the file holds no password — a saved password lives in DSH's credential store under the target's reference.

### Local directory vs remote directory

Do not confuse the two:

- **Remote dir** (`remoteDir`) is a path on the remote host: `ssh-exec` runs there (`cd '<dir>' && <cmd>`) and relative `ssh-read/write` paths resolve against it. The form's "浏览远端…" button lists the **remote** filesystem.
- **Local dir** is what a DSH session/workspace needs: workspaces must be existing **local** directories. It is only the session cwd and plays no part in remote commands; the add-workspace flow defaults it to your home directory.

Saving from the add-workspace flow also makes the new target the **default**, and re-saving an identical connection updates that record instead of piling up duplicates.

### Saving several targets, and how to actually work remotely

Targets are a list — save as many as you like. Every "添加远程工作区" click mints a **new** target (connection fields are remembered, the name/identity is not, so a second save can never overwrite the first), and **设为默认** picks the one tools use by default.

There is no separate "log in" step:

Every entry point lives in the **add-workspace flow** (there is no separate settings page):

1. **Click 添加工作区** (sidebar add-workspace, or the blank-session Hero picker) and choose:
   - **本地目录…** — the platform directory picker, exactly as shipped;
   - **远程工作区（N）…** — **lists every saved remote workspace** with `user@host:port`, **remote dir** and password state, each row offering **打开 / 编辑 / 删除 / 显示密码**. 打开 enters it: sets it as the default, creates the workspace titled `远程 · <name> (<host>)`, and selects it;
   - **取消**.
2. The bottom of that list is **+ 新建远程工作区（SSH）…**: fill host / username / password / **remote dir** → test → **保存并打开**. Saving makes it the default, creates the same titled workspace, and **opens it right there**.
3. Once a target is the **default**, just talk to the agent in any session ("check disk usage on /srv on the remote box", "restart nginx remotely") — `ssh-exec` / `ssh-read` / `ssh-write` act on that target, and `remoteDir` is the working directory for commands.
4. For a different host, name it in the conversation (or let the agent pass the tool's `target` parameter).
5. The agent does not have to guess: the plugin registers a runtime-context entry listing every saved target and the default, refreshed on each model step.

A session's cwd stays local (DSH workspaces are local directories); remote work happens through the SSH tools. The "添加工作区 → 远程 SSH" flow can also adopt a local directory for the session.

### How the page talks to the host

The browser half needs no Typert code generation: the host registers one JSON route with `ctx.webServer.register({ kind: 'prefix', path: '/remote-ssh' })` (`GET /targets`, `POST /targets`, `POST /targets/delete`, `POST /default`, `POST /test`) and the page uses same-origin `fetch`. Authentication reuses DSH's own signed same-origin cookie; the route additionally requires a loopback Host and a matching `Origin`, and answers 403 to cross-site requests.

### Build and activation

`lib/client.js` is a **hand-authored** ModuleLoader bundle (`window.__ModuleLoader__.load({ id, factory })`, React coming from the shell's shared module registry), so it needs no bundler:

```bash
pnpm build:tsc      # compile the host half and copy the client bundle into lib/
pnpm build:client   # rebuild/copy lib/client.js only
```

The browser half is discovered by a **startup** scan of plugin manifests, so changing `dsh.client` or `lib/client.js` requires a **DSH restart** plus a page refresh. If the parallel choice in the add-workspace flow misbehaves, disable the plugin: the shipped directory picker stays registered in the same hole at priority 0 and takes over immediately.

## Install

### From a local clone (recommended for development)

```bash
git clone https://github.com/<you>/dsh-remote-retry-llm-plugin.git
cd dsh-remote-retry-llm-plugin
pnpm install            # required: installs the runtime deps this package resolves
pnpm build              # optional: lib/ is committed; rebuild only after editing src/
```

Then in DSH, install the bundle from the absolute package directory:

```
plugin_manager → install_bundle → target: /absolute/path/to/dsh-remote-retry-llm-plugin
```

The repo **commits `lib/`**, so the bundle loads without a build step and without pnpm build-script approval.

### From GitHub directly

Point `plugin_manager` `install_bundle` at the GitHub URL; DSH runs `pnpm add` and selects the bundle.

## Configure

The row ships with sensible defaults in [`cordis.patch.yml`](cordis.patch.yml). Edit `config` there (HMR applies changes live in YAML-enabled profiles), or change it in Settings → Plugins:

```yaml
- id: retry-llm-plugin
  name: dsh-remote-retry-llm-plugin
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

    # ── SSH remote development ──
    ssh:
      host: myserver.com         # SSH hostname (default localhost)
      port: 22                   # SSH port (default 22)
      username: myuser           # SSH username
      identityFile: ~/.ssh/id_rsa  # SSH private key path
      password: ''               # password auth (alternative to key)
      passwordEnv: ''            # or: name of the env var holding the password
      remoteDir: /home/myuser    # default remote working directory
```

### Pointing at a real server

The bundle's own [`cordis.patch.yml`](cordis.patch.yml) ships `ssh.host: localhost`. Override just the
keys you need from your **profile** patch layer (`~/.dsh/profiles/<profile>/cordis.patch.yml`), which is
applied after every bundle layer:

```yaml
- id: retry-llm-plugin
  name: dsh-remote-retry-llm-plugin
  config:
    ssh:
      host: 10.0.0.12
      port: 22
      username: root
      identityFile: ~/.ssh/id_ed25519
      remoteDir: /srv/app
```

A `link:` install (`plugin_manager → install_bundle` pointed at a local checkout) symlinks the package
instead of copying it, so `ssh2` and `schemastery` resolve from that checkout's `node_modules` — keep
`pnpm install` run there.

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
| `ssh.host` | `localhost` | SSH hostname |
| `ssh.port` | `22` | SSH port |
| `ssh.username` | `''` | SSH username |
| `ssh.identityFile` | `''` | SSH private key path |
| `ssh.password` | `''` | SSH password (alternative to key; the saved targets never store one) |
| `ssh.passwordEnv` | `''` | Environment variable holding the password |
| `ssh.remoteDir` | `''` | Default remote working directory |

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
dsh-remote-retry-llm-plugin/
├── cordis.patch.yml      # Loader patch: installs the retry-llm-plugin plugin row + defaults
├── icon.svg              # Plugin Manager card icon
├── lib/                  # Committed build output (loads without a build step)
│   ├── index.js          # Host plugin: retry listener, SSH tools, /remote-ssh route
│   ├── client.js         # Browser half: settings page + workspace directory flow
│   ├── ssh.js            # SSH transport (connect / exec / sftp)
│   ├── targets.js        # Durable remote-workspace (SSH target) store
│   └── types/
│       └── index.d.ts    # Type declarations
├── locale/
│   ├── en.json           # Plugin Manager display title + description (English)
│   └── zh.json           # (中文)
├── scripts/
│   └── copy-client.mjs   # Copies the hand-authored browser bundle into lib/
├── src/
│   ├── index.ts          # Host plugin entry (source of truth)
│   ├── ssh.ts            # SSH transport source
│   ├── targets.ts        # Target store source
│   └── client.js         # Browser half source (ModuleLoader bundle, no bundler)
├── tsdown.config.ts      # Build config: src/ -> lib/ (pnpm build)
├── tsconfig.json         # Type-check config (pnpm typecheck)
├── tsconfig.build.json   # Emit config for the bundler-free build (pnpm build:tsc)
├── pnpm-workspace.yaml   # Local install root + allowed/ignored build scripts
├── package.json          # Bundle manifest: dsh.bundle.patch, dsh.client, exports, deps
├── README.md             # This file (English)
├── README.zh.md          # 中文说明
├── LICENSE               # Apache-2.0
└── .gitignore
```

## Build

```bash
pnpm install
pnpm build        # tsdown: src/index.ts -> lib/index.js
pnpm build:tsc    # tsc alternative: same output, no native bundler needed
pnpm typecheck    # tsc --noEmit
```

`lib/` is committed so installations that skip the build still work. Rebuild after editing `src/`.

`pnpm build` runs [tsdown](https://tsdown.dev) (rolldown). If you are building with the
Node binary bundled inside the DSH desktop app, rolldown's native binding is rejected by
macOS library validation (`different Team IDs`); use `pnpm build:tsc` there instead — it
emits the same `lib/index.js` from `src/index.ts` using plain TypeScript.

> `lib/` is committed, but the plugin's **runtime dependencies are not**: `@deepseek-ai/schemastery`
> and `ssh2` are resolved from this package's own `node_modules`. Run `pnpm install` in the package
> directory once, otherwise the plugin cannot load (`ssh2` is imported lazily, so a missing `ssh2`
> only disables the SSH tools, but a missing `schemastery` fails activation).

## Compatibility

Built and tested against DeepSeek Harness `0.1.7-rc.2` (Cordis `4.0.4`, schemastery `3.18.4`). Runtime dependencies: `ssh2` (SSH client), `@deepseek-ai/schemastery` (config schema), `@deepseek-ai/dsh-tools` (tool definitions). The DSH packages are also declared in `peerDependencies` pinned to the runtime line, so the plugin manager can reject a mismatched runtime instead of loading it. The remaining `@deepseek-ai/*` entries in `devDependencies` are for type-checking and building only.

## License

Apache-2.0 — see [LICENSE](LICENSE).

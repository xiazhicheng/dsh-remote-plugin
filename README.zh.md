# dsh-remote-retry-llm-plugin

[English](README.md) | 中文

一个 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 插件，提供 **SSH 远程开发工具**（exec/read/write）并**增强 LLM 重试**至 50+ 次。

当你的 LLM 不稳定——频繁 `429`/`RATE_LIMIT`、`5xx`/`SERVER`、超时、空响应——内置重试只重试 **5 次**就结束本轮。本插件在 agent loop 的 `agent/request-error` 恢复瀑布流上额外挂一个监听器，默认重试 **50 次**，或在 `always` 模式下**无限重试**，只在成功、本轮取消或插件卸载时停止。

> 用 TypeScript 编写。仅 Host 侧，无客户端/UI bundle。可与内置 `@deepseek-ai/dsh-llm-retry` 共存。

---

## 背景

原话需求：

> 因为我连的 LLM 不稳定，经常被限制，所以我需要你给 dsh 增加一个功能就是重试支持多次，目前默认的是就 5 次，我希望改成更多次，比如 50 次，一直不断重试，一直到 LLM 能正常返回。

本插件正是为此而生，以可安装 bundle 形式交付。

## 原理

DSH 在 `agent/request-error` 瀑布流上执行 provider 重试策略——这是一个 open-step 扩展点：每个监听器收到失败请求的 `{ agent, turn, step, provider, failure, retryPolicy, signal }`，返回 `{ kind: 'retry' }` 让 loop 重跑该 step，或调 `next()` 委托给下游。内置 `@deepseek-ai/dsh-llm-retry` 已挂在此处，执行 **provider 自有**的 `retryPolicy`（normal 模式默认 5 次）。

本插件在同一个瀑布流上再加**第二个监听器**，用更激进的自有策略：

- **`always`**（默认）——对每个可重试失败无限重试。
- **`normal`**——只重试 `retryableCodes`，最多 `maxRetries` 次（默认 **50**）。

两个插件按瀑布流顺序协作：谁拥有某次重试就返回 `{ kind: 'retry' }`。本插件用**内存中**的 per-step 计数（按 agent 对象身份 + turn + step + provider 作 key），**不注册 session projection**，因此绝不与内置重试插件的 `llmRetry` projection 冲突。它尊重本轮 abort signal，卸载时干净中止（abort 活跃等待并 drain），绝不阻塞本轮收尾或插件卸载。

重试会发射 `llm/retry` 和 `llm/retry-started` session 事件，每次重试在 UI 中可见（与内置重试插件格式一致）。

## SSH 远程开发

本插件还提供 **SSH 工具**，让 agent 可以直接在远程服务器上执行命令、读写文件，无需手动 SSH。

### 工具

| 工具 | 说明 | 参数 |
|---|---|---|
| `ssh-exec` | 在远程服务器上执行 shell 命令 | `command`（必填）、`timeoutMs`（可选，默认 30000） |
| `ssh-read` | 读取远程服务器上的文件 | `path`（必填） |
| `ssh-write` | 向远程服务器写入文件 | `path`（必填）、`content`（必填） |

### 使用示例

```
Agent: ssh-exec { command: "ls -la /home/user/project" }
→ { stdout: "total 48\ndrwxr-xr-x ...", stderr: "", exitCode: 0 }

Agent: ssh-read { path: "/home/user/project/config.yaml" }
→ { content: "host: ...\nport: 22", path: "/home/user/project/config.yaml" }

Agent: ssh-write { path: "/home/user/project/README.md", content: "# My Project" }
→ { success: true, path: "/home/user/project/README.md" }
```

SSH 连接在首次调用时懒加载并缓存，连接参数在插件配置中设置（见下方）。

## 安装

### 本地 clone（开发推荐）

```bash
git clone https://github.com/<你>/dsh-remote-retry-llm-plugin.git
cd dsh-remote-retry-llm-plugin
pnpm install            # 可选：仅当要从 src/ 重建 lib/ 时需要
pnpm build              # 可选：重新生成 lib/（已提交）
```

然后在 DSH 中用绝对路径安装 bundle：

```
plugin_manager → install_bundle → target: /绝对路径/dsh-remote-retry-llm-plugin
```

仓库**已提交 `lib/`**，所以 bundle 无需构建步骤、无需 pnpm build-script 审批即可加载。

### 直接从 GitHub 安装

把 `plugin_manager` 的 `install_bundle` 指向 GitHub URL，DSH 会运行 `pnpm add` 并选中 bundle。

## 配置

[`cordis.patch.yml`](cordis.patch.yml) 里已带合理默认值。在那里编辑 `config`（启用 HMR 的 profile 改动即时生效），或在 设置 → 插件 中改：

```yaml
- id: retry-llm-plugin
  name: dsh-remote-retry-llm-plugin
  config:
    mode: always                 # 'always'（默认，无限）| 'normal'（遵循 maxRetries）
    maxRetries: 50               # normal 模式下首次请求之后的重试预算（默认 50）
    retryableCodes:              # normal 模式可重试码（默认瞬态集合）
      - EMPTY_RESPONSE
      - RATE_LIMIT
      - SERVER
      - TIMEOUT
      - TRANSPORT
    excludeCodes:                # 即使 always 模式也不重试
      - AUTH
      - MISSING_CREDENTIAL
      - NO_ADAPTER
      - INVALID_REQUEST
      - PROTOCOL
      - CONTEXT_OVERFLOW
      - IMAGE_OFFLOAD_REQUIRED
      - REGISTRATION_DISPOSED
    backoff:
      initialDelayMs: 500        # 首次本地延迟（默认 500）
      maxDelayMs: 30000          # 上限（默认 30000；内置用 10000）
      jitterRatio: 0.2           # 对称抖动范围（默认 0.2）
    respectProviderRetryAfter: true   # 在 maxDelayMs 内尊重 provider 的 Retry-After

    # ── SSH 远程开发 ──
    ssh:
      host: myserver.com         # SSH 主机名（默认 localhost）
      port: 22                   # SSH 端口（默认 22）
      username: myuser           # SSH 用户名
      identityFile: ~/.ssh/id_rsa  # SSH 私钥路径
      password: ''               # 密码认证（密钥的替代方案）
      remoteDir: /home/myuser    # 默认远程工作目录
```

### 默认值一览

| 选项 | 默认 | 说明 |
|---|---|---|
| `mode` | `always` | 对每个可重试失败一直重试，直到成功/取消/卸载 |
| `maxRetries` | `50` | 仅 normal 模式生效 |
| `retryableCodes` | `EMPTY_RESPONSE, RATE_LIMIT, SERVER, TIMEOUT, TRANSPORT` | normal 模式可重试集合 |
| `excludeCodes` | `AUTH, MISSING_CREDENTIAL, NO_ADAPTER, INVALID_REQUEST, PROTOCOL, CONTEXT_OVERFLOW, IMAGE_OFFLOAD_REQUIRED, REGISTRATION_DISPOSED` | 永久失败 + 归其他恢复策略所有的码 |
| `backoff.initialDelayMs` | `500` | |
| `backoff.maxDelayMs` | `30000` | 比内置的 10s 更宽，适配恢复慢的远程端点 |
| `backoff.jitterRatio` | `0.2` | |
| `respectProviderRetryAfter` | `true` | |
| `ssh.host` | `localhost` | SSH 主机名 |
| `ssh.port` | `22` | SSH 端口 |
| `ssh.username` | `''` | SSH 用户名 |
| `ssh.identityFile` | `''` | SSH 私钥路径 |
| `ssh.password` | `''` | SSH 密码（密钥的替代方案） |
| `ssh.remoteDir` | `''` | 默认远程工作目录 |

退避为带对称抖动的有界指数退避，公式与内置策略一致。

## 更简单的替代（不用插件）

你也可以**不装本插件**，直接在 provider 路由上设 `retryPolicy.mode: always`——这是 DSH 原生开关：

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

当你想**无视各 provider 自有策略**统一增强重试，或想要比默认 5 更大的有限 50 次预算时，用本插件。

## 仓库结构

```
dsh-remote-retry-llm-plugin/
├── cordis.patch.yml      # Loader patch：安装 retry-llm-plugin 插件行 + 默认值
├── icon.svg              # 插件管理器卡片图标
├── lib/                  # 已提交的构建产物（无需构建即可加载）
│   ├── index.js          # Host 插件：agent/request-error 恢复监听器
│   └── types/
│       └── index.d.ts    # 类型声明
├── locale/
│   ├── en.json           # 插件管理器展示标题 + 描述（英文）
│   └── zh.json           # （中文）
├── src/
│   └── index.ts          # TypeScript 源码——插件本体（真相来源）
├── tsdown.config.ts      # 构建配置：src/ -> lib/
├── tsconfig.json         # 类型检查配置（pnpm typecheck）
├── package.json          # bundle 清单：dsh.bundle.patch、exports、icon、devDeps
├── README.md             # 英文说明
├── README.zh.md          # 本文件（中文）
├── LICENSE               # Apache-2.0
└── .gitignore
```

## 构建

```bash
pnpm install
pnpm build        # tsdown：src/index.ts -> lib/index.js + lib/types/index.d.ts
pnpm typecheck   # tsc --noEmit
```

`lib/` 已提交，跳过构建的安装也能用。改 `src/` 后重建。

## 兼容性

基于 DeepSeek Harness `0.1.7-rc.1`（Cordis `4.0.4`、schemastery `3.18.4`）编写测试。运行时依赖：`ssh2`（SSH 客户端）、`@deepseek-ai/schemastery`（配置 schema）、`@deepseek-ai/dsh-tools`（工具定义）。`devDependencies` 里的 `@deepseek-ai/*` 仅用于类型检查与构建。

## 许可

Apache-2.0——见 [LICENSE](LICENSE)。

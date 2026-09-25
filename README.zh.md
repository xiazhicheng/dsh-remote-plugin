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
| `ssh-exec` | 在远程服务器上执行 shell 命令 | `command`（必填）、`timeoutMs`（可选，默认 30000）、`target`（可选） |
| `ssh-read` | 读取远程服务器上的文件 | `path`（必填）、`target`（可选） |
| `ssh-write` | 向远程服务器写入文件 | `path`（必填）、`content`（必填）、`target`（可选） |
| `ssh-targets` | 管理已保存的远程工作区 | `action`（必填：`list`/`test`/`save`/`remove`/`default`），以及 `target`/`name`/`host`/`port`/`username`/`identityFile`/`passwordEnv`/`remoteDir` |

`target` 指定已保存的远程工作区（见下节）；省略时用默认目标，再退回插件配置 `ssh.*`。

### 使用示例

```
Agent: ssh-exec { command: "ls -la /home/user/project" }
→ { stdout: "total 48\ndrwxr-xr-x ...", stderr: "", exitCode: 0 }

Agent: ssh-read { path: "/home/user/project/config.yaml" }
→ { content: "host: ...\nport: 22", path: "/home/user/project/config.yaml" }

Agent: ssh-write { path: "/home/user/project/README.md", content: "# My Project" }
→ { success: true, path: "/home/user/project/README.md" }
```

SSH 连接在首次调用时懒加载并缓存；某次调用失败或超时后会丢弃该连接，下次调用重新连接。连接参数来自插件配置（见下方）：

- `identityFile` — 私钥路径（会展开 `~`）；设置后使用密钥认证。
- `password` — 未设置 `identityFile` 时使用。会同时尝试 `password` 与 `keyboard-interactive`，因此 PAM/AD 那种只广告键盘交互的服务器也能像 `ssh(1)` 一样登录。
- 两者都不设 — 优先用 `SSH_AUTH_SOCK`（ssh-agent），否则依次尝试默认的 `~/.ssh/id_ed25519`、`id_ecdsa`、`id_rsa`。
- `username` — 默认取 `$USER`。

`remoteDir` 是远端默认工作目录：`ssh-exec` 会以 `cd '<remoteDir>' && <command>` 执行，`ssh-read`/`ssh-write` 的相对路径也基于它解析（绝对路径和 `~` 原样使用）。

> 插件通过 `ssh2` 直接建连，**不读取 `~/.ssh/config`**。请把 host、port、username、密钥写进插件配置；ssh config 里的 `Host` 别名不会被解析。

### 让当前 agent 立即拿到工具

工具是按 agent 注册的。插件激活时既会为**已存在**的每个 agent 注册（通过 `agents` 服务枚举），也会为之后新建的 agent 注册，因此刚装好的 bundle 在正在运行的会话里就能直接生效，无需重启。

## 远程工作区（页面配置 · 测试连通 · 保存）

插件带一个**客户端（浏览器）半部**，提供两处入口：

1. **设置 → 远程工作区**：完整的目标管理页（添加 / 编辑 / 测试连接 / 设为默认 / 删除）。
2. **添加工作区**流程本身：点侧边栏或新会话的「添加工作区…」时，先出现一个并列选择 —— **本地目录…**（走系统原生的目录选择，与官方行为一致）或 **远程 SSH…**（填表 → 测试连接 → 保存）。

保存后的目标就是「远程工作区」。表单字段：

| 字段 | 说明 |
|---|---|
| 名称 | 显示名，也是工具的 `target` 可引用值 |
| 主机 / 端口 | SSH 地址（默认端口 22） |
| 用户名 | 留空则用 `$USER` |
| 私钥 | `~` 会展开；不填则依次尝试 `passwordEnv`、ssh-agent、默认私钥 |
| 密码引用 | `passwordEnv` 同时就是 DSH 的**凭据引用**：你输入的密码可以存进 DSH 凭据库（该引用也会解析进程环境变量与 `.env` 文件） |
| 远程目录 | **远程机器上的**工作目录；填完可点「浏览远端…」直接列出远端目录树来选（走 SSH 执行 `ls`，不是本地选择器） |
| 密码 | 用于测试；勾选「保存密码」后会写入 DSH 凭据库，之后 `ssh-exec` 无需再带密码 |

列表里每个目标都明确列出 **远程目录 / 本地目录 / 密码状态**；密码显示为「已保存 · 引用 xxx」，点「显示密码」看明文。表单里只要主机+端口+用户名匹配某个已保存目标（包括点「添加」时），就会**自动载入那条的密码**，不需要重输。保存成功后的提示也会写明存了什么（连接、远程目录、本地目录、是否设为默认）。

「浏览远端…」里也可以**直接输入路径**（回车或点「跳到」），不必逐级点选；点「用这个目录」即采用。

表单里的密码框自带 **显示/隐藏** 按钮，输入时就能切到明文核对；连接参数（主机/端口/用户名/私钥/远程目录，**不含密码**）会记在浏览器本地，下次打开表单自动带出，不用重输。

列表里每个已保存密码的目标都有 **显示密码** 按钮：点击才向 Host 读取并以明文展示（可复制、可再次隐藏），未点击时页面里不含明文。

目标选择顺序：工具参数 `target` → **会话工作区绑定的目标** → 默认目标 → 插件配置里的 `ssh.*`。

**按工作区绑定**：每台目标在打开时会自动获得一个专属会话目录 `~/dsh-remote/<目标id>`（由 Host 创建并记录绑定）。想换目录：在远程工作区列表里点该行的 **「会话目录…」**，或在新建/编辑表单的 **「会话目录」** 字段里填写/选择（留空即自动）。一个目标只保留一个会话目录，换目录会释放旧绑定；若你选的目录原本属于别的目标，会明确提示已改绑。这样每个「远程 · 名称」工作区都绑定到它自己的机器——即使默认目标被切到别的机器，**在 财经 工作区里开的会话仍然只操作 财经**。删除目标会释放绑定，但目录保留。

存储位置是 profile 目录下的 `remote-ssh-targets.json`（0600，文件里不含密码；绑定也记在这里）；保存的密码存在 DSH 凭据库中，以目标的引用名为键。

### 本地目录 vs 远程目录

两个目录不要混淆：

- **远程目录**（`remoteDir`）：远程机器上的路径，`ssh-exec` 在那里执行（`cd '<dir>' && <cmd>`），`ssh-read/write` 的相对路径也基于它。表单里的「浏览远端…」列的是**远端**文件系统。
- **本地目录**：DSH 的会话/工作区必须是**本地**已存在的目录。它只是会话的 cwd，不参与远程命令；「添加工作区 → 远程 SSH」里留空则用你的主目录。

### 保存多个目标，以及「怎么开始远程干活」

目标是一个列表，可以存任意多个：每点一次「添加远程工作区」都创建**新**目标（连接字段会带上次的，名称与身份不会，避免误覆盖）。用 **设为默认** 决定默认用哪一台。

保存后不需要额外「登录」动作：

全部入口都在**「添加工作区」**里（设置里没有单独的远程工作区页面）：

1. **点「添加工作区」**（侧边栏的添加工作区、或新会话 Hero 的工作区选择器）→ 会出现三个选项：
   - **本地目录…**：走平台目录选择器，和官方行为一致；
   - **远程工作区（N）…**：**直接列出所有已保存的远程工作区**，每行显示 `用户名@主机:端口`、**远程目录**、密码状态，并有 **打开 / 编辑 / 删除 / 显示密码**；点「打开」即进入该远程工作区（自动设为默认、生成标题为 `远程 · 名称 (主机)` 的工作区并选中）；
   - **取消**。
2. 列表底部是 **「+ 新建远程工作区（SSH）…」**：填主机/用户名/密码/**远程目录** → 测试连接 → **保存并打开**。保存后立即设为默认、生成同样的工作区标题并**就地打开**，不用再去别处找。
3. **设为默认** 后，在任意其他会话里直接让 agent 干活即可，例如「在远程看下 /srv 的磁盘占用」「远程重启 nginx」——`ssh-exec` / `ssh-read` / `ssh-write` 默认作用在该目标上，`remoteDir` 是命令的工作目录。
4. 要对**别的**机器操作，就在对话里点名（例如「在 10.0.0.12 上…」），或让 agent 用工具参数 `target`。
5. agent 不是靠猜：插件注册了一段运行时上下文，每个模型步骤都会带上已保存目标列表与默认项，所以它知道「远程」指哪台。

会话本身的 cwd 仍是本地目录（DSH 的工作区就是本地路径）；远程操作通过 ssh 工具完成。在「添加工作区 → 远程 SSH」流程里也可以同时选一个本地目录来承载会话。

### 明文查看密码

密码不存在 `remote-ssh-targets.json` 里，而是存在 DSH 凭据库中，以目标的引用名为键（`passwordEnv` 字段就是引用名）。点「显示密码」时，页面调用 `POST /remote-ssh/reveal`，Host 用 `ctx.credentials.resolve(ref)` 读回并返回明文；这条路由同样只接受 loopback、校验同源 Cookie 与 `Origin`。

注意：只要能在浏览器里点这个按钮，就能读到密码；不点则页面内不留明文。

### 页面是怎么和 Host 通信的

客户端半部不依赖 Typert 代码生成：Host 侧用 `ctx.webServer.register({ kind: 'prefix', path: '/remote-ssh' })` 挂了一条 JSON 路由（`GET /targets`、`POST /targets`、`POST /targets/delete`、`POST /default`、`POST /test`），浏览器同源 `fetch`。鉴权沿用 DSH 自己的同源签名 Cookie；此外路由只接受 loopback Host 且校验 `Origin`，跨站请求一律 403。

### 构建与生效

`lib/client.js` 是**手写**的 ModuleLoader bundle（`window.__ModuleLoader__.load({ id, factory })`，React 由 shell 的共享模块表提供），所以不需要打包器：

```bash
pnpm build:tsc      # 编译 Host 半部并复制客户端 bundle 到 lib/
pnpm build:client   # 只重建/复制 lib/client.js
```

浏览器半部是在 **DSH 启动时**扫描插件清单发现的，所以改动 `dsh.client` 或 `lib/client.js` 后需要**重启 DSH**，再刷新页面。若「添加工作区」的并列选择有异常，可在插件管理里禁用本插件——官方目录选择器仍在同一槽位注册着（priority 0），会立即恢复。

## 安装

### 本地 clone（开发推荐）

```bash
git clone https://github.com/<你>/dsh-remote-retry-llm-plugin.git
cd dsh-remote-retry-llm-plugin
pnpm install            # 必须：安装本包自身解析的运行时依赖
pnpm build              # 可选：lib/ 已提交，只有改过 src/ 才需要重建
```

然后在 DSH 中用绝对路径安装 bundle：

```
plugin_manager → install_bundle → target: /绝对路径/dsh-remote-retry-llm-plugin
```

仓库**已提交 `lib/`**，所以 bundle 无需构建步骤、无需 pnpm build-script 审批即可加载。但**运行时依赖没有提交**：`@deepseek-ai/schemastery` 和 `ssh2` 从本包自己的 `node_modules` 解析，所以先在该目录跑一次 `pnpm install`（缺 `ssh2` 只会静默禁用 SSH 工具，缺 `schemastery` 则插件无法激活）。

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
      passwordEnv: ''            # 或者：存放密码的环境变量名
      remoteDir: /home/myuser    # 默认远程工作目录
```

### 指向真实服务器

bundle 自带的 [`cordis.patch.yml`](cordis.patch.yml) 里 `ssh.host` 是 `localhost`。只覆盖你需要的键，写在**profile** 的补丁层（`~/.dsh/profiles/<profile>/cordis.patch.yml`，它在所有 bundle 层之后应用）：

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

`link:` 安装（`plugin_manager → install_bundle` 指向本地检出目录）只是软链该包、不会复制依赖，所以 `ssh2` 和 `schemastery` 从该检出的 `node_modules` 解析——请保证在那里跑过 `pnpm install`。

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
| `ssh.password` | `''` | SSH 密码（密钥的替代方案；保存的目标里永不写入密码） |
| `ssh.passwordEnv` | `''` | 存放密码的环境变量名 |
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
│   ├── index.js          # Host 插件：重试监听器、SSH 工具、/remote-ssh 路由
│   ├── client.js         # 浏览器半部：设置页 + 工作区目录流程
│   ├── ssh.js            # SSH 传输（连接 / exec / sftp）
│   ├── targets.js        # 远程工作区（SSH 目标）持久化存储
│   └── types/
│       └── index.d.ts    # 类型声明
├── locale/
│   ├── en.json           # 插件管理器展示标题 + 描述（英文）
│   └── zh.json           # （中文）
├── scripts/
│   └── copy-client.mjs   # 把手写的浏览器 bundle 复制进 lib/
├── src/
│   ├── index.ts          # Host 插件入口（真相来源）
│   ├── ssh.ts            # SSH 传输源码
│   ├── targets.ts        # 目标存储源码
│   └── client.js         # 浏览器半部源码（ModuleLoader bundle，免打包器）
├── tsdown.config.ts      # 构建配置：src/ -> lib/（pnpm build）
├── tsconfig.json         # 类型检查配置（pnpm typecheck）
├── tsconfig.build.json   # 免打包器构建的 emit 配置（pnpm build:tsc）
├── pnpm-workspace.yaml   # 本地安装根 + 允许/忽略的构建脚本
├── package.json          # bundle 清单：dsh.bundle.patch、dsh.client、exports、deps
├── README.md             # 英文说明
├── README.zh.md          # 本文件（中文）
├── LICENSE               # Apache-2.0
└── .gitignore
```

## 构建

```bash
pnpm install
pnpm build        # tsdown：src/index.ts -> lib/index.js
pnpm build:tsc    # tsc 备选：产物相同，不需要原生打包器
pnpm typecheck   # tsc --noEmit
```

`lib/` 已提交，跳过构建的安装也能用。改 `src/` 后重建。

`pnpm build` 走 [tsdown](https://tsdown.dev)（rolldown）。如果你用的是 DSH 桌面应用内置的 Node 二进制，rolldown 的原生 binding 会被 macOS 库校验拒绝（`different Team IDs`），此时改用 `pnpm build:tsc`——它用纯 TypeScript 从 `src/index.ts` 产出同样的 `lib/index.js`。

> `lib/` 已提交，但插件的**运行时依赖没有**：`@deepseek-ai/schemastery` 与 `ssh2` 从本包自己的 `node_modules` 解析。请在该包目录跑一次 `pnpm install`，否则插件无法加载（`ssh2` 是懒加载，缺了只禁用 SSH 工具；`schemastery` 缺失会直接导致激活失败）。

## 兼容性

基于 DeepSeek Harness `0.1.7-rc.2`（Cordis `4.0.4`、schemastery `3.18.4`）编写测试。运行时依赖：`ssh2`（SSH 客户端）、`@deepseek-ai/schemastery`（配置 schema）、`@deepseek-ai/dsh-tools`（工具定义）。DSH 相关包同时声明在 `peerDependencies` 并钉在对应运行时版本上，这样运行时版本不匹配时插件管理器会拒绝安装，而不是加载后出错。`devDependencies` 里其余的 `@deepseek-ai/*` 仅用于类型检查与构建。

## 许可

Apache-2.0——见 [LICENSE](LICENSE)。

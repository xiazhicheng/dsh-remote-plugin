// Source of truth. Build to lib/ with `pnpm build` (tsdown) or `pnpm build:tsc`.
import z from '@deepseek-ai/schemastery';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { connectSsh, loadSsh2ClientCtor, sshExec, sshListDir, sshRead, sshWrite, testConnection, } from './ssh.js';
import { describeTarget, findTarget, loadStore, removeTarget, saveStore, slug, toSshConfig, upsertTarget, } from './targets.js';
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
        passwordEnv: z.string().default(''),
        remoteDir: z.string().default(''),
    }).default({}),
});
function resolveConfig(config) {
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
            passwordEnv: s.passwordEnv ?? '',
            remoteDir: s.remoteDir ?? '',
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
    if (signal.aborted)
        return Promise.resolve(false);
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
let defineToolFn = null;
let toolsFailed = false;
async function loadDefineTool() {
    if (defineToolFn)
        return defineToolFn;
    if (toolsFailed)
        return null;
    try {
        const mod = await import('@deepseek-ai/dsh-tools');
        defineToolFn = mod.defineTool;
        return defineToolFn;
    }
    catch {
        toolsFailed = true;
        return null;
    }
}
// ── Tool output helper ───────────────────────────────────────────────────────
function jsonOutput(schema) {
    return {
        schema: { ...schema, additionalProperties: false },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    };
}
const ROUTE_PREFIX = '/remote-ssh';
const MAX_BODY_BYTES = 64 * 1024;
function readJsonBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        req.on('data', (chunk) => {
            size += chunk.length;
            if (size > MAX_BODY_BYTES) {
                reject(new Error('request body too large'));
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8').trim();
            if (!text)
                return resolve({});
            try {
                const parsed = JSON.parse(text);
                resolve(typeof parsed === 'object' && parsed !== null ? parsed : {});
            }
            catch (e) {
                reject(e instanceof Error ? e : new Error(String(e)));
            }
        });
        req.on('error', reject);
    });
}
function sendJson(res, status, value) {
    const body = JSON.stringify(value);
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(body);
}
/**
 * Only the loopback GUI may drive SSH configuration. The desktop carrier binds
 * 127.0.0.1, so a request whose Host is not loopback, or whose Origin is not the
 * same origin, is treated as cross-site and refused.
 */
function sameOrigin(req) {
    const host = (req.headers.host ?? '').toLowerCase();
    const hostname = host.startsWith('[') ? host.slice(1, host.indexOf(']')) : host.split(':')[0];
    if (!(hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1'))
        return false;
    const origin = req.headers.origin;
    if (origin === undefined)
        return true;
    try {
        return new URL(origin).host.toLowerCase() === host;
    }
    catch {
        return false;
    }
}
// ── Plugin ───────────────────────────────────────────────────────────────────
export function apply(ctx, config = {}) {
    const resolved = resolveConfig(config);
    ctx.logger.info('retry-llm-plugin: activated (mode: %s, maxRetries: %d, default ssh: %s:%d)', resolved.mode, resolved.maxRetries, resolved.ssh.host, resolved.ssh.port);
    const random = Math.random;
    const lifetime = new AbortController();
    const active = new Set();
    const states = new WeakMap();
    const credentials = () => ctx.get?.('credentials');
    /** A stable environment-variable-shaped credential reference for one target. */
    function autoRef(id) {
        return `REMOTE_SSH_${id.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_PASSWORD`;
    }
    /**
     * Resolve the password for one target: a one-off password wins, then the
     * named reference through the credential service (process environment,
     * provider store, and .env files), then a plain environment lookup.
     */
    async function passwordFor(cfg) {
        if (cfg.password)
            return cfg.password;
        const ref = (cfg.passwordEnv ?? '').trim();
        if (!ref)
            return '';
        const store = credentials();
        if (store) {
            try {
                const resolved = await store.resolve(ref);
                if (resolved?.value)
                    return resolved.value;
            }
            catch { /* fall through to the environment */ }
        }
        return process.env[ref] ?? '';
    }
    /**
     * Read back the saved password of one target for the operator's own view.
     * The value only leaves the Host through the loopback, same-origin,
     * cookie-authenticated route below.
     */
    async function revealPassword(target) {
        const ref = (target.passwordEnv ?? '').trim();
        if (!ref)
            throw new Error('该目标没有保存密码（未设置密码引用）');
        const store = credentials();
        let value = '';
        let source = '';
        if (store) {
            try {
                const resolved = await store.resolve(ref);
                if (resolved?.value) {
                    value = resolved.value;
                    source = resolved.source ?? 'credential store';
                }
            }
            catch { /* fall through to the environment */ }
        }
        if (!value) {
            const fromEnv = process.env[ref];
            if (fromEnv) {
                value = fromEnv;
                source = 'process environment';
            }
        }
        if (!value)
            throw new Error(`凭据 ${ref} 未配置（既不在 DSH 凭据库，也不在环境变量里）`);
        return { password: value, ref, source };
    }
    /** Target views plus whether their named credential is configured. */
    async function describeAll(store) {
        const creds = credentials();
        return Promise.all(store.targets.map(async (target) => {
            const base = describeTarget(target);
            if (!target.passwordEnv || !creds)
                return { ...base, hasStoredPassword: false, passwordWritable: true };
            try {
                const info = await creds.describe(target.passwordEnv);
                return { ...base, hasStoredPassword: info.configured, passwordWritable: info.writable };
            }
            catch {
                return { ...base, hasStoredPassword: false, passwordWritable: true };
            }
        }));
    }
    // ── SSH connection pool (one live connection per target) ────────────────
    const connections = new Map();
    /** Whether the browser-facing HTTP route is registered (surfaced by `ssh-targets list`). */
    let routeRegistered = false;
    function connectionFor(key, cfg, password) {
        const existing = connections.get(key);
        if (existing)
            return existing;
        const pending = (async () => {
            const Ctor = await loadSsh2ClientCtor();
            if (!Ctor)
                throw new Error('ssh2 不可用：插件目录缺少 node_modules，请先在该目录运行 pnpm install');
            return connectSsh(Ctor, cfg, password);
        })();
        connections.set(key, pending);
        void pending.catch(() => {
            if (connections.get(key) === pending)
                connections.delete(key);
        });
        return pending;
    }
    function dropConnection(key) {
        const pending = connections.get(key);
        connections.delete(key);
        if (pending) {
            void pending.then((client) => { try {
                client.end();
            }
            catch { /* already closed */ } }, () => { });
        }
    }
    /** Which connection a call uses: an explicit target, else the default, else plugin config. */
    function resolveTarget(ref) {
        const store = loadStore();
        const wanted = (ref ?? '').trim() || store.defaultId;
        if (wanted) {
            const target = findTarget(store, wanted);
            if (!target) {
                const known = store.targets.map((t) => t.id).join(', ') || '(无)';
                throw new Error(`未知的 SSH 目标 "${wanted}"；已保存的目标：${known}`);
            }
            return { key: `target:${target.id}`, label: target.name, config: toSshConfig(target), store };
        }
        return { key: 'config', label: `${resolved.ssh.host}:${resolved.ssh.port}`, config: resolved.ssh, store };
    }
    async function withSshClient(ref, run) {
        const { key, config } = resolveTarget(ref);
        return withSshConfig(config, key, (client) => run(client, config));
    }
    /** Connect for an explicitly built configuration, reusing one connection per key. */
    async function withSshConfig(config, key, run) {
        try {
            return await run(await connectionFor(key, config, await passwordFor(config)));
        }
        catch (error) {
            dropConnection(key);
            throw error;
        }
    }
    /** One-off overrides on top of a target (or the plugin config), used by test/listDir. */
    function overrideConfig(base, input) {
        return {
            ...base,
            host: (input.host ?? base.host).trim() || base.host,
            port: Number.isFinite(input.port) ? Number(input.port) : base.port,
            username: input.username !== undefined ? String(input.username).trim() : base.username,
            identityFile: input.identityFile !== undefined ? String(input.identityFile).trim() : base.identityFile,
            passwordEnv: input.passwordEnv !== undefined ? String(input.passwordEnv).trim() : (base.passwordEnv ?? ''),
            password: typeof input.password === 'string' ? input.password : '',
            remoteDir: input.remoteDir !== undefined ? String(input.remoteDir).trim() : base.remoteDir,
        };
    }
    // ── Retry listener ───────────────────────────────────────────────────────
    function stepCounts(agent, turn, step) {
        let st = states.get(agent);
        if (!st || st.turn !== turn || st.step !== step) {
            st = { turn, step, counts: new Map() };
            states.set(agent, st);
        }
        return st.counts;
    }
    function decidesRetry(code) {
        if (resolved.excludeCodes.includes(code))
            return false;
        if (resolved.mode === 'always')
            return true;
        return resolved.retryableCodes.includes(code);
    }
    async function recover(payload, next) {
        const { agent, turn, step, provider, failure, signal } = payload;
        const fused = AbortSignal.any([signal, lifetime.signal]);
        if (fused.aborted)
            return next();
        if (!decidesRetry(failure.code))
            return next();
        const counts = stepCounts(agent, turn, step);
        const attempt = (counts.get(provider) ?? 0) + 1;
        if (resolved.mode === 'normal' && attempt > resolved.maxRetries)
            return next();
        let delayMs;
        const pra = failure.providerRetryAfterMs;
        if (resolved.respectProviderRetryAfter && pra !== undefined && Number.isFinite(pra) && pra > 0) {
            if (pra > resolved.backoff.maxDelayMs) {
                if (resolved.mode === 'normal')
                    return next();
                delayMs = localDelay(resolved.backoff, attempt, random);
            }
            else {
                delayMs = pra;
            }
        }
        else {
            delayMs = localDelay(resolved.backoff, attempt, random);
        }
        counts.set(provider, attempt);
        ctx.logger.info('retry-llm-plugin: provider "%s" %s retry #%d after %dms (code %s)', provider, resolved.mode, attempt, Math.round(delayMs), failure.code);
        const retryId = randomUUID();
        try {
            agent.session.append('llm/retry', {
                retryId, turn, step, provider,
                mode: resolved.mode, policyKey: 'retryBoost', retry: attempt, delayMs, failure,
            });
        }
        catch (e) {
            ctx.logger.warn('retry-llm-plugin: failed to append llm/retry event: %o', e);
        }
        if (!(await cancellableDelay(delayMs, fused)))
            return next();
        if (fused.aborted)
            return next();
        try {
            agent.session.append('llm/retry-started', { retryId, turn, step, retry: attempt });
        }
        catch (e) {
            ctx.logger.warn('retry-llm-plugin: failed to append llm/retry-started event: %o', e);
        }
        return { kind: 'retry' };
    }
    const disposeListener = ctx.on('agent/request-error', (payload, next) => {
        if (lifetime.signal.aborted)
            return Promise.resolve(undefined);
        const delegate = next ?? (() => Promise.resolve(undefined));
        const tracked = recover(payload, delegate);
        active.add(tracked);
        tracked.finally(() => active.delete(tracked));
        return tracked;
    });
    // ── SSH tool registration (per-agent, lazy) ──────────────────────────────
    const agentToolDisposers = new Map();
    async function registerSshTools(agent) {
        if (agentToolDisposers.has(agent))
            return;
        const defineTool = await loadDefineTool();
        if (!defineTool) {
            ctx.logger.warn('retry-llm-plugin: @deepseek-ai/dsh-tools unavailable, SSH tools disabled');
            return;
        }
        const targetParam = { type: 'string', description: '已保存的 SSH 目标 id 或名称；省略则用默认目标（再退回插件配置里的 ssh.*）。' };
        const disposers = [];
        try {
            disposers.push(agent.ctx.tools.register(defineTool({
                name: 'ssh-exec',
                description: 'Execute a shell command over SSH and return stdout, stderr, and exit code. Runs in the remote working directory of the selected target.',
                parameters: {
                    command: { type: 'string', required: true, description: 'Shell command to execute on the remote server.' },
                    timeoutMs: { type: 'number', description: 'Timeout in milliseconds. Defaults to 30000.' },
                    target: targetParam,
                },
                output: jsonOutput({ type: 'object', properties: { stdout: { type: 'string' }, stderr: { type: 'string' }, exitCode: { type: 'number' } } }),
                execute: (args) => withSshClient(args.target, (c, cfg) => sshExec(c, args.command, args.timeoutMs ?? 30000, cfg.remoteDir)),
            })));
            disposers.push(agent.ctx.tools.register(defineTool({
                name: 'ssh-read',
                description: 'Read a file over SSH (SFTP). Relative paths resolve against the target remote working directory.',
                parameters: {
                    path: { type: 'string', required: true, description: 'Remote file path to read.' },
                    target: targetParam,
                },
                output: jsonOutput({ type: 'object', properties: { content: { type: 'string' }, path: { type: 'string' } } }),
                execute: (args) => withSshClient(args.target, (c, cfg) => sshRead(c, args.path, cfg.remoteDir)),
            })));
            disposers.push(agent.ctx.tools.register(defineTool({
                name: 'ssh-write',
                description: 'Write a file over SSH (SFTP). Relative paths resolve against the target remote working directory.',
                parameters: {
                    path: { type: 'string', required: true, description: 'Remote file path to write.' },
                    content: { type: 'string', required: true, description: 'Content to write to the file.' },
                    target: targetParam,
                },
                output: jsonOutput({ type: 'object', properties: { success: { type: 'boolean' }, path: { type: 'string' } } }),
                execute: (args) => withSshClient(args.target, (c, cfg) => sshWrite(c, args.path, args.content, cfg.remoteDir)),
            })));
            disposers.push(agent.ctx.tools.register(defineTool({
                name: 'ssh-targets',
                description: 'Manage saved SSH development targets (the "remote workspaces" configured on the settings page): list them, test connectivity, save or update one, remove one, or choose the default.',
                parameters: {
                    action: { type: 'string', required: true, enum: ['list', 'test', 'save', 'remove', 'default', 'reveal', 'listDir'], description: 'Operation to perform. reveal returns a saved password in plaintext; listDir browses a remote directory.' },
                    path: { type: 'string', description: 'Remote directory to list (listDir); empty starts at the target remote directory, then $HOME.' },
                    target: { type: 'string', description: 'Target id or name: required for test/remove/default, optional for save (omit to create a new one).' },
                    name: { type: 'string', description: 'Display name (save).' },
                    host: { type: 'string', description: 'SSH hostname or IP (save).' },
                    port: { type: 'number', description: 'SSH port, default 22 (save).' },
                    username: { type: 'string', description: 'SSH username (save).' },
                    identityFile: { type: 'string', description: 'Private key path, ~ is expanded (save).' },
                    passwordEnv: { type: 'string', description: 'Credential reference (environment-variable name) for this target\'s password (save).' },
                    password: { type: 'string', description: 'Password for password auth: used by test, and stored in the DSH credential store on save (save/test).' },
                    remoteDir: { type: 'string', description: 'Remote working directory (save).' },
                },
                output: jsonOutput({ type: 'object', properties: { ok: { type: 'boolean' }, message: { type: 'string' } } }),
                execute: async (args) => {
                    const result = await sshTargetsAction(args);
                    const revealed = result.password;
                    const revealLine = revealed ? [`密码（${result.ref}，来源：${result.source}）：${revealed}`] : [];
                    const lines = result.targets.map((t) => `- ${t.id}${t.id === result.defaultId ? ' (默认)' : ''}  ${t.name} → ${t.username || '$USER'}@${t.host}:${t.port}${t.remoteDir ? `  dir=${t.remoteDir}` : ''}${t.identityFile ? `  key=${t.identityFile}` : ''}${t.passwordEnv ? `  passwordRef=${t.passwordEnv}${t.hasStoredPassword || t.hasPasswordEnv ? '' : '(未配置)'}` : ''}`);
                    return { ok: result.ok, message: [result.message, ...revealLine, ...lines].join('\n') };
                },
            })));
        }
        catch (e) {
            ctx.logger.warn('retry-llm-plugin: failed to register SSH tools for agent: %s', e instanceof Error ? e.message : String(e));
            for (const d of disposers)
                d();
            return;
        }
        agentToolDisposers.set(agent, disposers);
    }
    /** Whether the browser half is in the Host's client-module table (diagnostic). */
    function clientHalfStatus() {
        const table = ctx.get?.('clientModules');
        if (!table?.clientPath)
            return '不可用（当前组装没有 Web 载体）';
        const resolved = table.clientPath('dsh-remote-retry-llm-plugin');
        return resolved ? `已注册（${resolved}）` : '未注册：插件清单是在启动时扫描的，重启 DSH 后刷新页面即可';
    }
    /** Shared by the `ssh-targets` tool and the Remote UI routes. */
    async function sshTargetsAction(input) {
        const action = (input.action ?? 'list').trim();
        const store = loadStore();
        if (action === 'list') {
            return {
                ok: true,
                message: `共 ${store.targets.length} 个目标，默认：${store.defaultId || '(插件配置 ssh.*)'}；设置页（UI）半部：${clientHalfStatus()}；HTTP 路由：${routeRegistered ? `已注册（${ROUTE_PREFIX}）` : '未注册'}`,
                targets: await describeAll(store),
                defaultId: store.defaultId,
            };
        }
        if (action === 'test' || action === 'listDir') {
            // Same resolution as the exec tools: explicit target, else the default, else
            // plugin config — each field overridable for a one-off call.
            const ref = (input.target ?? '').trim() || store.defaultId;
            const target = ref ? findTarget(store, ref) : undefined;
            if (ref && !target)
                throw new Error(`未知的 SSH 目标 "${ref}"`);
            const base = target ? toSshConfig(target) : resolved.ssh;
            const cfg = overrideConfig(base, input);
            const key = target ? `target:${target.id}` : `cfg:${cfg.host}:${cfg.port}:${cfg.username}`;
            if (action === 'test') {
                const result = await testConnection(cfg, await passwordFor(cfg));
                return { ok: result.ok, message: result.message, targets: await describeAll(store), defaultId: store.defaultId };
            }
            const path = typeof input.path === 'string' ? String(input.path) : '';
            const listing = await withSshConfig(cfg, key, (client) => sshListDir(client, path, cfg.remoteDir));
            return { ok: true, message: listing.path, listing, targets: await describeAll(store), defaultId: store.defaultId };
        }
        if (action === 'reveal') {
            const ref = (input.target ?? '').trim();
            const target = ref ? findTarget(store, ref) : undefined;
            if (!target)
                throw new Error(`未知的 SSH 目标 "${ref}"`);
            const revealed = await revealPassword(target);
            return { ok: true, message: `目标 "${target.name}" 的密码（引用 ${revealed.ref}）`, ...revealed, targets: await describeAll(store), defaultId: store.defaultId };
        }
        if (action === 'save') {
            const password = typeof input.password === 'string' ? input.password : '';
            const name = (input.name ?? '').trim() || (input.host ?? '').trim();
            const editing = Boolean((input.id ?? '').trim() || (input.target ?? '').trim());
            let id = (input.id ?? '').trim() || slug(name);
            let reused = '';
            if (!editing) {
                // Re-saving the same connection updates that target instead of piling up
                // duplicates; a genuinely different connection mints a fresh identity so
                // "添加" can never overwrite an unrelated target.
                const host = (input.host ?? '').trim();
                const port = Number.isFinite(input.port) ? Number(input.port) : 22;
                const username = (input.username ?? '').trim();
                const identityFile = (input.identityFile ?? '').trim();
                const remoteDir = (input.remoteDir ?? '').trim();
                const twin = store.targets.find((t) => t.host === host && t.port === port
                    && t.username === username && t.identityFile === identityFile && t.remoteDir === remoteDir);
                if (twin) {
                    id = twin.id;
                    reused = `（与已有目标 "${twin.name}" 连接相同，已更新它）`;
                }
                else {
                    let candidate = id;
                    for (let n = 2; store.targets.some((t) => t.id === candidate); n += 1)
                        candidate = `${id}-${n}`;
                    id = candidate;
                }
            }
            // A password typed in the UI is stored under this target's credential
            // reference, so later ssh-exec calls can authenticate without it.
            const passwordEnv = (input.passwordEnv ?? '').trim() || (password ? autoRef(id) : '');
            const saved = upsertTarget(store, { ...input, id, passwordEnv });
            if (input.setDefault === true)
                store.defaultId = saved.id;
            saveStore(store);
            dropConnection(`target:${saved.id}`);
            let note = '';
            const creds = credentials();
            if (password && creds) {
                try {
                    await creds.set(passwordEnv, password);
                    note = `，密码已存入 DSH 凭据库（${passwordEnv}）`;
                }
                catch (e) {
                    note = `；密码未能存入凭据库（${e instanceof Error ? e.message : String(e)}），可改用环境变量 ${passwordEnv}`;
                }
            }
            else if (password) {
                note = `；凭据服务不可用，密码未保存（可改用环境变量 ${passwordEnv}）`;
            }
            const detail = [
                `${saved.username || '$USER'}@${saved.host}:${saved.port}`,
                saved.remoteDir ? `远程目录 ${saved.remoteDir}` : '远程目录未设置',
                saved.localDir ? `本地目录 ${saved.localDir}` : null,
                store.defaultId === saved.id ? '已设为默认' : null,
            ].filter((part) => part !== null).join('，');
            return { ok: true, message: `已保存目标 "${saved.name}"（${saved.id}）${reused}：${detail}${note}`, targets: await describeAll(store), defaultId: store.defaultId };
        }
        if (action === 'remove') {
            const ref = (input.target ?? '').trim();
            const target = ref ? findTarget(store, ref) : undefined;
            if (!target)
                throw new Error(`未知的 SSH 目标 "${ref}"`);
            removeTarget(store, target.id);
            saveStore(store);
            dropConnection(`target:${target.id}`);
            if (target.passwordEnv) {
                try {
                    await credentials()?.unset(target.passwordEnv);
                }
                catch { /* keep the deletion result */ }
            }
            return { ok: true, message: `已删除目标 "${target.name}"`, targets: await describeAll(store), defaultId: store.defaultId };
        }
        if (action === 'default') {
            const ref = (input.target ?? '').trim();
            const target = ref ? findTarget(store, ref) : undefined;
            if (!target)
                throw new Error(`未知的 SSH 目标 "${ref}"`);
            store.defaultId = target.id;
            saveStore(store);
            return { ok: true, message: `默认目标已设为 "${target.name}"`, targets: await describeAll(store), defaultId: store.defaultId };
        }
        throw new Error(`未知的 action "${action}"`);
    }
    const disposeAgentListener = ctx.on('agent/created', (payload) => {
        const agent = payload.agent;
        if (agent)
            void registerSshTools(agent);
    });
    const disposeAgentDisposeListener = ctx.on('agent/disposed', (payload) => {
        const agent = payload.agent;
        if (!agent)
            return;
        const disposers = agentToolDisposers.get(agent);
        if (disposers) {
            for (const d of disposers)
                d();
            agentToolDisposers.delete(agent);
        }
    });
    // Agents created before this plugin activated never emit `agent/created`, so
    // register their tools now — otherwise the current session goes without SSH.
    try {
        for (const agent of ctx.agents?.list?.() ?? [])
            void registerSshTools(agent);
    }
    catch (e) {
        ctx.logger.warn('retry-llm-plugin: failed to enumerate existing agents: %s', e instanceof Error ? e.message : String(e));
    }
    // ── Prompt context: the agent must know which remote host "the server" is ──
    /**
     * Runtime-context text listing the saved targets. Rendered per assembly, so a
     * target saved mid-session is visible to the very next model step. Returns an
     * empty string (contributing nothing) while no target exists.
     */
    function renderTargetsContext() {
        const store = loadStore();
        if (store.targets.length === 0)
            return '';
        const lines = store.targets.map((target) => {
            const isDefault = target.id === store.defaultId;
            const facts = [
                `${target.username || '$USER'}@${target.host}:${target.port}`,
                target.remoteDir ? `remote working directory ${target.remoteDir}` : null,
                target.identityFile ? `key ${target.identityFile}` : null,
                target.passwordEnv ? `password credential ${target.passwordEnv}` : null,
            ].filter((fact) => fact !== null).join(', ');
            return `- ${target.name}${isDefault ? ' (default)' : ''}: ${facts} [target "${target.id}"]`;
        });
        return [
            'Saved remote SSH workspaces. Use the ssh-exec, ssh-read and ssh-write tools for work on these hosts; omit `target` to use the default one.',
            ...lines,
            'Call the ssh-targets tool with action "default" to change the default, or action "list" to see them again.',
        ].join('\n');
    }
    const registerPromptContext = (scope) => {
        const systemPrompt = scope?.systemPrompt;
        if (typeof systemPrompt?.context !== 'function')
            return;
        try {
            const dispose = systemPrompt.context({ name: 'remote-ssh:targets', order: 130, text: renderTargetsContext });
            ctx.effect(() => () => dispose());
            ctx.logger.info('retry-llm-plugin: remote-workspace prompt context registered');
        }
        catch (e) {
            ctx.logger.warn('retry-llm-plugin: failed to register the prompt context: %s', e instanceof Error ? e.message : String(e));
        }
    };
    const injectService = ctx.inject;
    const immediateSystemPrompt = ctx.get?.('systemPrompt');
    if (immediateSystemPrompt)
        registerPromptContext({ systemPrompt: immediateSystemPrompt });
    else if (typeof injectService === 'function')
        injectService.call(ctx, ['systemPrompt'], (scope) => registerPromptContext(scope));
    // ── Remote UI routes (the "远程工作区" page talks to these) ───────────────
    const handler = async (req, res) => {
        try {
            if (!sameOrigin(req))
                return sendJson(res, 403, { ok: false, message: 'cross-origin request refused' });
            const url = new URL(req.url ?? '/', 'http://localhost');
            const route = url.pathname.slice(ROUTE_PREFIX.length) || '/';
            if (req.method === 'GET' && route === '/targets') {
                const store = loadStore();
                return sendJson(res, 200, { ok: true, defaultId: store.defaultId, homeDir: homedir(), targets: await describeAll(store) });
            }
            if (req.method === 'POST') {
                const body = await readJsonBody(req);
                if (route === '/targets')
                    return sendJson(res, 200, await sshTargetsAction({ ...body, action: 'save' }));
                if (route === '/targets/delete')
                    return sendJson(res, 200, await sshTargetsAction({ ...body, action: 'remove' }));
                if (route === '/default')
                    return sendJson(res, 200, await sshTargetsAction({ ...body, action: 'default' }));
                if (route === '/reveal')
                    return sendJson(res, 200, await sshTargetsAction({ ...body, action: 'reveal' }));
                if (route === '/list-dir')
                    return sendJson(res, 200, await sshTargetsAction({ ...body, action: 'listDir' }));
                // Reuse the tool action so the page and the agent share one resolution
                // path (explicit target → default → plugin config, plus per-field
                // overrides and credential resolution).
                if (route === '/test')
                    return sendJson(res, 200, await sshTargetsAction({ ...body, action: 'test' }));
            }
            return sendJson(res, 404, { ok: false, message: `unknown route ${route}` });
        }
        catch (e) {
            return sendJson(res, 500, { ok: false, message: e instanceof Error ? e.message : String(e) });
        }
    };
    /**
     * Register the browser route. `webServer` is provided by a sibling entry that
     * may activate after this plugin, so wait for the service the same way the
     * shipped client-modules carrier does: `ctx.inject([...], carrier)` runs now
     * when the service already exists and again when it appears.
     */
    const registerRoute = (carrier) => {
        const webServer = carrier.webServer ?? carrier;
        if (routeRegistered || typeof webServer?.register !== 'function')
            return;
        try {
            const dispose = webServer.register({ kind: 'prefix', path: ROUTE_PREFIX, handler });
            routeRegistered = true;
            ctx.effect(() => () => dispose());
            ctx.logger.info('retry-llm-plugin: remote-workspace route registered at %s', ROUTE_PREFIX);
        }
        catch (e) {
            ctx.logger.warn('retry-llm-plugin: failed to register the remote-workspace route: %s', e instanceof Error ? e.message : String(e));
        }
    };
    const carrierCtx = ctx;
    const immediateWebServer = ctx.get?.('webServer');
    if (immediateWebServer) {
        registerRoute(immediateWebServer);
    }
    else if (typeof carrierCtx.inject === 'function') {
        carrierCtx.inject(['webServer'], (webCtx) => registerRoute(webCtx));
    }
    else {
        ctx.logger.warn('retry-llm-plugin: webServer unavailable, the remote-workspace settings page cannot save targets');
    }
    // ── Disposal ─────────────────────────────────────────────────────────────
    ctx.effect(() => async () => {
        disposeListener();
        disposeAgentListener();
        disposeAgentDisposeListener();
        for (const disposers of agentToolDisposers.values()) {
            for (const d of disposers)
                d();
        }
        agentToolDisposers.clear();
        lifetime.abort(new Error('retry-llm-plugin disposed'));
        for (const pending of connections.values()) {
            const client = await pending.catch(() => null);
            if (client)
                client.end();
        }
        connections.clear();
        await Promise.allSettled([...active]);
    });
}

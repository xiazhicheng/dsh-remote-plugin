// Durable store of SSH targets ("remote workspaces") for this DSH profile.
// Targets hold no secrets: a target may name the environment variable that
// carries its password, but never the password itself.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
const EMPTY = { version: 1, defaultId: '', targets: [], bindings: {} };
/** Where this profile keeps its target list. */
export function storePath() {
    const base = process.env.DSH_PROFILE_DIR || process.env.DSH_HOME || join(homedir(), '.dsh');
    return join(base, 'remote-ssh-targets.json');
}
export function loadStore() {
    const file = storePath();
    if (!existsSync(file))
        return { ...EMPTY, targets: [] };
    try {
        const parsed = JSON.parse(readFileSync(file, 'utf8'));
        const targets = Array.isArray(parsed.targets) ? parsed.targets.filter(isTargetish).map(normalizeStored) : [];
        const raw = parsed.bindings;
        const bindings = {};
        if (typeof raw === 'object' && raw !== null) {
            for (const [dir, id] of Object.entries(raw)) {
                if (typeof id === 'string' && targets.some((t) => t.id === id))
                    bindings[dir] = id;
            }
        }
        return { version: 1, defaultId: typeof parsed.defaultId === 'string' ? parsed.defaultId : '', targets, bindings };
    }
    catch {
        return { ...EMPTY, targets: [] };
    }
}
function isTargetish(value) {
    return typeof value === 'object' && value !== null && typeof value.host === 'string';
}
function normalizeStored(value) {
    return {
        id: value.id || slug(value.name || value.host),
        name: value.name || value.host,
        host: value.host,
        port: Number.isFinite(value.port) ? Number(value.port) : 22,
        username: value.username ?? '',
        identityFile: value.identityFile ?? '',
        passwordEnv: value.passwordEnv ?? '',
        remoteDir: value.remoteDir ?? '',
        localDir: value.localDir ?? '',
        createdAt: value.createdAt || new Date().toISOString(),
        updatedAt: value.updatedAt || new Date().toISOString(),
    };
}
/** Write the store atomically with owner-only permissions. */
export function saveStore(store) {
    const file = storePath();
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, file);
}
export function slug(input) {
    const base = input.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
    return base || `target-${Date.now().toString(36)}`;
}
/** Create or update one target, returning the stored record. */
export function upsertTarget(store, input) {
    const host = (input.host ?? '').trim();
    if (!host)
        throw new Error('host 不能为空');
    const port = Number.isFinite(input.port) ? Number(input.port) : 22;
    if (!(port >= 1 && port <= 65535))
        throw new Error(`端口无效：${String(input.port)}`);
    const name = (input.name ?? '').trim() || host;
    const id = (input.id ?? '').trim() || slug(name);
    const now = new Date().toISOString();
    const existing = store.targets.find((t) => t.id === id);
    const next = {
        id,
        name,
        host,
        port,
        username: (input.username ?? '').trim(),
        identityFile: (input.identityFile ?? '').trim(),
        passwordEnv: (input.passwordEnv ?? '').trim(),
        remoteDir: (input.remoteDir ?? '').trim(),
        localDir: (input.localDir ?? '').trim(),
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
    };
    store.targets = existing
        ? store.targets.map((t) => (t.id === id ? next : t))
        : [...store.targets, next];
    if (!store.defaultId)
        store.defaultId = id;
    return next;
}
export function removeTarget(store, id) {
    const before = store.targets.length;
    store.targets = store.targets.filter((t) => t.id !== id);
    for (const [dir, bound] of Object.entries(store.bindings)) {
        if (bound === id)
            delete store.bindings[dir];
    }
    if (store.defaultId === id)
        store.defaultId = store.targets[0]?.id ?? '';
    return store.targets.length !== before;
}
/** Find a target by id or by display name (case-insensitive). */
export function findTarget(store, ref) {
    const key = ref.trim().toLowerCase();
    return store.targets.find((t) => t.id === ref) ?? store.targets.find((t) => t.name.toLowerCase() === key);
}
/** The target bound to one session workspace directory, when one is recorded. */
export function boundTarget(store, dir) {
    if (!dir)
        return undefined;
    const id = store.bindings[dir];
    return id === undefined ? undefined : store.targets.find((t) => t.id === id);
}
/** Record (or clear) the target a workspace directory opens. */
export function bindTarget(store, dir, id) {
    store.bindings[dir] = id;
}
/** Every workspace directory currently bound to one target. */
export function boundDirs(store, id) {
    return Object.entries(store.bindings).filter(([, bound]) => bound === id).map(([dir]) => dir);
}
/** Project a stored target onto the connection settings the SSH layer needs. */
export function toSshConfig(target) {
    return {
        host: target.host,
        port: target.port,
        username: target.username,
        identityFile: target.identityFile,
        password: '',
        passwordEnv: target.passwordEnv,
        remoteDir: target.remoteDir,
    };
}
/** Client-facing view: no secrets, plus whether a password source is configured. */
export function describeTarget(target) {
    return {
        id: target.id,
        name: target.name,
        host: target.host,
        port: target.port,
        username: target.username,
        identityFile: target.identityFile,
        passwordEnv: target.passwordEnv,
        hasPasswordEnv: target.passwordEnv !== '' && Boolean(process.env[target.passwordEnv]),
        remoteDir: target.remoteDir,
        localDir: target.localDir,
        createdAt: target.createdAt,
        updatedAt: target.updatedAt,
    };
}

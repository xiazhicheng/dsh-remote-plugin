// SSH transport: connection, command execution, SFTP read/write.
// Extracted from index.ts so the tool layer, the Remote-UI route layer, and the
// connectivity test all share one connection implementation.
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Connection settings for one SSH target (no secrets beyond an env var name). */
export interface SshConfig {
  host: string;
  port: number;
  username: string;
  identityFile: string;
  /** One-off password (Remote UI test only); never persisted by this plugin. */
  password: string;
  /** Name of the environment variable holding the password, when password auth is used. */
  passwordEnv?: string;
  remoteDir: string;
}

export interface SshStream {
  on(event: 'data', cb: (data: { toString(): string }) => void): void;
  on(event: 'close', cb: (code: number) => void): void;
  on(event: 'error', cb: (error: Error) => void): void;
  stderr: { on(event: 'data', cb: (data: { toString(): string }) => void): void };
}

export interface SftpLike {
  readFile(path: string, encoding: string, cb: (err: Error | undefined, content: Buffer | string) => void): void;
  writeFile(path: string, content: string, cb: (err: Error | undefined) => void): void;
}

export interface KeyboardInteractivePrompt {
  prompt: string;
  echo: boolean;
}

export interface SshClientLike {
  on(event: 'ready', cb: () => void): SshClientLike;
  on(event: 'error', cb: (error: Error) => void): SshClientLike;
  on(
    event: 'keyboard-interactive',
    cb: (
      name: string,
      instructions: string,
      lang: string,
      prompts: KeyboardInteractivePrompt[],
      finish: (responses: string[]) => void,
    ) => void,
  ): SshClientLike;
  connect(config: Record<string, unknown>): void;
  exec(command: string, cb: (err: Error | undefined, stream: SshStream) => void): void;
  sftp(cb: (err: Error | undefined, sftp: SftpLike) => void): void;
  end(): void;
}

export type SshClientCtor = new () => SshClientLike;

let ssh2ClientCtor: SshClientCtor | null = null;
let ssh2Failed = false;

/** Load `ssh2` once; a load failure is cached so tools degrade instead of retrying forever. */
export async function loadSsh2ClientCtor(): Promise<SshClientCtor | null> {
  if (ssh2ClientCtor) return ssh2ClientCtor;
  if (ssh2Failed) return null;
  try {
    const mod = (await import('ssh2')) as unknown as { Client: SshClientCtor };
    ssh2ClientCtor = mod.Client;
    return ssh2ClientCtor;
  } catch {
    ssh2Failed = true;
    return null;
  }
}

export function expandHome(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  return p;
}

/** Default private keys ssh(1) would try, in its preference order. */
function defaultIdentityFiles(): string[] {
  return ['id_ed25519', 'id_ecdsa', 'id_rsa'].map((f) => join(homedir(), '.ssh', f)).filter((p) => existsSync(p));
}

/**
 * Build the ssh2 connect options for one target.
 * @param cfg - resolved target settings.
 * @param password - already-resolved password (credential store, env, or a one-off); empty disables password auth.
 */
export function connectOptions(cfg: SshConfig, password: string): Record<string, unknown> {
  const options: Record<string, unknown> = {
    host: cfg.host,
    port: cfg.port,
    username: cfg.username || process.env.USER || process.env.LOGNAME || '',
    readyTimeout: 20000,
  };
  if (cfg.identityFile) {
    options.privateKey = readFileSync(expandHome(cfg.identityFile));
  } else if (password) {
    options.password = password;
    // Without this, ssh2 never offers keyboard-interactive and a PAM/AD server
    // answers "All configured authentication methods failed" even though ssh(1)
    // logs in with the same password.
    options.tryKeyboard = true;
  } else if (process.env.SSH_AUTH_SOCK) {
    options.agent = process.env.SSH_AUTH_SOCK;
  } else {
    const keys: Buffer[] = [];
    for (const p of defaultIdentityFiles()) {
      try {
        keys.push(readFileSync(p));
      } catch { /* unreadable key: let the next candidate try */ }
    }
    if (keys.length > 0) options.privateKey = keys;
  }
  return options;
}

/** Open one SSH connection and resolve once the handshake reports `ready`. */
export function connectSsh(Ctor: SshClientCtor, cfg: SshConfig, password = ''): Promise<SshClientLike> {
  return new Promise((resolve, reject) => {
    let options: Record<string, unknown>;
    try {
      options = connectOptions(cfg, password);
    } catch (e) {
      reject(e instanceof Error ? e : new Error(String(e)));
      return;
    }
    const client = new Ctor();
    let settled = false;
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      try { client.end(); } catch { /* the handshake never started */ }
      reject(error);
    };
    client.on('error', (error) => {
      // ssh2 reports every rejected method with one generic sentence; name what
      // was actually attempted so a credential problem is distinguishable from
      // a server that offers no method we support.
      const attempted: string[] = [];
      if (options.privateKey !== undefined) attempted.push('private key');
      if (typeof options.password === 'string') attempted.push('password', 'keyboard-interactive');
      if (options.agent !== undefined) attempted.push('ssh-agent');
      if (attempted.length === 0) attempted.push('ssh-agent', 'default keys');
      const hint = /authentication methods failed/i.test(error.message)
        ? `${error.message}（已尝试：${attempted.join('、')}；用户名 ${String(options.username)}）`
        : error.message;
      fail(new Error(hint));
    });
    if (password) {
      client.on('keyboard-interactive', (_name, _instructions, _lang, prompts, finish) => {
        finish(prompts.map(() => password));
      });
    }
    client.on('ready', () => {
      if (settled) return;
      settled = true;
      resolve(client);
    });
    try {
      client.connect(options);
    } catch (e) {
      fail(e instanceof Error ? e : new Error(String(e)));
    }
  });
}

/** Prove one target is reachable and authenticated, then disconnect. */
export async function testConnection(cfg: SshConfig, password = ''): Promise<{ ok: boolean; message: string }> {
  const Ctor = await loadSsh2ClientCtor();
  if (!Ctor) return { ok: false, message: 'ssh2 不可用（插件目录缺少 node_modules，请先 pnpm install）' };
  const started = Date.now();
  try {
    const client = await connectSsh(Ctor, cfg, password);
    const identifying = `${cfg.username || process.env.USER || ''}@${cfg.host}:${cfg.port}`;
    client.end();
    return { ok: true, message: `已连通 ${identifying}（${Date.now() - started}ms）` };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Resolve a tool-supplied path against the configured remote working directory. */
export function resolveRemotePath(remotePath: string, remoteDir: string): string {
  if (!remoteDir || remotePath.startsWith('/') || remotePath.startsWith('~')) return remotePath;
  return `${remoteDir.replace(/\/+$/, '')}/${remotePath}`;
}

/** Run the command from the configured remote working directory. */
export function withRemoteDir(command: string, remoteDir: string): string {
  if (!remoteDir) return command;
  return `cd ${shellQuote(remoteDir)} && ${command}`;
}

export function sshExec(client: SshClientLike, command: string, timeoutMs: number, remoteDir: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      client.end();
      reject(new Error(`ssh-exec timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    client.exec(withRemoteDir(command, remoteDir), (err, stream) => {
      if (err) { clearTimeout(timer); if (!settled) { settled = true; reject(err); } return; }
      let stdout = '', stderr = '';
      stream.on('data', (d) => { stdout += d.toString(); });
      stream.stderr.on('data', (d) => { stderr += d.toString(); });
      // ssh2 streams close with an exit-code 'close' event carrying the code
      stream.on('close', (code) => { clearTimeout(timer); if (settled) return; settled = true; resolve({ stdout, stderr, exitCode: code }); });
      stream.on('error', (e) => { clearTimeout(timer); if (settled) return; settled = true; reject(e); });
    });
  });
}

export function sshRead(client: SshClientLike, remotePath: string, remoteDir: string): Promise<{ content: string; path: string }> {
  const target = resolveRemotePath(remotePath, remoteDir);
  return new Promise((resolve, reject) => {
    client.sftp((err, sftp) => {
      if (err) return reject(err);
      sftp.readFile(target, 'utf8', (err, content) => {
        if (err) return reject(err);
        resolve({ content: typeof content === 'string' ? content : content.toString('utf8'), path: target });
      });
    });
  });
}

export function sshWrite(client: SshClientLike, remotePath: string, content: string, remoteDir: string): Promise<{ success: boolean; path: string }> {
  const target = resolveRemotePath(remotePath, remoteDir);
  return new Promise((resolve, reject) => {
    client.sftp((err, sftp) => {
      if (err) return reject(err);
      sftp.writeFile(target, content, (err) => {
        if (err) return reject(err);
        resolve({ success: true, path: target });
      });
    });
  });
}

// ── Remote directory browsing ────────────────────────────────────────────────

export interface RemoteDirEntry {
  name: string;
  dir: boolean;
}

export interface RemoteDirListing {
  /** Absolute path the listing resolved to. */
  path: string;
  /** Parent directory, or the path itself at the root. */
  parent: string;
  entries: RemoteDirEntry[];
}

/** Quote one path for `sh`, expanding a leading `~` the way a shell would. */
function cdTarget(path: string): string {
  const trimmed = path.trim();
  if (trimmed === '' || trimmed === '~' || trimmed === '$HOME') return '"$HOME"';
  if (trimmed.startsWith('~/')) return `"$HOME"/${shellQuote(trimmed.slice(2))}`;
  return shellQuote(trimmed);
}

function parentOf(path: string): string {
  const trimmed = path.replace(/\/+$/, '');
  if (trimmed === '' || trimmed === '/') return '/';
  const cut = trimmed.slice(0, trimmed.lastIndexOf('/'));
  return cut === '' ? '/' : cut;
}

/**
 * List one remote directory over the existing exec channel. `ls -A1p` marks
 * directories with a trailing slash, which keeps parsing trivial and needs no
 * SFTP negotiation.
 * @param client - connected SSH client.
 * @param dir - directory to list; empty starts from `remoteDir`, then `$HOME`.
 * @param remoteDir - the target's configured working directory.
 * @returns the resolved path, its parent, and its entries (directories first).
 */
export async function sshListDir(client: SshClientLike, dir: string, remoteDir: string): Promise<RemoteDirListing> {
  const start = dir.trim() !== '' ? dir : (remoteDir.trim() !== '' ? remoteDir : '$HOME');
  const script = `cd ${cdTarget(start)} 2>/dev/null || exit 9; printf '%s\\n' "$PWD"; ls -A1p`;
  const { stdout, stderr, exitCode } = await sshExec(client, script, 15000, '');
  if (exitCode !== 0) {
    throw new Error(stderr.trim() || `无法进入目录 ${start}（exit ${exitCode}）`);
  }
  const lines = stdout.split('\n').map((line) => line.replace(/\r$/, ''));
  const path = (lines.shift() ?? '').trim();
  const entries = lines
    .filter((line) => line !== '')
    .map((line) => ({ name: line.replace(/\/+$/, ''), dir: line.endsWith('/') }))
    .filter((entry) => entry.name !== '' && entry.name !== '.' && entry.name !== '..')
    .sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
  return { path, parent: parentOf(path), entries };
}

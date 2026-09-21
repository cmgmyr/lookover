import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

import { dbPath, ensureHome, resolveHome, serveDir } from '../home.ts';
import { projectIdentity } from '../identity.ts';
import { createServer } from '../server.ts';
import { CliError } from '../session.ts';
import { openStore } from '../store.ts';

export function runServe(argv: string[]): number {
  const { values } = parseArgs({
    args: argv,
    strict: true,
    options: {
      host: { type: 'string' },
      port: { type: 'string' },
      token: { type: 'string' },
      'no-replace': { type: 'boolean' },
    },
  });
  const host = values.host ?? '127.0.0.1';
  const port = parsePort(values.port);
  const token = values.token;
  const replace = values['no-replace'] !== true;
  if (!isLoopback(host) && token === undefined) {
    throw new CliError('refusing non-loopback host without --token (this would expose an upload endpoint on the Wi-Fi)');
  }

  const home = ensureHome(resolveHome(process.env, process.cwd()));
  const pidPath = join(serveDir(home), `${port}.pid`);
  if (replace && port !== 0) replaceExisting(pidPath, port);
  const store = openStore(dbPath(home));
  const identity = projectIdentity(process.cwd());
  const selected = store.findProject(identity.identity);
  const server = createServer(store, { token, home, defaultProject: selected?.slug });
  let activePidPath = pidPath;
  const close = (): void => {
    removePid(activePidPath);
    store.close();
    server.close();
  };
  process.once('SIGINT', close);
  process.once('SIGTERM', close);
  server.listen(port, host, () => {
    const address = server.address();
    const actualPort = typeof address === 'object' && address !== null ? address.port : port;
    const actualPidPath = port === 0 ? join(serveDir(home), `${actualPort}.pid`) : pidPath;
    activePidPath = actualPidPath;
    writeFileSync(actualPidPath, `${process.pid}\n${Date.now()}\n`, { encoding: 'utf8', mode: 0o600 });
    process.stdout.write(`lookover: http://${host}:${actualPort}${token === undefined ? '' : `?t=${encodeURIComponent(token)}`}${selected === undefined ? '' : ` (${selected.slug})`}\n`);
  });
  server.once('error', (error: NodeJS.ErrnoException) => {
    removePid(pidPath);
    store.close();
    const holder = error.code === 'EADDRINUSE' ? listenerDescription(port) : undefined;
    process.stderr.write(`lookover: ${holder === undefined ? error.message : `port ${port} is already in use by ${holder}`}\n`);
    process.exitCode = 1;
  });
  return 0;
}

function replaceExisting(pidPath: string, port: number): void {
  if (!existsSync(pidPath)) return;
  const lines = readFileSync(pidPath, 'utf8').split('\n');
  const pid = Number.parseInt(lines[0] ?? '', 10);
  const startedAt = Number.parseInt(lines[1] ?? '', 10);
  if (!Number.isInteger(pid) || pid <= 0 || !Number.isInteger(startedAt)) {
    unlinkPid(pidPath);
    return;
  }
  const command = process.platform === 'win32' ? undefined : processCommand(pid);
  if (command === undefined || !command.includes('lookover') || !command.includes('serve') || !startedAtMatches(pid, startedAt) || !isPortListener(pid, port)) {
    unlinkPid(pidPath);
    return;
  }
  try { process.kill(pid, 'SIGTERM'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
  const deadline = Date.now() + 2000;
  while (hasListener(port) && Date.now() < deadline) sleep(25);
  if (hasListener(port)) throw new CliError(`timed out replacing lookover serve (pid ${pid}) on port ${port}`);
  unlinkPid(pidPath);
  process.stdout.write(`replaced lookover serve (pid ${pid}) on port ${port}\n`);
}

function processCommand(pid: number): string | undefined {
  try { return execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { return undefined; }
}

function startedAtMatches(pid: number, expected: number): boolean {
  try {
    const started = Date.parse(execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim());
    return Number.isFinite(started) && Math.abs(started - expected) < 5000;
  } catch {
    return false;
  }
}

function isPortListener(pid: number, port: number): boolean {
  try {
    const pids = execFileSync('lsof', ['-t', '-nP', `-iTCP:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().split('\n');
    return pids.includes(String(pid));
  } catch {
    return false;
  }
}

function listenerDescription(port: number): string | undefined {
  try {
    const output = execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fpc'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const pid = /^p(\d+)$/m.exec(output)?.[1];
    const command = /^c(.+)$/m.exec(output)?.[1];
    if (pid === undefined) return undefined;
    return command === undefined ? `pid ${pid}` : `pid ${pid} (${command})`;
  } catch { return undefined; }
}

function hasListener(port: number): boolean {
  try { return execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fpc'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() !== ''; }
  catch { return false; }
}

function removePid(pidPath: string): void {
  try {
    if (Number.parseInt(readFileSync(pidPath, 'utf8').split('\n', 1)[0] ?? '', 10) === process.pid) unlinkSync(pidPath);
  } catch { }
}

function unlinkPid(pidPath: string): void {
  try { unlinkSync(pidPath); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

function sleep(milliseconds: number): void {
  const shared = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(shared), 0, 0, milliseconds);
}

function parsePort(raw: string | undefined): number {
  if (raw === undefined) return 8123;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new CliError(`--port must be an integer from 0 to 65535, not '${raw}'`);
  }
  return port;
}

function isLoopback(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

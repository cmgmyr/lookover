import { mkdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

export const STORE_DIR = '.lookover';
export const DB_FILE = 'queue.sqlite';
export const FILES_DIR = 'files';
export const SERVE_DIR = 'serve';

/**
 * $LOOKOVER_HOME, else the nearest .lookover/ walking up from cwd, else
 * $XDG_CONFIG_HOME/lookover, else ~/.config/lookover.
 */
export function resolveHome(env: NodeJS.ProcessEnv, cwd: string): string {
  const explicit = env['LOOKOVER_HOME'];
  if (explicit !== undefined && explicit.trim() !== '') {
    return resolve(cwd, explicit);
  }

  const local = findLocalStore(resolve(cwd));
  if (local !== undefined) {
    return local;
  }

  const xdg = env['XDG_CONFIG_HOME'];
  if (xdg !== undefined && xdg.trim() !== '') {
    return resolve(xdg, 'lookover');
  }

  return resolve(env['HOME'] ?? homedir(), '.config', 'lookover');
}

/** The first .lookover/ at or above `from`, so a nearer store beats a parent's. */
export function findLocalStore(from: string): string | undefined {
  let dir = resolve(from);

  for (;;) {
    const candidate = join(dir, STORE_DIR);
    if (isDirectory(candidate)) {
      return candidate;
    }

    const parent = dirname(dir);
    if (parent === dir) {
      return undefined;
    }
    dir = parent;
  }
}

export function ensureHome(home: string): string {
  mkdirSync(join(home, FILES_DIR), { recursive: true });
  return home;
}

export function serveDir(home: string): string {
  const dir = join(home, SERVE_DIR);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function dbPath(home: string): string {
  return join(home, DB_FILE);
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

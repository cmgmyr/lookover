import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readlinkSync, rmSync, symlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CliError } from './session.ts';

export type SkillInstallTarget = 'agents' | 'claude' | 'project';

export function skillSourceDir(): string {
  let directory = dirname(fileURLToPath(import.meta.url));
  while (!existsSync(join(directory, 'package.json'))) {
    const parent = dirname(directory);
    if (parent === directory) throw new Error('could not find package root');
    directory = parent;
  }
  return resolve(directory, 'skills', 'lookover');
}

export function installTarget(
  to: SkillInstallTarget = 'agents',
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): string {
  if (to === 'project') {
    let root = cwd;
    try {
      root = execFileSync('git', ['rev-parse', '--show-toplevel'], {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
    } catch {
      root = cwd;
    }
    return resolve(root, '.claude', 'skills', 'lookover');
  }

  const home = env['HOME'] ?? homedir();
  return resolve(home, to === 'claude' ? '.claude' : '.agents', 'skills', 'lookover');
}

export function installSkill(options: {
  to?: SkillInstallTarget;
  force?: boolean;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
} = {}): 'installed' | 'already' {
  const source = resolve(skillSourceDir());
  const target = installTarget(options.to, options.env, options.cwd);
  const parent = dirname(target);

  if (existsSync(target) || isSymlink(target)) {
    const stat = lstatSync(target);
    if (stat.isSymbolicLink()) {
      const linked = resolve(parent, readlinkSync(target));
      if (linked === source) return 'already';
      if (options.force !== true) {
        throw new CliError(`skill target already exists and points elsewhere: ${target}`);
      }
      rmSync(target);
    } else {
      throw new CliError(`skill target already exists: ${target}`);
    }
  }

  mkdirSync(parent, { recursive: true });
  symlinkSync(source, target, 'dir');
  return 'installed';
}

function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

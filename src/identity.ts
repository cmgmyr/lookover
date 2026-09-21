import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';

export type IdentityKind = 'git' | 'remote' | 'path';

export interface ProjectIdentity {
  identity: string;
  kind: IdentityKind;
  root: string;
}

export type GitRunner = (args: string[], cwd: string) => string | undefined;

export const runGit: GitRunner = (args, cwd) => {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0 || typeof result.stdout !== 'string') {
    return undefined;
  }

  const output = result.stdout.trim();
  return output === '' ? undefined : output;
};

/**
 * A project is its git common dir, so a card filed from a worktree lands on
 * the same project as one filed from the main checkout.
 */
export function projectIdentity(cwd: string, git: GitRunner = runGit): ProjectIdentity {
  const here = realpath(cwd);
  const toplevel = git(['rev-parse', '--show-toplevel'], here);
  const root = toplevel === undefined ? here : realpath(toplevel);

  // `--git-common-dir` answers relative to cwd in the main checkout and
  // absolute in a linked worktree; resolve+realpath makes the two agree.
  const commonDir = git(['rev-parse', '--git-common-dir'], here);
  if (commonDir !== undefined) {
    return { identity: realpath(resolve(here, commonDir)), kind: 'git', root };
  }

  const remote = git(['remote', 'get-url', 'origin'], here);
  if (remote !== undefined) {
    return { identity: remote, kind: 'remote', root };
  }

  return { identity: here, kind: 'path', root };
}

function realpath(path: string): string {
  try {
    return realpathSync(resolve(path));
  } catch {
    return resolve(path);
  }
}

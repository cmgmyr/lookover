import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { projectIdentity, type GitRunner } from './identity.ts';

function sandbox(t: { after: (fn: () => void) => void }): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'lookover-identity-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=Test', ...args], {
    cwd,
    stdio: 'ignore',
  });
}

function repoWithWorktree(dir: string): { repo: string; worktree: string } {
  const repo = join(dir, 'repo');
  mkdirSync(repo, { recursive: true });
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'commit', '-q', '--allow-empty', '--no-gpg-sign', '-m', 'root');
  git(repo, 'worktree', 'add', '-q', join(dir, 'wt'), '-b', 'lane');

  return { repo, worktree: join(dir, 'wt') };
}

test('projectIdentity of a git worktree equals the identity of its main checkout', (t) => {
  const { repo, worktree } = repoWithWorktree(sandbox(t));

  const main = projectIdentity(repo);
  const linked = projectIdentity(worktree);

  assert.equal(linked.identity, main.identity);
  assert.equal(linked.kind, 'git');
  assert.equal(main.kind, 'git');
});

test('projectIdentity of a nested subdirectory equals the identity of the repo root', (t) => {
  const { repo } = repoWithWorktree(sandbox(t));
  const deep = join(repo, 'src', 'commands');
  mkdirSync(deep, { recursive: true });

  // `git rev-parse --git-common-dir` answers "../../.git" here, so this fails
  // if the relative answer is not resolved against cwd.
  assert.equal(projectIdentity(deep).identity, projectIdentity(repo).identity);
});

test('projectIdentity reports the worktree as the root while sharing the identity', (t) => {
  const { repo, worktree } = repoWithWorktree(sandbox(t));

  assert.equal(projectIdentity(repo).root, repo);
  assert.equal(projectIdentity(worktree).root, worktree);
});

test('projectIdentity falls back to the origin remote when git has no common dir', () => {
  const fake: GitRunner = (args) => {
    if (args[0] === 'remote') return 'git@github.com:cmgmyr/lookover.git';
    return undefined;
  };

  const identity = projectIdentity('/nowhere/in/particular', fake);

  assert.equal(identity.identity, 'git@github.com:cmgmyr/lookover.git');
  assert.equal(identity.kind, 'remote');
});

test('projectIdentity falls back to the absolute path when git answers nothing', () => {
  const identity = projectIdentity('/nowhere/in/particular', () => undefined);

  assert.equal(identity.identity, '/nowhere/in/particular');
  assert.equal(identity.kind, 'path');
  assert.equal(identity.root, '/nowhere/in/particular');
});

test('projectIdentity outside any git repository uses the real path', (t) => {
  const dir = sandbox(t);

  const identity = projectIdentity(dir);

  assert.equal(identity.kind, 'path');
  assert.equal(identity.identity, dir);
});

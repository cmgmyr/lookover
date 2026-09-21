import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const BIN = fileURLToPath(new URL('../bin/lookover.ts', import.meta.url));

function box(t: { after: (fn: () => void) => void }): { dir: string; home: string } {
  const dir = mkdtempSync(join(tmpdir(), 'lookover-skill-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, home: join(dir, 'home') };
}

function run(home: string, cwd: string, args: string[]) {
  return spawnSync(process.execPath, [BIN, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, HOME: home, LOOKOVER_HOME: '' },
  });
}

test('skill path prints an absolute directory containing SKILL.md', () => {
  const result = spawnSync(process.execPath, [BIN, 'skill', 'path'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const path = result.stdout.trim();
  assert.equal(resolve(path), path);
  assert.match(readFileSync(join(path, 'SKILL.md'), 'utf8'), /^---\nname: lookover/m);
});

test('skill install creates an absolute symlink and is idempotent', (t) => {
  const { dir, home } = box(t);
  const target = join(home, '.agents', 'skills', 'lookover');

  const first = run(home, dir, ['skill', 'install']);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(first.stdout.trim(), `installed ${target}`);
  assert.equal(lstatSync(target).isSymbolicLink(), true);
  assert.equal(resolve(readlinkSync(target)), resolve(join(process.cwd(), 'skills', 'lookover')));

  const second = run(home, dir, ['skill', 'install']);
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /^already installed /);
});

test('skill install refuses an existing file and a symlink to another directory', (t) => {
  const { dir, home } = box(t);
  const target = join(home, '.agents', 'skills', 'lookover');
  mkdirSync(join(home, '.agents', 'skills'), { recursive: true });
  writeFileSync(target, 'keep me');
  const file = run(home, dir, ['skill', 'install']);
  assert.equal(file.status, 1);
  assert.match(file.stderr, new RegExp(target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

  rmSync(target);
  const elsewhere = join(dir, 'elsewhere');
  mkdirSync(elsewhere);
  execFileSync('ln', ['-s', elsewhere, target]);
  const link = run(home, dir, ['skill', 'install']);
  assert.equal(link.status, 1);
  assert.match(link.stderr, /points elsewhere/);

  const forced = run(home, dir, ['skill', 'install', '--force']);
  assert.equal(forced.status, 0, forced.stderr);
  assert.equal(lstatSync(target).isSymbolicLink(), true);
  assert.notEqual(readlinkSync(target), elsewhere);
});

test('skill install targets the project git toplevel when requested', (t) => {
  const { dir, home } = box(t);
  const repo = join(dir, 'repo');
  const nested = join(repo, 'nested');
  mkdirSync(nested, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
  const result = run(home, nested, ['skill', 'install', '--to', 'project']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(lstatSync(join(repo, '.claude', 'skills', 'lookover')).isSymbolicLink(), true);
});

test('skill install --to claude uses the Claude skills directory', (t) => {
  const { dir, home } = box(t);
  const result = run(home, dir, ['skill', 'install', '--to', 'claude']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(lstatSync(join(home, '.claude', 'skills', 'lookover')).isSymbolicLink(), true);
});

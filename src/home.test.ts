import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { ensureHome, findLocalStore, resolveHome } from './home.ts';

function sandbox(t: { after: (fn: () => void) => void }): string {
  const dir = mkdtempSync(join(tmpdir(), 'lookover-home-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('resolveHome prefers LOOKOVER_HOME over a local store and over XDG', (t) => {
  const dir = sandbox(t);
  mkdirSync(join(dir, 'repo', '.lookover'), { recursive: true });

  const home = resolveHome(
    { LOOKOVER_HOME: join(dir, 'explicit'), XDG_CONFIG_HOME: join(dir, 'xdg'), HOME: dir },
    join(dir, 'repo'),
  );

  assert.equal(home, join(dir, 'explicit'));
});

test('resolveHome resolves a relative LOOKOVER_HOME against the working directory', (t) => {
  const dir = sandbox(t);

  assert.equal(resolveHome({ LOOKOVER_HOME: './store' }, dir), join(dir, 'store'));
});

test('resolveHome ignores an empty LOOKOVER_HOME and carries on down the order', (t) => {
  const dir = sandbox(t);

  assert.equal(
    resolveHome({ LOOKOVER_HOME: '   ', XDG_CONFIG_HOME: join(dir, 'xdg') }, dir),
    join(dir, 'xdg', 'lookover'),
  );
});

test('resolveHome walks up from a nested directory to find a local store', (t) => {
  const dir = sandbox(t);
  mkdirSync(join(dir, 'repo', '.lookover'), { recursive: true });
  mkdirSync(join(dir, 'repo', 'src', 'deep'), { recursive: true });

  assert.equal(
    resolveHome({ HOME: dir }, join(dir, 'repo', 'src', 'deep')),
    join(dir, 'repo', '.lookover'),
  );
});

test('resolveHome picks the nearest local store when an ancestor also has one', (t) => {
  const dir = sandbox(t);
  mkdirSync(join(dir, 'outer', '.lookover'), { recursive: true });
  mkdirSync(join(dir, 'outer', 'inner', '.lookover'), { recursive: true });
  mkdirSync(join(dir, 'outer', 'inner', 'src'), { recursive: true });

  assert.equal(
    resolveHome({ HOME: dir }, join(dir, 'outer', 'inner', 'src')),
    join(dir, 'outer', 'inner', '.lookover'),
  );
});

test('resolveHome falls back to XDG_CONFIG_HOME when no local store exists above cwd', (t) => {
  const dir = sandbox(t);

  assert.equal(
    resolveHome({ XDG_CONFIG_HOME: join(dir, 'xdg'), HOME: dir }, dir),
    join(dir, 'xdg', 'lookover'),
  );
});

test('resolveHome falls back to HOME/.config/lookover when XDG_CONFIG_HOME is unset', (t) => {
  const dir = sandbox(t);

  assert.equal(resolveHome({ HOME: dir }, dir), join(dir, '.config', 'lookover'));
});

test('findLocalStore ignores a .lookover that is a file rather than a directory', (t) => {
  const dir = sandbox(t);
  mkdirSync(join(dir, 'repo'), { recursive: true });
  writeFileSync(join(dir, 'repo', '.lookover'), 'not a store');

  assert.equal(findLocalStore(join(dir, 'repo')), undefined);
});

test('ensureHome creates the store directory and its files subdirectory', (t) => {
  const dir = sandbox(t);
  const home = join(dir, 'nested', 'store');

  ensureHome(home);

  assert.ok(existsSync(home));
  assert.ok(existsSync(join(home, 'files')));
});

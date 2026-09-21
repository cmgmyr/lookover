import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

test('the packed tarball runs from node_modules', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'lookover-package-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));

  const consumer = join(directory, 'consumer');
  mkdirSync(consumer);
  writeFileSync(join(consumer, 'package.json'), '{"name":"lookover-pack-test","private":true}\n');
  const packageRoot = dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
  const npm = process.env['npm_execpath'] ?? 'npm';
  execFileSync(npm, ['pack', '--pack-destination', directory], {
    cwd: packageRoot,
    stdio: 'pipe',
  });
  const tarball = readdirSync(directory).find((name) => name.endsWith('.tgz'));
  assert.ok(tarball !== undefined, 'npm pack did not create a tarball');

  execFileSync(npm, ['install', '--no-audit', '--no-fund', join(directory, tarball), '--prefix', consumer], {
    cwd: directory,
    stdio: 'pipe',
  });
  const bin = join(consumer, 'node_modules', '.bin', 'lookover');
  const env = { ...process.env, LOOKOVER_HOME: join(directory, 'home') };
  const help = execFileSync(bin, ['--help'], { cwd: consumer, encoding: 'utf8', env });
  assert.match(help, /serve/);

  const skillPath = execFileSync(bin, ['skill', 'path'], { cwd: consumer, encoding: 'utf8', env }).trim();
  assert.match(skillPath, /skills[\\/]lookover$/);
  assert.equal(existsSync(join(skillPath, 'SKILL.md')), true);
});

import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const BIN = fileURLToPath(new URL('../bin/lookover.ts', import.meta.url));
const ROUNDS = 10;
const RACERS = 4;
const ACCENT_ROUNDS = 30;

interface Finished {
  status: number | null;
  stderr: string;
}

function runInit(cwd: string, home: string, name: string): Promise<Finished> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, 'init', '--name', name], {
      cwd,
      env: { ...process.env, LOOKOVER_HOME: home },
      stdio: ['ignore', 'ignore', 'pipe'],
    });

    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('close', (status) => resolve({ status, stderr }));
  });
}

test('two lookover init processes racing a brand-new store both exit 0', async (t) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'lookover-race-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const repo = join(dir, 'repo');
  mkdirSync(repo, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo, stdio: 'ignore' });

  for (let round = 0; round < ROUNDS; round += 1) {
    // A FRESH home each round: the race only exists while the database file
    // does not yet exist, so reusing one home would test nothing after round 1.
    const home = join(dir, `home-${round}`);

    const [first, second] = await Promise.all([
      runInit(repo, home, 'Racer'),
      runInit(repo, home, 'Racer'),
    ]);

    assert.equal(first?.status, 0, `round ${round} first: ${first?.stderr}`);
    assert.equal(second?.status, 0, `round ${round} second: ${second?.stderr}`);
  }
});

// The shape that MEASURED the defect: four inits, four DIFFERENT repos, one
// store. Vacuous at one racer, and vacuous with a shared repo — the racers
// would then resolve to one identity and never both insert. It was 10 losses
// in 30 rounds before the derivation moved inside the transaction, so a
// single round would miss it two times in three; 30 is what makes a pass mean
// something.
test('four lookover init processes registering different projects never share an accent', async (t) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'lookover-accent-race-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const repos = Array.from({ length: RACERS }, (_unused, index) => {
    const repo = join(dir, `repo-${index}`);
    mkdirSync(repo, { recursive: true });
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo, stdio: 'ignore' });
    return repo;
  });

  for (let round = 0; round < ACCENT_ROUNDS; round += 1) {
    const home = join(dir, `home-${round}`);

    const finished = await Promise.all(
      repos.map((repo, index) => runInit(repo, home, `Racer ${round}-${index}`)),
    );
    for (const [index, result] of finished.entries()) {
      assert.equal(result?.status, 0, `round ${round} racer ${index}: ${result?.stderr}`);
    }

    const db = new DatabaseSync(join(home, 'queue.sqlite'));
    const accents = db.prepare('SELECT accent FROM projects').all().map((row) => String((row as Record<string, unknown>)['accent']));
    db.close();

    assert.equal(accents.length, RACERS, `round ${round} registered ${accents.length} projects`);
    assert.equal(new Set(accents).size, RACERS, `round ${round} shared an accent: ${accents.join(' ')}`);
  }
});

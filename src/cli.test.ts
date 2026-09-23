import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { createServer as createNetServer } from 'node:net';

import { storeImage } from './files.ts';
import { openStore } from './store.ts';

const BIN = fileURLToPath(new URL('../bin/lookover.ts', import.meta.url));

interface Run {
  status: number;
  stdout: string;
  stderr: string;
}

interface Sandbox {
  home: string;
  repo: string;
  worktree: string;
  dir: string;
}

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=Test', ...args], {
    cwd,
    stdio: 'ignore',
  });
}

function sandbox(t: { after: (fn: () => void) => void }): Sandbox {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'lookover-cli-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const repo = join(dir, 'repo');
  mkdirSync(repo, { recursive: true });
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'commit', '-q', '--allow-empty', '--no-gpg-sign', '-m', 'root');
  git(repo, 'worktree', 'add', '-q', join(dir, 'wt'), '-b', 'lane');

  return { dir, repo, worktree: join(dir, 'wt'), home: join(dir, 'home') };
}

function run(box: Sandbox, args: string[], options: { cwd?: string } = {}): Run {
  const result = spawnSync(process.execPath, [BIN, ...args], {
    cwd: options.cwd ?? box.repo,
    encoding: 'utf8',
    env: { ...process.env, LOOKOVER_HOME: box.home },
  });

  return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

function registered(t: { after: (fn: () => void) => void }): Sandbox {
  const box = sandbox(t);
  const init = run(box, ['init', '--name', 'Novel Hood', '--url', 'https://novelhood.test']);
  assert.equal(init.status, 0, init.stderr);
  return box;
}

function addCard(box: Sandbox, title: string, extra: string[] = []): number {
  const result = run(box, ['add', '--title', title, ...extra]);
  assert.equal(result.status, 0, result.stderr);

  const id = /added #(\d+)/.exec(result.stdout)?.[1];
  assert.ok(id !== undefined, `no id in ${result.stdout}`);
  return Number(id);
}

test('lookover with no arguments prints usage on stderr and exits 2', (t) => {
  const result = run(sandbox(t), []);

  assert.equal(result.status, 2);
  assert.match(result.stderr, /usage: lookover <command>/);
  assert.equal(result.stdout, '');
});

test('an unknown command exits 2 and names what was typed', (t) => {
  const result = run(sandbox(t), ['bogus']);

  assert.equal(result.status, 2);
  assert.match(result.stderr, /unknown command 'bogus'/);
});

test('an inherited object property is not treated as a command', (t) => {
  // A plain object lookup would find Object.prototype.constructor here.
  const result = run(sandbox(t), ['constructor']);

  assert.equal(result.status, 2);
  assert.match(result.stderr, /unknown command 'constructor'/);
});

test('lookover --version prints the version with nothing on stderr', (t) => {
  const result = run(sandbox(t), ['--version']);

  assert.equal(result.status, 0);
  assert.equal(result.stdout.trim(), '0.2.0');
  assert.equal(result.stderr, '');
});

test('lookover help lists the add --image flag', (t) => {
  const result = run(sandbox(t), ['help']);

  assert.match(result.stdout, /--image <path>/);
});

test('import copies a generated legacy queue, images, skipped files, and refuses a second run', (t) => {
  const box = registered(t);
  const legacyPath = join(box.dir, 'testing.sqlite');
  const images = join(box.dir, 'images');
  mkdirSync(join(images, 'cards'), { recursive: true });
  mkdirSync(join(images, 'visual'), { recursive: true });
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  writeFileSync(join(images, 'cards', 'a.png'), png);
  writeFileSync(join(images, 'cards', 'b.png'), png);
  writeFileSync(join(images, 'visual', 'match.png'), png);
  writeFileSync(join(images, 'unused.png'), png);

  const legacy = new DatabaseSync(legacyPath);
  legacy.exec(`CREATE TABLE items (id INTEGER PRIMARY KEY, title TEXT NOT NULL, details TEXT NOT NULL DEFAULT '', source TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'open', verdict TEXT, feedback TEXT, created_at TEXT NOT NULL, feedback_at TEXT, processed_at TEXT, processed_note TEXT);`);
  const insert = legacy.prepare('INSERT INTO items (id,title,details,source,status,verdict,feedback,created_at,feedback_at,processed_at,processed_note) VALUES (?,?,?,?,?,?,?,?,?,?,?)');
  const rows = [
    [1, 'open one', 'plain', 'one', 'open', null, null, '2026-08-28 00:00:01', null, null, null],
    [2, 'open two', 'images/cards/', 'two', 'open', null, null, '2026-08-28 00:00:02', null, null, null],
    [3, 'feedback one', 'plain', 'three', 'feedback', 'note', 'feedback', '2026-08-28 00:00:03', '2026-08-28 00:01:03', null, null],
    [4, 'feedback two', 'plain', 'four', 'feedback', 'approved', 'fine', '2026-08-28 00:00:04', '2026-08-28 00:01:04', null, null],
    [5, 'processed one', 'images/visual/match*.png', 'five', 'processed', 'needs-work', 'needs work', '2026-08-28 00:00:05', '2026-08-28 00:01:05', '2026-08-28 00:02:05', 'note'],
    [6, 'processed two', 'plain', 'six', 'processed', 'approved', 'done', '2026-08-28 00:00:06', '2026-08-28 00:01:06', '2026-08-28 00:02:06', 'done'],
  ];
  for (const row of rows) insert.run(...row);
  legacy.close();

  const dry = run(box, ['import', '--from', legacyPath, '--images', images, '--project', 'novel-hood', '--dry-run']);
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /attached 3 files to 2 rows/);
  assert.doesNotMatch(dry.stdout, new RegExp(`${images.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/`));

  const imported = run(box, ['import', '--from', legacyPath, '--images', images, '--project', 'novel-hood']);
  assert.equal(imported.status, 0, imported.stderr);
  assert.match(imported.stdout, /imported 6 rows into novel-hood \(2 open, 2 waiting, 2 processed\); attached 3 files to 2 rows; skipped 1 unreferenced files/);
  assert.match(imported.stdout, /attached cards\/a\.png/);
  assert.doesNotMatch(imported.stdout, new RegExp(`${images.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/`));
  assert.match(imported.stdout, /unused\.png/);
  const store = openStore(join(box.home, 'queue.sqlite'));
  t.after(() => store.close());
  assert.deepEqual(store.counts(store.findProject('novel-hood')!.id), { open: 2, feedback: 2, processed: 2 });
  const processed = store.listItems({ status: 'processed' }).find((item) => item.title === 'processed one')!;
  assert.equal(processed.created_at, '2026-08-28 00:00:05');
  assert.equal(store.listFiles(processed.id).length, 1);
  assert.equal(store.listFiles(store.listItems({ status: 'open' })[0]!.id).length, 2);

  const second = run(box, ['import', '--from', legacyPath, '--project', 'novel-hood']);
  assert.equal(second.status, 1);
  assert.match(second.stderr, /already has 6 items/);
});

test('import dry-run and missing --from write nothing', (t) => {
  const box = registered(t);
  const legacyPath = join(box.dir, 'dry.sqlite');
  const legacy = new DatabaseSync(legacyPath);
  legacy.exec("CREATE TABLE items (id INTEGER PRIMARY KEY, title TEXT NOT NULL, details TEXT NOT NULL DEFAULT '', source TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'open', verdict TEXT, feedback TEXT, created_at TEXT NOT NULL, feedback_at TEXT, processed_at TEXT, processed_note TEXT); INSERT INTO items (title, created_at) VALUES ('dry', '2026-08-28 00:00:00');");
  legacy.close();
  const dry = run(box, ['import', '--from', legacyPath, '--project', 'novel-hood', '--dry-run']);
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /--dry-run: nothing written/);
  const store = openStore(join(box.home, 'queue.sqlite'));
  assert.equal(store.countItems(store.findProject('novel-hood')!.id), 0);
  store.close();
  const missing = run(box, ['import', '--from', join(box.dir, 'missing.sqlite'), '--project', 'novel-hood']);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /cannot open legacy sqlite/);
});

test('lookover help prints usage on stdout and exits 0', (t) => {
  const result = run(sandbox(t), ['help']);

  assert.equal(result.status, 0);
  assert.match(result.stdout, /usage: lookover <command>/);
});

test('init registers the project and prints its slug and store path', (t) => {
  const box = sandbox(t);

  const result = run(box, ['init', '--name', 'Novel Hood']);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^registered novel-hood$/m);
  assert.match(result.stdout, new RegExp(`^store: ${box.home}$`, 'm'));
});

test('init run again on the same project says updated instead of registering a second', (t) => {
  const box = registered(t);

  const again = run(box, ['init', '--name', 'Novel Hood Again']);

  assert.equal(again.status, 0, again.stderr);
  assert.match(again.stdout, /^updated novel-hood$/m);
  assert.equal(JSON.parse(run(box, ['project', 'list', '--json']).stdout).length, 1);
});

test('init run again without --url keeps the stored url rather than clearing it', (t) => {
  const box = registered(t);

  run(box, ['init', '--name', 'Novel Hood']);

  const [project] = JSON.parse(run(box, ['project', 'list', '--json']).stdout);
  assert.equal(project.url, 'https://novelhood.test');
});

test('init keeps a chosen accent when it is re-run without --accent', (t) => {
  const box = sandbox(t);
  run(box, ['init', '--name', 'Novel Hood', '--accent', '#123456']);

  run(box, ['init', '--name', 'Novel Hood']);

  assert.equal(JSON.parse(run(box, ['project', 'list', '--json']).stdout)[0].accent, '#123456');
});

test('init without --name exits 1 and says which flag is missing', (t) => {
  const result = run(sandbox(t), ['init']);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /init needs --name/);
});

test('init rejects an accent that is not #rrggbb', (t) => {
  const result = run(sandbox(t), ['init', '--name', 'App', '--accent', 'red']);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /--accent must look like #rrggbb/);
});

test('init --local writes the store inside the repo and gitignores it', (t) => {
  const box = sandbox(t);

  const result = spawnSync(process.execPath, [BIN, 'init', '--local', '--name', 'App'], {
    cwd: box.repo,
    encoding: 'utf8',
    env: { ...process.env, LOOKOVER_HOME: '' },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`^store: ${join(box.repo, '.lookover')}$`, 'm'));
  assert.match(readFileSync(join(box.repo, '.gitignore'), 'utf8'), /^\.lookover\/$/m);
});

test('init --local does not add a second .gitignore entry when it is already there', (t) => {
  const box = sandbox(t);
  writeFileSync(join(box.repo, '.gitignore'), 'node_modules/\n.lookover/\n');

  const env = { ...process.env, LOOKOVER_HOME: '' };
  spawnSync(process.execPath, [BIN, 'init', '--local', '--name', 'App'], { cwd: box.repo, env });

  const ignored = readFileSync(join(box.repo, '.gitignore'), 'utf8');
  assert.equal(ignored.split('\n').filter((line) => line === '.lookover/').length, 1);
});

test('init --local with LOOKOVER_HOME set exits 1 rather than writing a store nothing reads', (t) => {
  const box = sandbox(t);

  const result = run(box, ['init', '--local', '--name', 'App']);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /LOOKOVER_HOME is set/);
  assert.equal(existsSync(join(box.repo, '.lookover')), false);
});

test('add files a card and prints the id and project it landed on', (t) => {
  const box = registered(t);

  const result = run(box, ['add', '--title', 'Try the header', '--details', 'open the page']);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^added #1 to novel-hood$/m);
});

test('add from a git worktree lands on the same project as the main checkout', (t) => {
  const box = registered(t);

  const result = run(box, ['add', '--title', 'From a worktree'], { cwd: box.worktree });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /to novel-hood$/m);
  assert.equal(JSON.parse(run(box, ['project', 'list', '--json']).stdout).length, 1);
});

test('add --details-file reaches the row byte for byte, dashes and backticks included', (t) => {
  const box = registered(t);
  const body = '# Steps\n\n---\n\n```sh\necho "$VAR" && cd /tmp\n```\n\n- one\n- two\n';
  const path = join(box.dir, 'steps.md');
  writeFileSync(path, body);

  const id = addCard(box, 'With a details file', ['--details-file', path]);

  const [item] = JSON.parse(run(box, ['list', '--json']).stdout);
  assert.equal(item.id, id);
  assert.equal(item.details, body);
});

test('add refuses --details and --details-file together', (t) => {
  const box = registered(t);

  const result = run(box, ['add', '--title', 'x', '--details', 'a', '--details-file', 'b']);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /--details and --details-file cannot be used together/);
});

test('add with neither details flag stores empty details', (t) => {
  const box = registered(t);
  addCard(box, 'No details');

  assert.equal(JSON.parse(run(box, ['list', '--json']).stdout)[0].details, '');
});

test('add without --title exits 1', (t) => {
  const box = registered(t);

  const result = run(box, ['add', '--details', 'orphaned']);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /add needs --title/);
});

test('add rejects an unknown flag rather than ignoring the typo', (t) => {
  const box = registered(t);

  const result = run(box, ['add', '--title', 'x', '--detials', 'typo']);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /detials/);
});

test('add --retest-of an item that does not exist exits 1 and files nothing', (t) => {
  const box = registered(t);

  const result = run(box, ['add', '--title', 'retest', '--retest-of', '404']);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /no item #404/);
  assert.equal(JSON.parse(run(box, ['list', '--json']).stdout).length, 0);
});

test('add --retest-of another project\'s item exits 1 and files nothing', (t) => {
  const box = registered(t);
  const other = join(box.dir, 'other');
  mkdirSync(other, { recursive: true });
  run(box, ['init', '--name', 'Other'], { cwd: other });
  const mine = addCard(box, 'in novel-hood');

  const result = run(box, ['add', '--title', 'cross', '--retest-of', String(mine), '--project', 'other']);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /belongs to another project/);
  assert.equal(JSON.parse(run(box, ['list', '--json', '--project', 'other']).stdout).length, 0);
});

test('add --retest-of records the chain back to the original card', (t) => {
  const box = registered(t);
  const original = addCard(box, 'Try the header');

  const retest = addCard(box, 'Try the header again', ['--retest-of', String(original)]);

  const items = JSON.parse(run(box, ['list', '--json']).stdout);
  assert.equal(items.find((item: { id: number }) => item.id === retest).retest_of, original);
});

test('add --sort outside 1 to 3 exits 1', (t) => {
  const box = registered(t);

  const result = run(box, ['add', '--title', 'x', '--sort', '9']);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /--sort must be 1, 2 or 3/);
});

test('add in an unregistered directory tells the user to run init', (t) => {
  const box = sandbox(t);

  const result = run(box, ['add', '--title', 'x']);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /no project registered for this directory; run `lookover init/);
});

test('add --project names a project other than the one in the current directory', (t) => {
  const box = registered(t);
  const other = join(box.dir, 'other');
  mkdirSync(other, { recursive: true });
  run(box, ['init', '--name', 'Other'], { cwd: other });

  const result = run(box, ['add', '--title', 'cross filed', '--project', 'other']);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /to other$/m);
});

test('add --project with an unregistered slug exits 1', (t) => {
  const box = registered(t);

  const result = run(box, ['add', '--title', 'x', '--project', 'nope']);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /no project with slug 'nope'/);
});

test('open --count prints only the integer, and zero on an empty store', (t) => {
  const box = registered(t);

  assert.equal(run(box, ['open', '--count']).stdout, '0\n');

  addCard(box, 'one');
  addCard(box, 'two');

  assert.equal(run(box, ['open', '--count']).stdout, '2\n');
});

test('open lists only cards still waiting on the tester', (t) => {
  const box = registered(t);
  const answered = addCard(box, 'answered');
  addCard(box, 'still open');
  answer(box, answered);

  const items = JSON.parse(run(box, ['open', '--json']).stdout);

  assert.deepEqual(
    items.map((item: { title: string }) => item.title),
    ['still open'],
  );
});

test('open on an empty project prints the human empty state', (t) => {
  const box = registered(t);

  assert.match(run(box, ['open']).stdout, /nothing to test/i);
});

test('feedback --json returns the answered cards with a project slug on each', (t) => {
  const box = registered(t);
  const id = addCard(box, 'Try the header');
  answer(box, id, 'needs-work', 'it wraps at 320');

  const result = run(box, ['feedback', '--json']);

  assert.equal(result.status, 0, result.stderr);
  const items = JSON.parse(result.stdout);
  assert.equal(items.length, 1);
  assert.equal(items[0].project, 'novel-hood');
  assert.equal(items[0].verdict, 'needs-work');
  assert.equal(items[0].feedback, 'it wraps at 320');
  assert.equal(items[0].status, 'feedback');
});

test('feedback in human form prints the id, project, verdict, title and text', (t) => {
  const box = registered(t);
  answer(box, addCard(box, 'Try the header'), 'needs-work', 'it wraps at 320');

  const out = run(box, ['feedback']).stdout;

  assert.match(out, /#1 {2}novel-hood {2}needs-work/);
  assert.match(out, /Try the header/);
  assert.match(out, /it wraps at 320/);
});

test('feedback --all covers every project at once', (t) => {
  const box = registered(t);
  const other = join(box.dir, 'other');
  mkdirSync(other, { recursive: true });
  run(box, ['init', '--name', 'Other'], { cwd: other });
  answer(box, addCard(box, 'here'));
  answer(box, addCard(box, 'there', ['--project', 'other']));

  const items = JSON.parse(run(box, ['feedback', '--all', '--json']).stdout);

  assert.deepEqual(new Set(items.map((item: { project: string }) => item.project)), new Set(['novel-hood', 'other']));
});

test('--all leaves out the cards of an archived project', (t) => {
  const box = registered(t);
  const other = join(box.dir, 'other');
  mkdirSync(other, { recursive: true });
  run(box, ['init', '--name', 'Other'], { cwd: other });
  addCard(box, 'still live');
  answer(box, addCard(box, 'archived feedback', ['--project', 'other']));
  addCard(box, 'archived open', ['--project', 'other']);

  run(box, ['project', 'archive', 'other']);

  assert.deepEqual(
    JSON.parse(run(box, ['open', '--all', '--json']).stdout).map((i: { title: string }) => i.title),
    ['still live'],
  );
  assert.equal(JSON.parse(run(box, ['feedback', '--all', '--json']).stdout).length, 0);
  assert.deepEqual(
    JSON.parse(run(box, ['list', '--all', '--json']).stdout).map((i: { title: string }) => i.title),
    ['still live'],
  );
  assert.equal(run(box, ['open', '--all', '--count']).stdout, '1\n');
});

test('--source, --url and --ref reach the row unchanged', (t) => {
  const box = registered(t);
  addCard(box, 'with provenance', [
    '--source',
    'lead todo-1286',
    '--url',
    'https://novelhood.test/chapter/1?a=b&c=d',
    '--ref',
    'PR #221',
  ]);

  const [item] = JSON.parse(run(box, ['list', '--json']).stdout);

  assert.equal(item.source, 'lead todo-1286');
  assert.equal(item.url, 'https://novelhood.test/chapter/1?a=b&c=d');
  assert.equal(item.ref, 'PR #221');
});

test('open queues by the lead\'s sort key first, then by oldest id', (t) => {
  const box = registered(t);
  addCard(box, 'unranked first');
  addCard(box, 'ranked three', ['--sort', '3']);
  addCard(box, 'ranked one', ['--sort', '1']);
  addCard(box, 'unranked second');
  addCard(box, 'also ranked one', ['--sort', '1']);

  assert.deepEqual(
    JSON.parse(run(box, ['open', '--json']).stdout).map((i: { title: string }) => i.title),
    ['ranked one', 'also ranked one', 'ranked three', 'unranked first', 'unranked second'],
  );
});

test('feedback rejects --project together with --all', (t) => {
  const box = registered(t);

  const result = run(box, ['feedback', '--all', '--project', 'novel-hood']);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /--project and --all cannot be used together/);
});

test('process moves an answered card to processed and records the note', (t) => {
  const box = registered(t);
  const id = addCard(box, 'Try the header');
  answer(box, id);

  const result = run(box, ['process', String(id), '--note', 'swept into lane 4']);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^processed #1$/m);

  const [item] = JSON.parse(run(box, ['list', '--json', '--status', 'processed']).stdout);
  assert.equal(item.processed_note, 'swept into lane 4');
});

test('process on a card still open exits 1 and names its current status', (t) => {
  const box = registered(t);
  const id = addCard(box, 'Try the header');

  const result = run(box, ['process', String(id), '--note', 'too early']);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /item #1 is open, not feedback/);
});

test('process on an already processed card exits 1', (t) => {
  const box = registered(t);
  const id = addCard(box, 'Try the header');
  answer(box, id);
  run(box, ['process', String(id), '--note', 'first']);

  const result = run(box, ['process', String(id), '--note', 'second']);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /is processed, not feedback/);
});

test('process without --note exits 1', (t) => {
  const box = registered(t);

  const result = run(box, ['process', '1']);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /process needs --note/);
});

test('process without an id exits 1', (t) => {
  const box = registered(t);

  const result = run(box, ['process', '--note', 'x']);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /process needs an item id/);
});

test('list defaults to 50 cards, newest first', (t) => {
  const box = registered(t);
  for (let index = 0; index < 52; index += 1) {
    addCard(box, `card ${index}`);
  }

  const items = JSON.parse(run(box, ['list', '--json']).stdout);

  assert.equal(items.length, 50);
  assert.equal(items[0].title, 'card 51');
});

test('list --limit overrides the default page size', (t) => {
  const box = registered(t);
  addCard(box, 'one');
  addCard(box, 'two');

  assert.equal(JSON.parse(run(box, ['list', '--json', '--limit', '1']).stdout).length, 1);
});

test('list --status rejects a status that is not in the state machine', (t) => {
  const box = registered(t);

  const result = run(box, ['list', '--status', 'closed']);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /--status must be one of open, feedback, processed/);
});

test('list --limit rejects a value that is not a positive whole number', (t) => {
  const box = registered(t);

  const result = run(box, ['list', '--limit', '0']);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /--limit must be a positive whole number/);
});

test('project list reports each project with its open and waiting counts', (t) => {
  const box = registered(t);
  addCard(box, 'one');
  answer(box, addCard(box, 'two'));

  const [project] = JSON.parse(run(box, ['project', 'list', '--json']).stdout);

  assert.equal(project.slug, 'novel-hood');
  assert.deepEqual(project.counts, { open: 1, feedback: 1, processed: 0 });
  assert.match(run(box, ['project', 'list']).stdout, /novel-hood.*1 open.*1 waiting/);
});

test('project archive hides a project from the default listing', (t) => {
  const box = registered(t);

  const result = run(box, ['project', 'archive', 'novel-hood']);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(run(box, ['project', 'list', '--json']).stdout).length, 0);
  assert.equal(JSON.parse(run(box, ['project', 'list', '--json', '--all']).stdout).length, 1);
});

test('project archive on an unknown slug exits 1', (t) => {
  const box = registered(t);

  const result = run(box, ['project', 'archive', 'nope']);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /no project with slug 'nope'/);
});

test('project with an unknown subcommand exits 1 and names the valid ones', (t) => {
  const box = registered(t);

  const result = run(box, ['project', 'destroy']);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /expected list or archive/);
});

test('project list on an empty store tells the user to run init', (t) => {
  const box = sandbox(t);

  assert.match(run(box, ['project', 'list']).stdout, /no projects registered/);
});

test('every --json read command emits parseable json with stable keys', (t) => {
  const box = registered(t);
  answer(box, addCard(box, 'Try the header'));

  for (const args of [['list'], ['open'], ['feedback'], ['project', 'list']]) {
    const result = run(box, [...args, '--json']);
    assert.equal(result.status, 0, `${args.join(' ')}: ${result.stderr}`);
    assert.doesNotThrow(() => JSON.parse(result.stdout), `${args.join(' ')} is not json`);
  }

  const [item] = JSON.parse(run(box, ['list', '--json']).stdout);
  assert.deepEqual(Object.keys(item), [
    'id',
    'project_id',
    'title',
    'details',
    'source',
    'url',
    'ref',
    'retest_of',
    'sort',
    'status',
    'verdict',
    'feedback',
    'created_at',
    'feedback_at',
    'processed_at',
    'processed_note',
    'project',
    'files',
  ]);
});

test('add --details-file pointing at a missing file exits 1 and files nothing', (t) => {
  const box = registered(t);

  const result = run(box, ['add', '--title', 'x', '--details-file', join(box.dir, 'absent.md')]);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /cannot read --details-file/);
  assert.equal(JSON.parse(run(box, ['list', '--json']).stdout).length, 0);
});

test('open --count stays a bare integer even when --json is also passed', (t) => {
  const box = registered(t);
  addCard(box, 'one');

  assert.equal(run(box, ['open', '--count', '--json']).stdout, '1\n');
});

/** The tester's side of the state machine; the page (lane 2) does this for real. */
function answer(box: Sandbox, id: number, verdict = 'approved', text = 'looks right'): void {
  const script = `
    import { openStore } from ${JSON.stringify(new URL('./store.ts', import.meta.url).href)};
    const store = openStore(${JSON.stringify(join(box.home, 'queue.sqlite'))});
    store.saveFeedback(${id}, { verdict: ${JSON.stringify(verdict)}, feedback: ${JSON.stringify(text)} });
    store.close();
  `;

  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
}

const PNG_BYTES = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(24, 9)]);
const JPEG_WITH_EXIF = Buffer.from([
  0xff, 0xd8, 0xff, 0xe1, 0x00, 0x0c, 0x45, 0x78, 0x69, 0x66, 0x00, 0x00, 0x47, 0x50, 0x53, 0x21,
  0xff, 0xdb, 0x00, 0x04, 0x01, 0x02, 0xff, 0xda, 0x00, 0x02, 0x11, 0x22, 0xff, 0xd9,
]);

function image(box: Sandbox, name: string, data: Buffer): string {
  const path = join(box.dir, name);
  writeFileSync(path, data);
  return path;
}

interface JsonItem {
  id: number;
  files: { id: number; side: string; name: string; mime: string; size: number; path: string }[];
}

function listJson(box: Sandbox, command = 'list'): JsonItem[] {
  const result = run(box, [command, '--json']);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout) as JsonItem[];
}

test('add --image twice stores both, prints the count, and list --json carries absolute paths', (t) => {
  const box = registered(t);
  const one = image(box, 'one.png', PNG_BYTES);
  const two = image(box, 'two.png', Buffer.concat([PNG_BYTES, Buffer.from('more')]));

  const result = run(box, ['add', '--title', 'Shots', '--image', one, '--image', two]);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^added #1 to novel-hood \(2 images\)$/m);
  const files = listJson(box)[0]?.files ?? [];
  assert.deepEqual(files.map((f) => [f.side, f.name, f.mime]), [
    ['card', 'one.png', 'image/png'],
    ['card', 'two.png', 'image/png'],
  ]);
  assert.ok(String(files[0]?.path).startsWith(join(box.home, 'files')));
  assert.deepEqual(readFileSync(files[1]?.path ?? ''), Buffer.concat([PNG_BYTES, Buffer.from('more')]));
});

test('add --image once says 1 image and open --json carries the file too', (t) => {
  const box = registered(t);

  const result = run(box, ['add', '--title', 'Solo', '--image', image(box, 'solo.png', PNG_BYTES)]);

  assert.match(result.stdout, /\(1 image\)/);
  assert.equal(listJson(box, 'open')[0]?.files.length, 1);
});

test('add --image strips the Exif segment from a JPEG and the file still ends in EOI', (t) => {
  const box = registered(t);

  run(box, ['add', '--title', 'Photo', '--image', image(box, 'p.jpg', JPEG_WITH_EXIF)]);

  const stored = readFileSync(listJson(box)[0]?.files[0]?.path ?? '');
  assert.equal(stored.includes(Buffer.from('Exif')), false);
  assert.deepEqual([...stored.subarray(0, 3)], [0xff, 0xd8, 0xff]);
  assert.deepEqual([...stored.subarray(-2)], [0xff, 0xd9]);
});

test('add --image keeps a name with spaces and a quote in the row and off the disk path', (t) => {
  const box = registered(t);
  const path = image(box, 'my "best" shot.png', PNG_BYTES);

  const result = run(box, ['add', '--title', 'Odd name', '--image', path]);

  assert.equal(result.status, 0, result.stderr);
  const file = listJson(box)[0]?.files[0];
  assert.equal(file?.name, 'my "best" shot.png');
  assert.doesNotMatch(file?.path ?? '', /best/);
});

test('add --image with a .txt renamed .png exits 1 by its bytes and files no card', (t) => {
  const box = registered(t);

  const result = run(box, ['add', '--title', 'Fake', '--image', image(box, 'fake.png', Buffer.from('not an image\n'))]);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /fake\.png is text/);
  assert.deepEqual(listJson(box), []);
});

test('add --image over 10 MB exits 1 and files no card', (t) => {
  const box = registered(t);
  const huge = image(box, 'huge.png', Buffer.concat([PNG_BYTES, Buffer.alloc(12 * 1024 * 1024)]));

  const result = run(box, ['add', '--title', 'Huge', '--image', huge]);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /huge\.png is over the 10 MB limit/);
  assert.deepEqual(listJson(box), []);
});

test('add --image refuses a sixth image and files no card', (t) => {
  const box = registered(t);
  const args = ['add', '--title', 'Many'];
  for (let i = 0; i < 6; i += 1) {
    args.push('--image', image(box, `${i}.png`, PNG_BYTES));
  }

  const result = run(box, args);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /at most 5/);
  assert.deepEqual(listJson(box), []);
});

test('add --image with a path that does not exist exits 1 and files no card', (t) => {
  const box = registered(t);

  const result = run(box, ['add', '--title', 'Missing', '--image', join(box.dir, 'nope.png')]);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /cannot read --image/);
  assert.deepEqual(listJson(box), []);
});

test('add --image with a good image and a bad one stores neither', (t) => {
  const box = registered(t);

  const result = run(box, ['add', '--title', 'Mixed', '--image', image(box, 'ok.png', PNG_BYTES), '--image', image(box, 'bad.png', Buffer.from('nope'))]);

  assert.equal(result.status, 1);
  assert.deepEqual(listJson(box), []);
  assert.equal(existsSync(join(box.home, 'files', 'novel-hood')), false);
});

test('feedback --json carries the tester photo and the text output prints its path', (t) => {
  const box = registered(t);
  const id = addCard(box, 'Needs a look');
  const store = openStore(join(box.home, 'queue.sqlite'));
  store.saveFeedback(id, { verdict: 'needs-work', feedback: 'see photo' });
  storeImage(store, box.home, 'novel-hood', id, 'feedback', 'phone.png', PNG_BYTES);
  store.close();

  const json = listJson(box, 'feedback');
  const text = run(box, ['feedback']);

  assert.equal(json[0]?.files[0]?.side, 'feedback');
  assert.deepEqual(readFileSync(json[0]?.files[0]?.path ?? ''), PNG_BYTES);
  const path = json[0]?.files[0]?.path ?? '';
  assert.ok(text.stdout.includes(`feedback image: ${path}`), text.stdout);
});

test('a card with no images has an empty files array in --json', (t) => {
  const box = registered(t);
  addCard(box, 'Plain');

  assert.deepEqual(listJson(box)[0]?.files, []);
});

test('list exits cleanly when its JSON pipe closes early', async (t) => {
  const box = registered(t);
  const details = 'x'.repeat(30_000);
  addCard(box, 'First', ['--details', details]);
  addCard(box, 'Second', ['--details', details]);
  addCard(box, 'Third', ['--details', details]);

  const lookover = spawn(process.execPath, [BIN, 'list', '--json'], {
    cwd: box.repo,
    env: { ...process.env, LOOKOVER_HOME: box.home },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const sink = spawn(process.execPath, ['-e', "process.stdin.once('data', () => { process.stdin.destroy(); process.exit(0); });"], {
    stdio: ['pipe', 'ignore', 'ignore'],
  });
  lookover.stdout.pipe(sink.stdin);

  let stderr = '';
  lookover.stderr.setEncoding('utf8');
  lookover.stderr.on('data', (chunk: string) => { stderr += chunk; });
  const status = await new Promise<number>((resolve) => lookover.on('close', (code) => resolve(code ?? -1)));
  assert.equal(status, 0);
  assert.equal(stderr, '');
});

test('serve started in a registered repo prints its project slug', async (t) => {
  const box = registered(t);
  const lookover = spawn(process.execPath, [BIN, 'serve', '--port', '0'], {
    cwd: box.repo,
    env: { ...process.env, LOOKOVER_HOME: box.home },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => lookover.kill('SIGTERM'));

  const line = await new Promise<string>((resolve, reject) => {
    let stdout = '';
    lookover.stdout.setEncoding('utf8');
    lookover.stdout.on('data', (chunk: string) => {
      stdout += chunk;
      const end = stdout.indexOf('\n');
      if (end !== -1) resolve(stdout.slice(0, end));
    });
    lookover.once('error', reject);
  });
  lookover.kill('SIGTERM');

  assert.match(line, /^lookover: http:\/\/127\.0\.0\.1:\d+ \(novel-hood\)$/);
});

async function freePort(): Promise<{ port: number; close: () => Promise<void> }> {
  const server = createNetServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('free port listener has no address');
  return { port: address.port, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

async function serveLine(box: Sandbox, port: number, extra: string[] = []) {
  const lookover = spawn(process.execPath, [BIN, 'serve', '--port', String(port), ...extra], {
    cwd: box.repo,
    env: { ...process.env, LOOKOVER_HOME: box.home },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  lookover.stdout.setEncoding('utf8');
  lookover.stderr.setEncoding('utf8');
  lookover.stderr.on('data', (chunk: string) => { stderr += chunk; });
  const line = await new Promise<string>((resolve, reject) => {
    lookover.stdout.on('data', (chunk: string) => {
      stdout += chunk;
      const end = stdout.indexOf('\n');
      if (end !== -1) resolve(stdout.slice(0, end));
    });
    lookover.once('error', reject);
    lookover.once('close', (code) => reject(new Error(`serve exited ${code}: ${stderr}`)));
  });
  return { lookover, line, stderr };
}

test('serve replaces a previous lookover serve and removes its pid file', async (t) => {
  const box = sandbox(t);
  const available = await freePort();
  await available.close();
  const first = await serveLine(box, available.port);
  const second = await serveLine(box, available.port);
  assert.match(second.line, new RegExp(`replaced lookover serve \\(pid ${first.lookover.pid}\\) on port ${available.port}`));
  second.lookover.kill('SIGTERM');
  if (second.lookover.exitCode === null) await new Promise<void>((resolve) => second.lookover.once('close', () => resolve()));
  first.lookover.kill('SIGTERM');
  if (first.lookover.exitCode === null) await new Promise<void>((resolve) => first.lookover.once('close', () => resolve()));
});

test('serve refuses a foreign listener and --no-replace refuses a lookover listener', async (t) => {
  const box = sandbox(t);
  const available = await freePort();
  t.after(() => { void available.close(); });
  await available.close();
  const foreign = createNetServer();
  t.after(() => { foreign.close(); });
  await new Promise<void>((resolve) => foreign.listen(available.port, '127.0.0.1', resolve));
  const refused = spawn(process.execPath, [BIN, 'serve', '--port', String(available.port)], {
    cwd: box.repo,
    env: { ...process.env, LOOKOVER_HOME: box.home },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stderr = await new Promise<string>((resolve) => {
    let output = '';
    refused.stderr.setEncoding('utf8');
    refused.stderr.on('data', (chunk: string) => { output += chunk; });
    refused.once('close', () => resolve(output));
  });
  assert.equal(refused.exitCode, 1);
  assert.match(stderr, /port \d+ is already in use by pid \d+ \(.+\)/);

  await new Promise<void>((resolve) => foreign.close(() => resolve()));
  await available.close();
  const first = await serveLine(box, available.port);
  const noReplace = spawn(process.execPath, [BIN, 'serve', '--port', String(available.port), '--no-replace'], {
    cwd: box.repo,
    env: { ...process.env, LOOKOVER_HOME: box.home },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const noReplaceStderr = await new Promise<string>((resolve) => {
    let output = '';
    noReplace.stderr.setEncoding('utf8');
    noReplace.stderr.on('data', (chunk: string) => { output += chunk; });
    noReplace.once('close', () => resolve(output));
  });
  assert.equal(noReplace.exitCode, 1);
  assert.match(noReplaceStderr, /already in use/);
  first.lookover.kill('SIGTERM');
});

test('serve ignores a stale pid without leaking ps diagnostics', async (t) => {
  const box = sandbox(t);
  const available = await freePort();
  await available.close();
  mkdirSync(join(box.home, 'serve'), { recursive: true });
  writeFileSync(join(box.home, 'serve', `${available.port}.pid`), '999999\n0\n');
  const served = await serveLine(box, available.port);
  t.after(() => { served.lookover.kill('SIGTERM'); });
  assert.match(served.line, /^lookover: http:\/\/127\.0\.0\.1:\d+$/);
  assert.equal(served.stderr, '');
});

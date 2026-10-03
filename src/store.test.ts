import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { DatabaseSync } from 'node:sqlite';

import { openStore, StoreError, type Store } from './store.ts';

interface Ctx {
  after: (fn: () => void) => void;
}

function storePath(t: Ctx): string {
  const dir = mkdtempSync(join(tmpdir(), 'lookover-store-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, 'queue.sqlite');
}

function freshStore(t: Ctx): Store {
  const store = openStore(storePath(t));
  t.after(() => store.close());
  return store;
}

function project(store: Store, name: string, identity: string) {
  return store.registerProject({
    slug: name,
    name,
    identity,
    identity_kind: 'git',
    root: `/tmp/${name}`,
    accent: '#336699',
  });
}

test('migrations bring a new file to version 3', (t) => {
  assert.equal(freshStore(t).schemaVersion(), 3);
});

test('reopening a migrated file re-runs nothing and stays at version 3', (t) => {
  const path = storePath(t);

  const first = openStore(path);
  first.close();

  // Re-running migration 1 would throw "table projects already exists", so a
  // second open succeeding is the proof that the runner skipped it.
  const second = openStore(path);
  t.after(() => second.close());

  assert.equal(second.schemaVersion(), 3);
});

test('the store opens in WAL mode with a five second busy timeout', (t) => {
  const store = freshStore(t);

  assert.equal(store.pragma('journal_mode'), 'wal');
  assert.equal(store.pragma('busy_timeout'), 5000);
});

test('registerProject on an identity already present updates it instead of adding a row', (t) => {
  const store = freshStore(t);
  project(store, 'novelhood', '/repos/novelhood/.git');

  const updated = store.registerProject({
    slug: 'renamed',
    name: 'Novel Hood',
    identity: '/repos/novelhood/.git',
    identity_kind: 'git',
    root: '/repos/novelhood',
    url: 'https://novelhood.test',
    accent: '#aabbcc',
  });

  assert.equal(store.listProjects().length, 1);
  assert.equal(updated.name, 'Novel Hood');
  assert.equal(updated.url, 'https://novelhood.test');
  assert.equal(updated.accent, '#aabbcc');
});

test('registerProject keeps the original slug when a registered project is renamed', (t) => {
  const store = freshStore(t);
  project(store, 'novelhood', '/repos/novelhood/.git');

  const updated = store.registerProject({
    slug: 'novel-hood',
    name: 'Novel Hood',
    identity: '/repos/novelhood/.git',
    identity_kind: 'git',
    root: '/repos/novelhood',
    accent: '#aabbcc',
  });

  assert.equal(updated.slug, 'novelhood');
});

test('registerProject refuses a slug a different identity already holds', (t) => {
  const store = freshStore(t);
  project(store, 'app', '/repos/one/.git');

  assert.throws(
    () => project(store, 'app', '/repos/two/.git'),
    (error: unknown) => error instanceof StoreError && /already registered/.test(String(error)),
  );
  assert.equal(store.listProjects().length, 1);
});

test('listProjects hides archived projects unless asked for them', (t) => {
  const store = freshStore(t);
  project(store, 'kept', '/repos/kept/.git');
  project(store, 'gone', '/repos/gone/.git');

  const archived = store.archiveProject('gone');

  assert.notEqual(archived.archived_at, null);
  assert.deepEqual(
    store.listProjects().map((p) => p.slug),
    ['kept'],
  );
  assert.equal(store.listProjects({ includeArchived: true }).length, 2);
});

test('archiveProject on an unknown slug throws', (t) => {
  const store = freshStore(t);

  assert.throws(() => store.archiveProject('nope'), StoreError);
});

test('findProject answers to either the slug or the identity', (t) => {
  const store = freshStore(t);
  const created = project(store, 'novelhood', '/repos/novelhood/.git');

  assert.equal(store.findProject('novelhood')?.id, created.id);
  assert.equal(store.findProject('/repos/novelhood/.git')?.id, created.id);
  assert.equal(store.findProject('neither'), undefined);
});

test('addItem defaults a card to open with empty details and no verdict', (t) => {
  const store = freshStore(t);
  const p = project(store, 'app', '/repos/app/.git');

  const item = store.addItem({ projectId: p.id, title: 'Try the header' });

  assert.equal(item.status, 'open');
  assert.equal(item.details, '');
  assert.equal(item.verdict, null);
  assert.equal(item.feedback_at, null);
  assert.match(item.created_at, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
});

test('addItem born feedback stamps feedback_at, the way a tester-filed card arrives', (t) => {
  const store = freshStore(t);
  const p = project(store, 'app', '/repos/app/.git');

  const item = store.addItem({
    projectId: p.id,
    title: 'Found something else',
    source: 'chris',
    status: 'feedback',
    verdict: 'note',
    feedback: 'the footer overlaps on a phone',
  });

  assert.equal(item.status, 'feedback');
  assert.match(String(item.feedback_at), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
});

test('addItem refuses a retest-of pointing at an item that does not exist', (t) => {
  const store = freshStore(t);
  const p = project(store, 'app', '/repos/app/.git');

  assert.throws(
    () => store.addItem({ projectId: p.id, title: 'retest', retestOf: 404 }),
    StoreError,
  );
  assert.equal(store.listItems().length, 0);
});

test('saveFeedback moves an open card to feedback and stamps the verdict', (t) => {
  const store = freshStore(t);
  const p = project(store, 'app', '/repos/app/.git');
  const item = store.addItem({ projectId: p.id, title: 'Try the header' });

  const answered = store.saveFeedback(item.id, { verdict: 'needs-work', feedback: 'it wraps' });

  assert.equal(answered.status, 'feedback');
  assert.equal(answered.verdict, 'needs-work');
  assert.equal(answered.feedback, 'it wraps');
  assert.match(String(answered.feedback_at), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
});

test('saveFeedback lets the tester revise an answer that is still waiting', (t) => {
  const store = freshStore(t);
  const p = project(store, 'app', '/repos/app/.git');
  const item = store.addItem({ projectId: p.id, title: 'Try the header' });
  store.saveFeedback(item.id, { verdict: 'needs-work', feedback: 'it wraps' });

  const revised = store.saveFeedback(item.id, { verdict: 'approved', feedback: 'my mistake' });

  assert.equal(revised.verdict, 'approved');
});

test('saveFeedback on a processed card throws instead of reopening it', (t) => {
  const store = freshStore(t);
  const p = project(store, 'app', '/repos/app/.git');
  const item = store.addItem({ projectId: p.id, title: 'Try the header' });
  store.saveFeedback(item.id, { verdict: 'approved', feedback: 'fine' });
  store.processItem(item.id, 'swept');

  assert.throws(
    () => store.saveFeedback(item.id, { verdict: 'note', feedback: 'again' }),
    (error: unknown) => error instanceof StoreError && /processed/.test(String(error)),
  );
  assert.equal(store.getItem(item.id)?.status, 'processed');
});

test('processItem on an open card throws, because only an answered card can be swept', (t) => {
  const store = freshStore(t);
  const p = project(store, 'app', '/repos/app/.git');
  const item = store.addItem({ projectId: p.id, title: 'Try the header' });

  assert.throws(
    () => store.processItem(item.id, 'swept'),
    (error: unknown) => error instanceof StoreError && /is open, not feedback/.test(String(error)),
  );
  assert.equal(store.getItem(item.id)?.status, 'open');
});

test('processItem on an already processed card throws', (t) => {
  const store = freshStore(t);
  const p = project(store, 'app', '/repos/app/.git');
  const item = store.addItem({ projectId: p.id, title: 'Try the header' });
  store.saveFeedback(item.id, { verdict: 'approved', feedback: 'fine' });
  store.processItem(item.id, 'swept');

  assert.throws(() => store.processItem(item.id, 'again'), StoreError);
});

test('processItem stamps the note and the processed time', (t) => {
  const store = freshStore(t);
  const p = project(store, 'app', '/repos/app/.git');
  const item = store.addItem({ projectId: p.id, title: 'Try the header' });
  store.saveFeedback(item.id, { verdict: 'needs-work', feedback: 'it wraps' });

  const done = store.processItem(item.id, 'fixed in lane 4');

  assert.equal(done.status, 'processed');
  assert.equal(done.processed_note, 'fixed in lane 4');
  assert.match(String(done.processed_at), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
});

test('processItem on an unknown id throws', (t) => {
  assert.throws(() => freshStore(t).processItem(404, 'swept'), StoreError);
});

test('counts are per project and cover all three statuses', (t) => {
  const store = freshStore(t);
  const one = project(store, 'one', '/repos/one/.git');
  const two = project(store, 'two', '/repos/two/.git');

  store.addItem({ projectId: one.id, title: 'a' });
  store.addItem({ projectId: one.id, title: 'b' });
  const answered = store.addItem({ projectId: one.id, title: 'c' });
  store.saveFeedback(answered.id, { verdict: 'approved', feedback: 'fine' });
  const swept = store.addItem({ projectId: two.id, title: 'd' });
  store.saveFeedback(swept.id, { verdict: 'approved', feedback: 'fine' });
  store.processItem(swept.id, 'swept');

  assert.deepEqual(store.counts(one.id), { open: 2, feedback: 1, processed: 0 });
  assert.deepEqual(store.counts(two.id), { open: 0, feedback: 0, processed: 1 });
  assert.deepEqual(store.counts(), { open: 2, feedback: 1, processed: 1 });
});

test('counts on an empty store are three zeroes, not an empty object', (t) => {
  assert.deepEqual(freshStore(t).counts(), { open: 0, feedback: 0, processed: 0 });
});

test('listItems returns newest first and honours the project, status and limit filters', (t) => {
  const store = freshStore(t);
  const one = project(store, 'one', '/repos/one/.git');
  const two = project(store, 'two', '/repos/two/.git');
  store.addItem({ projectId: one.id, title: 'first' });
  store.addItem({ projectId: one.id, title: 'second' });
  store.addItem({ projectId: two.id, title: 'other' });

  assert.deepEqual(
    store.listItems({ projectId: one.id }).map((item) => item.title),
    ['second', 'first'],
  );
  assert.deepEqual(
    store.listItems({ projectId: one.id, limit: 1 }).map((item) => item.title),
    ['second'],
  );
  assert.equal(store.listItems({ status: 'processed' }).length, 0);
  assert.equal(store.listItems().length, 3);
});

test('a write that throws rolls back, so the next write is not blocked by an open transaction', (t) => {
  const store = freshStore(t);
  project(store, 'app', '/repos/one/.git');

  assert.throws(() => project(store, 'app', '/repos/two/.git'), StoreError);

  // Without the ROLLBACK the next BEGIN IMMEDIATE would throw "cannot start a
  // transaction within a transaction", so this line is the rollback's proof.
  const second = project(store, 'other', '/repos/two/.git');

  assert.equal(second.slug, 'other');
});

test('addItem refuses a retest-of pointing at another project\'s item', (t) => {
  const store = freshStore(t);
  const one = project(store, 'one', '/repos/one/.git');
  const two = project(store, 'two', '/repos/two/.git');
  const inOne = store.addItem({ projectId: one.id, title: 'theirs' });

  assert.throws(
    () => store.addItem({ projectId: two.id, title: 'cross', retestOf: inOne.id }),
    (error: unknown) => error instanceof StoreError && /belongs to another project/.test(String(error)),
  );
  assert.equal(store.listItems({ projectId: two.id }).length, 0);
});

test('retest chains point back at the card they replace', (t) => {
  const store = freshStore(t);
  const p = project(store, 'app', '/repos/app/.git');
  const original = store.addItem({ projectId: p.id, title: 'Try the header' });

  const retest = store.addItem({ projectId: p.id, title: 'Try the header again', retestOf: original.id });

  assert.equal(retest.retest_of, original.id);
});

const V1_SCHEMA = `
  CREATE TABLE projects (
    id INTEGER PRIMARY KEY, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
    identity TEXT NOT NULL UNIQUE, identity_kind TEXT NOT NULL, root TEXT NOT NULL,
    url TEXT, accent TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')),
    archived_at TEXT
  );
  CREATE TABLE items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL REFERENCES projects(id),
    title TEXT NOT NULL, details TEXT NOT NULL DEFAULT '', source TEXT NOT NULL DEFAULT '',
    url TEXT, ref TEXT, retest_of INTEGER REFERENCES items(id), sort INTEGER,
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'feedback', 'processed')),
    verdict TEXT CHECK (verdict IN ('approved', 'needs-work', 'note')),
    feedback TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')),
    feedback_at TEXT, processed_at TEXT, processed_note TEXT
  );
  CREATE INDEX items_project_status ON items (project_id, status);
  CREATE TABLE schema_version (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL);
  INSERT INTO schema_version (id, version) VALUES (1, 1);
  INSERT INTO projects (id, slug, name, identity, identity_kind, root, accent)
    VALUES (1, 'old', 'Old', '/repos/old/.git', 'git', '/repos/old', '#336699');
  INSERT INTO items (project_id, title, status, verdict, feedback)
    VALUES (1, 'first', 'feedback', 'approved', 'fine'), (1, 'second', 'open', NULL, NULL);
`;

test('a version 1 store with rows migrates to version 3 and keeps every row', (t) => {
  const path = storePath(t);
  const legacy = new DatabaseSync(path);
  legacy.exec(V1_SCHEMA);
  legacy.close();

  const store = openStore(path);
  t.after(() => store.close());

  assert.equal(store.schemaVersion(), 3);
  assert.deepEqual(
    store.listItems().map((item) => [item.title, item.status, item.feedback]),
    [
      ['second', 'open', null],
      ['first', 'feedback', 'fine'],
    ],
  );
  assert.equal(store.listProjects()[0]?.slug, 'old');

  const first = store.listItems({ status: 'feedback' })[0];
  assert.ok(first !== undefined);
  const file = store.addFile({ itemId: first.id, side: 'feedback', name: 'a.png', mime: 'image/png', size: 4, path: 'old/1/a.png' });
  assert.equal(store.getFile(file.id)?.name, 'a.png');
});

test('addFile stores the row and listFiles returns an item\'s files in insertion order', (t) => {
  const store = freshStore(t);
  const p = project(store, 'app', '/repos/app/.git');
  const item = store.addItem({ projectId: p.id, title: 'card' });

  const one = store.addFile({ itemId: item.id, side: 'card', name: 'one.png', mime: 'image/png', size: 10, path: 'app/1/one.png' });
  const two = store.addFile({ itemId: item.id, side: 'feedback', name: 'two.jpg', mime: 'image/jpeg', size: 20, path: 'app/1/two.jpg' });

  assert.deepEqual(store.listFiles(item.id).map((f) => f.id), [one.id, two.id]);
  assert.equal(one.side, 'card');
  assert.equal(two.mime, 'image/jpeg');
});

test('listFilesFor gives every requested item an entry, empty when it has no files', (t) => {
  const store = freshStore(t);
  const p = project(store, 'app', '/repos/app/.git');
  const withFile = store.addItem({ projectId: p.id, title: 'has' });
  const without = store.addItem({ projectId: p.id, title: 'has not' });
  store.addFile({ itemId: withFile.id, side: 'card', name: 'x.png', mime: 'image/png', size: 1, path: 'app/x.png' });

  const byItem = store.listFilesFor([withFile.id, without.id]);

  assert.equal(byItem.get(withFile.id)?.length, 1);
  assert.deepEqual(byItem.get(without.id), []);
  assert.equal(store.listFilesFor([]).size, 0);
});

test('addFiles rolls the whole batch back when one row fails', (t) => {
  const store = freshStore(t);
  const p = project(store, 'app', '/repos/app/.git');
  const item = store.addItem({ projectId: p.id, title: 'card' });
  store.addFile({ itemId: item.id, side: 'card', name: 'taken.png', mime: 'image/png', size: 1, path: 'app/taken.png' });

  assert.throws(() =>
    store.addFiles([
      { itemId: item.id, side: 'card', name: 'fresh.png', mime: 'image/png', size: 1, path: 'app/fresh.png' },
      { itemId: item.id, side: 'card', name: 'clash.png', mime: 'image/png', size: 1, path: 'app/taken.png' },
    ]),
  );

  assert.deepEqual(store.listFiles(item.id).map((f) => f.name), ['taken.png']);
});

test('addFile refuses an item that does not exist', (t) => {
  const store = freshStore(t);

  assert.throws(
    () => store.addFile({ itemId: 99, side: 'card', name: 'x.png', mime: 'image/png', size: 1, path: 'x.png' }),
    (error: unknown) => error instanceof StoreError && /no item #99/.test(String(error)),
  );
});

test('importItem preserves every legacy column, including timestamps', (t) => {
  const store = freshStore(t);
  const p = project(store, 'app', '/repos/app/.git');
  const item = store.importItem({
    projectId: p.id, title: 'Imported card', details: 'exact details', source: 'chris', status: 'processed',
    verdict: 'note', feedback: 'exact feedback', created_at: '2026-08-28 23:25:42',
    feedback_at: '2026-08-28 23:44:59', processed_at: '2026-08-28 23:49:45', processed_note: 'exact note', ref: 'novelhood #42',
  });
  assert.deepEqual(item, {
    id: item.id, project_id: p.id, title: 'Imported card', details: 'exact details', source: 'chris', url: null,
    ref: 'novelhood #42', retest_of: null, sort: null, status: 'processed', verdict: 'note', feedback: 'exact feedback',
    created_at: '2026-08-28 23:25:42', feedback_at: '2026-08-28 23:44:59', processed_at: '2026-08-28 23:49:45', processed_note: 'exact note', pruned_images: null, pruned_at: null,
  });
});

// Vacuous unless the projects are registered in an order the result has to
// undo, and unless one of them has no items at all: ordering by slug or by id
// would pass a test whose fixtures happen to agree with activity.
test('listProjectsByActivity puts the newest item first and never lists an archived project', (t) => {
  const path = storePath(t);
  const store = openStore(path);
  t.after(() => store.close());
  const stale = project(store, 'stale', 'a');
  const busy = project(store, 'busy', 'b');
  project(store, 'empty', 'c');
  const hidden = project(store, 'hidden', 'd');
  store.addItem({ projectId: stale.id, title: 'old' });
  store.addItem({ projectId: hidden.id, title: 'newest of all' });
  store.addItem({ projectId: busy.id, title: 'newer' });
  const db = new DatabaseSync(path);
  db.prepare("UPDATE items SET created_at = '2020-01-01 00:00:00' WHERE project_id = ?").run(stale.id);
  db.prepare("UPDATE items SET created_at = '2030-01-01 00:00:00' WHERE project_id = ?").run(busy.id);
  db.close();
  store.archiveProject('hidden');

  const order = store.listProjectsByActivity().map((entry) => entry.slug);

  assert.deepEqual(order, ['busy', 'empty', 'stale']);
});

function backdate(path: string, itemId: number, modifier: string): void {
  const db = new DatabaseSync(path);
  db.prepare("UPDATE items SET processed_at = datetime('now', ?) WHERE id = ?").run(modifier, itemId);
  db.close();
}

function processedCard(store: Store, projectId: number, title: string, files = 1, size = 100) {
  const item = store.addItem({ projectId, title, status: 'feedback', verdict: 'approved', feedback: 'ok' });
  for (let n = 0; n < files; n += 1) {
    store.addFile({ itemId: item.id, side: 'card', name: `${n}.png`, mime: 'image/png', size, path: `app/${item.id}/${n}.png` });
  }
  return store.processItem(item.id, 'done');
}

function pruneScratch(t: Ctx) {
  const path = storePath(t);
  const store = openStore(path);
  t.after(() => store.close());
  return { path, store, p: project(store, 'app', '/repos/app/.git') };
}

test('a store at version 2 migrates to version 3 and gains pruned_images and pruned_at', (t) => {
  const path = storePath(t);
  const legacy = new DatabaseSync(path);
  legacy.exec(V1_SCHEMA);
  legacy.exec(`CREATE TABLE files (
    id INTEGER PRIMARY KEY AUTOINCREMENT, item_id INTEGER NOT NULL REFERENCES items(id),
    side TEXT NOT NULL CHECK (side IN ('card', 'feedback')), name TEXT NOT NULL,
    path TEXT NOT NULL UNIQUE, mime TEXT NOT NULL, size INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE INDEX files_item ON files (item_id);
    UPDATE schema_version SET version = 2;`);
  legacy.close();

  const store = openStore(path);
  t.after(() => store.close());

  assert.equal(store.schemaVersion(), 3);
  const item = store.listItems()[0];
  assert.equal(item?.pruned_images, null);
  assert.equal(item?.pruned_at, null);
});

test('prunable returns a card processed 40 days ago and not one processed 10 days ago', (t) => {
  const { path, store, p } = pruneScratch(t);
  const old = processedCard(store, p.id, 'old');
  const recent = processedCard(store, p.id, 'recent');
  backdate(path, old.id, '-40 days');
  backdate(path, recent.id, '-10 days');

  const cards = store.prunable(30);

  assert.deepEqual(cards.map((card) => card.id), [old.id]);
  assert.equal(cards[0]?.files.length, 1);
});

test('prunable skips open and answered cards, however old, and processed cards with no files', (t) => {
  const { path, store, p } = pruneScratch(t);
  const open = store.addItem({ projectId: p.id, title: 'open' });
  store.addFile({ itemId: open.id, side: 'card', name: 'a.png', mime: 'image/png', size: 1, path: 'app/o.png' });
  const answered = store.addItem({ projectId: p.id, title: 'answered', status: 'feedback', verdict: 'note', feedback: 'x' });
  store.addFile({ itemId: answered.id, side: 'card', name: 'b.png', mime: 'image/png', size: 1, path: 'app/a.png' });
  const bare = processedCard(store, p.id, 'bare', 0);
  const db = new DatabaseSync(path);
  db.exec("UPDATE items SET created_at = datetime('now', '-90 days'), feedback_at = datetime('now', '-90 days')");
  db.close();
  backdate(path, bare.id, '-40 days');

  assert.deepEqual(store.prunable(30), []);
});

test('prunable skips a card that another card retests, whatever the retest status', (t) => {
  const { path, store, p } = pruneScratch(t);
  const before = processedCard(store, p.id, 'before');
  store.addItem({ projectId: p.id, title: 'retest', retestOf: before.id });
  backdate(path, before.id, '-40 days');

  assert.deepEqual(store.prunable(30), []);
});

test('prunable boundary: exactly N days is not eligible, N days plus a minute is', (t) => {
  const { path, store, p } = pruneScratch(t);
  const card = processedCard(store, p.id, 'edge');
  const db = new DatabaseSync(path);
  db.prepare("UPDATE items SET processed_at = '2026-09-03 12:00:00' WHERE id = ?").run(card.id);
  db.close();

  assert.deepEqual(store.prunable(30, undefined, '2026-10-03 12:00:00'), []);
  assert.equal(store.prunable(30, undefined, '2026-10-03 12:01:00').length, 1);
});

test('prunable scopes to one project when given its id', (t) => {
  const { path, store, p } = pruneScratch(t);
  const other = project(store, 'other', '/repos/other/.git');
  const mine = processedCard(store, p.id, 'mine');
  const theirs = processedCard(store, other.id, 'theirs');
  backdate(path, mine.id, '-40 days');
  backdate(path, theirs.id, '-40 days');

  assert.deepEqual(store.prunable(30, other.id).map((card) => card.id), [theirs.id]);
  assert.equal(store.prunable(30).length, 2);
});

test('prunable rejects an older-than that is not a positive whole number', (t) => {
  const { store } = pruneScratch(t);

  assert.throws(() => store.prunable(0), StoreError);
  assert.throws(() => store.prunable(1.5), StoreError);
});

test('pruneFiles deletes only the listed eligible cards\' rows and records count and time', (t) => {
  const { path, store, p } = pruneScratch(t);
  const a = processedCard(store, p.id, 'a', 2);
  const b = processedCard(store, p.id, 'b', 1);
  const other = processedCard(store, p.id, 'other', 1);
  for (const card of [a, b, other]) {
    backdate(path, card.id, '-40 days');
  }

  const removed = store.pruneFiles([a.id, b.id], 30);

  assert.equal(removed.length, 3);
  assert.deepEqual(store.listFiles(a.id), []);
  assert.deepEqual(store.listFiles(b.id), []);
  assert.equal(store.listFiles(other.id).length, 1);
  assert.equal(store.getItem(a.id)?.pruned_images, 2);
  assert.match(store.getItem(a.id)?.pruned_at ?? '', /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/);
  assert.equal(store.getItem(other.id)?.pruned_images, null);
});

test('pruneFiles leaves a card alone that stopped being eligible after it was listed', (t) => {
  const { path, store, p } = pruneScratch(t);
  const card = processedCard(store, p.id, 'listed');
  const retested = processedCard(store, p.id, 'retested');
  backdate(path, card.id, '-40 days');
  backdate(path, retested.id, '-40 days');
  const listed = store.prunable(30).map((c) => c.id);
  assert.equal(listed.length, 2);

  store.addItem({ projectId: p.id, title: 'retest', retestOf: retested.id });
  const db = new DatabaseSync(path);
  db.prepare("UPDATE items SET status = 'feedback', processed_at = NULL WHERE id = ?").run(card.id);
  db.close();

  assert.deepEqual(store.pruneFiles(listed, 30), []);
  assert.equal(store.listFiles(card.id).length, 1);
  assert.equal(store.listFiles(retested.id).length, 1);
  assert.equal(store.getItem(card.id)?.pruned_images, null);
});

test('a pruned card is no longer prunable', (t) => {
  const { path, store, p } = pruneScratch(t);
  const card = processedCard(store, p.id, 'once');
  backdate(path, card.id, '-40 days');

  store.pruneFiles([card.id], 30);

  assert.deepEqual(store.prunable(30), []);
});

test('prunableBytes sums sizes over every project and ignores ineligible cards', (t) => {
  const { path, store, p } = pruneScratch(t);
  const other = project(store, 'other', '/repos/other/.git');
  const a = processedCard(store, p.id, 'a', 2, 1000);
  const b = processedCard(store, other.id, 'b', 1, 500);
  processedCard(store, p.id, 'recent', 1, 7);
  backdate(path, a.id, '-40 days');
  backdate(path, b.id, '-40 days');

  assert.equal(store.prunableBytes(30), 2500);
  assert.equal(pruneScratch(t).store.prunableBytes(30), 0);
});

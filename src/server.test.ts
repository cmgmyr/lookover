import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { connect, type AddressInfo } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import vm from 'node:vm';

import { accentOnDark, accentOnLight, NEUTRAL_ACCENT } from './accent.ts';
import { newCardsLine, renderPage } from './page.ts';
import { createServer } from './server.ts';
import type { ItemWithProject } from './commands/render.ts';
import { runServe } from './commands/serve.ts';
import { openStore, type Item, type Store } from './store.ts';

async function listen(server: ReturnType<typeof createServer>): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

async function get(url: string, init?: RequestInit): Promise<Response> {
  return fetch(url, init);
}

test('serves redirects, project pages, all pages and counts', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'lookover-server-'));
  const store = openStore(join(dir, 'queue.sqlite'));
  const project = store.registerProject({ slug: 'app', name: 'App', identity: `${dir}/.git`, identity_kind: 'git', root: '/repos/app', accent: '#336699' });
  const item = store.addItem({ projectId: project.id, title: 'Open card', details: '**Try** the button', source: 'lane', url: 'https://app.test', ref: 'todo-1', sort: 1 });
  execFileSync(process.execPath, [fileURLToPath(new URL('../bin/lookover.ts', import.meta.url)), 'add', '--project', 'app', '--title', 'Unsafe URL', '--details', 'Unsafe URL card', '--url', 'javascript:alert(1)'], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    env: { ...process.env, LOOKOVER_HOME: dir },
    stdio: 'ignore',
  });
  const server = createServer(store);
  const base = await listen(server);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

  const root = await get(`${base}/`, { redirect: 'manual' });
  assert.equal(root.status, 303);
  assert.equal(root.headers.get('location'), '/p/app');
  const page = await get(`${base}/p/app`);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /Awaiting your test/);
  assert.match(html, /Send to the agent/);
  assert.doesNotMatch(html, /Claude/);
  assert.match(html, /&lt;|<strong>Try<\/strong>/);
  assert.match(html, /href="https:\/\/app\.test"/);
  assert.match(html, /rel="noopener noreferrer"/);
  assert.match(html, /meta name="referrer" content="no-referrer"/);
  assert.match(html, /javascript:alert\(1\)/);
  assert.doesNotMatch(html, /href="javascript:alert\(1\)"/);
  assert.match(html, /let initial=2;/);
  assert.match(html, /<p id="new-count" class="new-count" hidden><a href=""><\/a><\/p>/);
  assert.match(html, /'1 new card, reload'/);
  assert.match(html, /new cards, reload/);
  assert.equal((await get(`${base}/all`)).status, 200);
  const allHtml = await (await get(`${base}/all`)).text();
  assert.match(allHtml, /class="project-badge">App<\/span>/);
  const projectHtml = await (await get(`${base}/p/app`)).text();
  assert.doesNotMatch(projectHtml, /class="project-badge">/);
  assert.deepEqual(await (await get(`${base}/api/counts?project=app`)).json(), { open: 2, feedback: 0, processed: 0 });
  assert.equal(item.status, 'open');
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

test('new cards line reports only positive deltas with singular wording', () => {
  assert.equal(newCardsLine(0), undefined);
  assert.equal(newCardsLine(1), '1 new card, reload');
  assert.equal(newCardsLine(2), '2 new cards, reload');
  assert.equal(newCardsLine(-1), undefined);
});

test('feedback route enforces non-empty feedback except approved and saves answers', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'lookover-server-'));
  const store = openStore(join(dir, 'queue.sqlite'));
  const project = store.registerProject({ slug: 'app', name: 'App', identity: `${dir}/.git`, identity_kind: 'git', root: '/repos/app', accent: '#336699' });
  const item = store.addItem({ projectId: project.id, title: 'Open card' });
  const server = createServer(store);
  const base = await listen(server);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

  const bad = await get(`${base}/items/${item.id}/feedback`, { method: 'POST', body: new URLSearchParams({ verdict: 'note', feedback: '' }) });
  assert.equal(bad.status, 400);
  const saved = await get(`${base}/items/${item.id}/feedback`, { method: 'POST', body: new URLSearchParams({ verdict: 'approved', feedback: '' }), redirect: 'manual' });
  assert.equal(saved.status, 303);
  assert.equal(store.getItem(item.id)?.status, 'feedback');
  assert.equal(store.getItem(item.id)?.verdict, 'approved');
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

test('new-item route creates the exact tester-filed feedback row and rejects invalid titles', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'lookover-server-'));
  const store = openStore(join(dir, 'queue.sqlite'));
  const project = store.registerProject({ slug: 'app', name: 'App', identity: `${dir}/.git`, identity_kind: 'git', root: '/repos/app', accent: '#336699' });
  const server = createServer(store);
  const base = await listen(server);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

  const allPage = await get(`${base}/all`);
  const allHtml = await allPage.text();
  assert.match(allHtml, /name="project" value="app"/);
  const response = await get(`${base}/items/new`, { method: 'POST', body: new URLSearchParams({ project: 'app', title: 'Found it', body: 'The footer jumps' }), redirect: 'manual' });
  assert.equal(response.status, 303);
  const created = store.listItems({ projectId: project.id })[0];
  assert.equal(created?.status, 'feedback');
  assert.equal(created?.verdict, 'note');
  assert.equal(created?.source, 'chris');
  assert.equal(created?.feedback, 'The footer jumps');
  const invalid = await get(`${base}/items/new`, { method: 'POST', body: new URLSearchParams({ project: 'app', title: '', body: '' }) });
  assert.equal(invalid.status, 400);
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

test('token gate covers pages, counts and posts', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'lookover-server-'));
  const store = openStore(join(dir, 'queue.sqlite'));
  const project = store.registerProject({ slug: 'app', name: 'App', identity: `${dir}/.git`, identity_kind: 'git', root: '/repos/app', accent: '#336699' });
  const item = store.addItem({ projectId: project.id, title: 'Open card' });
  const server = createServer(store, { token: 'secret' });
  const base = await listen(server);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  assert.equal((await get(`${base}/p/app`)).status, 401);
  assert.equal((await get(`${base}/api/counts?project=app`)).status, 401);
  assert.equal((await get(`${base}/items/${item.id}/feedback?t=secret`, { method: 'POST', body: new URLSearchParams({ verdict: 'approved', feedback: '' }), redirect: 'manual' })).status, 303);
  assert.equal((await get(`${base}/p/app?t=secret`)).status, 200);
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

test('serve refuses a non-loopback host without a token', () => {
  assert.throws(() => runServe(['--host', '0.0.0.0']), /upload endpoint on the Wi-Fi/);
});

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(24, 9)]);
const GIF = Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(24, 4)]);

function upload(...parts: { name: string; data: Buffer; type?: string }[]): FormData {
  const form = new FormData();
  form.set('verdict', 'needs-work');
  form.set('feedback', 'see the photos');
  for (const part of parts) {
    form.append('photo', new Blob([new Uint8Array(part.data)], { type: part.type ?? 'image/png' }), part.name);
  }
  return form;
}

function scratch(t: { after: (fn: () => void) => void }, serverOptions: { token?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'lookover-server-'));
  const store = openStore(join(dir, 'queue.sqlite'));
  const project = store.registerProject({ slug: 'app', name: 'App', identity: `${dir}/.git`, identity_kind: 'git', root: '/repos/app', accent: '#336699' });
  const item = store.addItem({ projectId: project.id, title: 'Open card' });
  const server = createServer(store, { ...serverOptions, home: dir });
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { dir, store, project, item, server };
}

function filesOnDisk(dir: string): string[] {
  const root = join(dir, 'files');
  return existsSync(root) ? (readdirSync(root, { recursive: true }) as string[]).filter((entry) => /\.\w+$/.test(entry)) : [];
}

test('multipart feedback with two photos saves the verdict, stores both files and shows them on the waiting card', async (t) => {
  const { dir, store, item, server } = scratch(t);
  const base = await listen(server);

  const response = await get(`${base}/items/${item.id}/feedback`, { method: 'POST', body: upload({ name: 'a.png', data: PNG }, { name: 'b.gif', data: GIF, type: 'image/gif' }), redirect: 'manual' });

  assert.equal(response.status, 303);
  assert.equal(store.getItem(item.id)?.verdict, 'needs-work');
  const files = store.listFiles(item.id);
  assert.deepEqual(files.map((f) => [f.side, f.name, f.mime]), [['feedback', 'a.png', 'image/png'], ['feedback', 'b.gif', 'image/gif']]);
  assert.equal(filesOnDisk(dir).length, 2);
  const html = await (await get(`${base}/p/app`)).text();
  assert.match(html, /<div class="shots"><a href="\/files\/1"><img src="\/files\/1" alt="a\.png" loading="lazy"><\/a><a href="\/files\/2">/);
  const cardForms = html.match(/<form class="card" id="item-\d+"[^>]*>/g) ?? [];
  assert.ok(cardForms.length > 0);
  for (const form of cardForms) assert.match(form, /enctype="multipart\/form-data"/);
  assert.match(html, /<form class="card" method="post" enctype="multipart\/form-data" action="\/items\/new"/);
  assert.match(html, /type="file" name="photo" accept="image\/jpeg,image\/png,image\/webp,image\/gif" multiple/);
});

test('GET /files/<id> streams the bytes with the stored mime, inline, cacheable and nosniff', async (t) => {
  const { store, item, server } = scratch(t);
  const base = await listen(server);
  await get(`${base}/items/${item.id}/feedback`, { method: 'POST', body: upload({ name: 'a.png', data: PNG }) });
  const id = store.listFiles(item.id)[0]?.id;

  const response = await get(`${base}/files/${id}`);

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'image/png');
  assert.equal(response.headers.get('content-disposition'), 'inline');
  assert.equal(response.headers.get('cache-control'), 'private, max-age=31536000');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), PNG);
});

test('GET /files/<id> is 404 for an unknown id and for a row whose file is gone', async (t) => {
  const { dir, store, item, server } = scratch(t);
  const base = await listen(server);
  await get(`${base}/items/${item.id}/feedback`, { method: 'POST', body: upload({ name: 'a.png', data: PNG }) });
  const row = store.listFiles(item.id)[0];
  assert.ok(row !== undefined);

  assert.equal((await get(`${base}/files/999`)).status, 404);
  rmSync(join(dir, 'files', row.path));
  assert.equal((await get(`${base}/files/${row.id}`)).status, 404);
});

test('GET /files/<id> refuses a row whose path points outside files/', async (t) => {
  const { store, item, server } = scratch(t);
  const base = await listen(server);
  const row = store.addFile({ itemId: item.id, side: 'card', name: 'evil.png', mime: 'image/png', size: 1, path: '../queue.sqlite' });

  assert.equal((await get(`${base}/files/${row.id}`)).status, 404);
});

test('the token gate covers /files/<id>', async (t) => {
  const { store, item, server } = scratch(t, { token: 'secret' });
  const base = await listen(server);
  await get(`${base}/items/${item.id}/feedback?t=secret`, { method: 'POST', body: upload({ name: 'a.png', data: PNG }) });
  const id = store.listFiles(item.id)[0]?.id;

  assert.equal((await get(`${base}/files/${id}`)).status, 401);
  assert.equal((await get(`${base}/files/${id}?t=secret`)).status, 200);
  const html = await (await get(`${base}/p/app?t=secret`)).text();
  assert.match(html, new RegExp(`<img src="/files/${id}\\?t=secret"`));
});

test('a photo over 10 MB is a 413 and stores nothing, not even the verdict', async (t) => {
  const { dir, store, item, server } = scratch(t);
  const base = await listen(server);
  const big = Buffer.concat([PNG, Buffer.alloc(11 * 1024 * 1024)]);

  const response = await get(`${base}/items/${item.id}/feedback`, { method: 'POST', body: upload({ name: 'ok.png', data: PNG }, { name: 'big.png', data: big }) });

  assert.equal(response.status, 413);
  assert.match(await response.text(), /big\.png is 11\.0 MB/);
  assert.equal(store.getItem(item.id)?.status, 'open');
  assert.equal(store.listFiles(item.id).length, 0);
  assert.deepEqual(filesOnDisk(dir), []);
});

test('six photos in one request is a 413 and stores nothing', async (t) => {
  const { dir, store, item, server } = scratch(t);
  const base = await listen(server);
  const six = Array.from({ length: 6 }, (_, i) => ({ name: `${i}.png`, data: PNG }));

  const response = await get(`${base}/items/${item.id}/feedback`, { method: 'POST', body: upload(...six) });

  assert.equal(response.status, 413);
  assert.equal(store.listFiles(item.id).length, 0);
  assert.deepEqual(filesOnDisk(dir), []);
});

test('a .txt renamed .png is a 400 by its bytes and stores nothing', async (t) => {
  const { dir, store, item, server } = scratch(t);
  const base = await listen(server);

  const response = await get(`${base}/items/${item.id}/feedback`, { method: 'POST', body: upload({ name: 'a.png', data: PNG }, { name: 'fake.png', data: Buffer.from('plain text') }) });

  assert.equal(response.status, 400);
  assert.match(await response.text(), /fake\.png is text/);
  assert.equal(store.getItem(item.id)?.status, 'open');
  assert.deepEqual(filesOnDisk(dir), []);
});

test('an untouched file input (empty filename, no bytes) is no upload and no error', async (t) => {
  const { store, item, server } = scratch(t);
  const base = await listen(server);
  const form = new FormData();
  form.set('verdict', 'approved');
  form.set('feedback', '');
  form.append('photo', new Blob([], { type: 'application/octet-stream' }), '');

  const response = await get(`${base}/items/${item.id}/feedback`, { method: 'POST', body: form, redirect: 'manual' });

  assert.equal(response.status, 303);
  assert.equal(store.getItem(item.id)?.verdict, 'approved');
  assert.equal(store.listFiles(item.id).length, 0);
});

test('a multipart body with only fields works like the urlencoded form', async (t) => {
  const { store, item, server } = scratch(t);
  const base = await listen(server);

  const response = await get(`${base}/items/${item.id}/feedback`, { method: 'POST', body: upload(), redirect: 'manual' });

  assert.equal(response.status, 303);
  assert.equal(store.getItem(item.id)?.feedback, 'see the photos');
});

test('a truncated multipart body is a 400', async (t) => {
  const { item, server } = scratch(t);
  const base = await listen(server);

  const response = await get(`${base}/items/${item.id}/feedback`, {
    method: 'POST',
    headers: { 'content-type': 'multipart/form-data; boundary=zz' },
    body: '--zz\r\nContent-Disposition: form-data; name="feedback"\r\n\r\ncut off',
  });

  assert.equal(response.status, 400);
});

test('a declared body over the cap is a 413 before any of it is read', async (t) => {
  const { item, server } = scratch(t);
  const base = await listen(server);

  const head = await new Promise<string>((resolve) => {
    let seen = '';
    const socket = connect(Number(new URL(base).port), '127.0.0.1');
    socket.on('data', (data) => { seen += data.toString('latin1'); resolve(seen); socket.destroy(); });
    // Headers only: the body is promised and never sent, so a server that
    // waits for it never answers.
    socket.write(`POST /items/${item.id}/feedback HTTP/1.1\r\nhost: x\r\ncontent-type: multipart/form-data; boundary=zz\r\ncontent-length: ${56 * 1024 * 1024}\r\n\r\n`);
    setTimeout(() => { resolve('no answer'); socket.destroy(); }, 1000);
  });

  assert.match(head, /^HTTP\/1\.1 413/);
});

test('a chunked body that passes the cap mid-stream is a 413', async (t) => {
  const { item, server } = scratch(t);
  const base = await listen(server);
  const chunk = Buffer.alloc(1024 * 1024, 0x61);
  let sent = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      sent += 1;
      controller.enqueue(chunk);
      if (sent === 200) controller.close();
    },
  });

  const response = await get(`${base}/items/${item.id}/feedback`, {
    method: 'POST',
    headers: { 'content-type': 'multipart/form-data; boundary=zz' },
    body,
    duplex: 'half',
  } as RequestInit);

  assert.equal(response.status, 413);
});

test('a tester-filed card with a photo lands as feedback with the photo on the feedback side', async (t) => {
  const { store, project, server } = scratch(t);
  const base = await listen(server);
  const form = new FormData();
  form.set('project', 'app');
  form.set('title', 'Found it');
  form.set('body', 'footer jumps');
  form.append('photo', new Blob([new Uint8Array(PNG)], { type: 'image/png' }), 'footer.png');

  const response = await get(`${base}/items/new`, { method: 'POST', body: form, redirect: 'manual' });

  assert.equal(response.status, 303);
  const created = store.listItems({ projectId: project.id, status: 'feedback' })[0];
  assert.ok(created !== undefined);
  assert.equal(store.listFiles(created.id)[0]?.side, 'feedback');
  assert.match(await (await get(`${base}/p/app`)).text(), /alt="footer\.png"/);
});

test('a tester-filed card with a bad photo is a 400 and no card is filed', async (t) => {
  const { store, project, server } = scratch(t);
  const base = await listen(server);
  const form = new FormData();
  form.set('project', 'app');
  form.set('title', 'Found it');
  form.set('body', '');
  form.append('photo', new Blob(['nope'], { type: 'image/png' }), 'bad.png');

  const response = await get(`${base}/items/new`, { method: 'POST', body: form });

  assert.equal(response.status, 400);
  assert.equal(store.listItems({ projectId: project.id, status: 'feedback' }).length, 0);
});

test('an agent card shows its card-side images after the details, not the feedback side', async (t) => {
  const { dir, store, item, server } = scratch(t);
  const base = await listen(server);
  const { storeImage } = await import('./files.ts');
  storeImage(store, dir, 'app', item.id, 'card', 'before.png', PNG);

  const html = await (await get(`${base}/p/app`)).text();

  assert.match(html, /class="details"><\/div><div class="shots"><a href="\/files\/1"><img src="\/files\/1" alt="before\.png"/);
});

test('the upload strip escapes a hostile file name', async (t) => {
  const { store, item, server } = scratch(t);
  const base = await listen(server);
  store.addFile({ itemId: item.id, side: 'card', name: '"><script>alert(1)</script>.png', mime: 'image/png', size: 1, path: 'x.png' });

  const html = await (await get(`${base}/p/app`)).text();

  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
  assert.match(html, /alt="&quot;&gt;&lt;script&gt;/);
});

test('aborting a /files/<id> download mid-body leaves no file descriptor open', async (t) => {
  const { dir, store, item, server } = scratch(t);
  const base = await listen(server);
  const { storeImage } = await import('./files.ts');
  const row = storeImage(store, dir, 'app', item.id, 'card', 'big.png', Buffer.concat([PNG, Buffer.alloc(1024 * 1024)]));
  const port = Number(new URL(base).port);
  const open = (): number => readdirSync('/dev/fd').length;
  const before = open();

  for (let i = 0; i < 10; i += 1) {
    await new Promise<void>((resolve) => {
      const socket = connect(port, '127.0.0.1', () => socket.write(`GET /files/${row.id} HTTP/1.1\r\nhost: x\r\n\r\n`));
      socket.once('data', () => socket.destroy());
      socket.once('close', () => resolve());
    });
  }
  await new Promise((resolve) => setTimeout(resolve, 200));

  assert.ok(open() <= before, `${open() - before} descriptors left open`);
});

test('a chunked upload past the cap is drained, so the client reads the 413 instead of a reset', async (t) => {
  const { item, server } = scratch(t);
  const base = await listen(server);
  const chunk = Buffer.alloc(1024 * 1024, 0x61);
  const started = Date.now();

  const outcome = await new Promise<{ head: string; error?: Error }>((resolve) => {
    let head = '';
    const socket = connect(Number(new URL(base).port), '127.0.0.1');
    socket.on('data', (data) => { head += data.toString('latin1'); });
    socket.once('error', (error) => resolve({ head, error }));
    socket.once('close', () => resolve({ head }));
    socket.write(`POST /items/${item.id}/feedback HTTP/1.1\r\nhost: x\r\ncontent-type: multipart/form-data; boundary=zz\r\ntransfer-encoding: chunked\r\n\r\n`);
    let sent = 0;
    const pump = (): void => {
      while (sent < 90) {
        sent += 1;
        socket.write(`${chunk.length.toString(16)}\r\n`);
        const room = socket.write(chunk);
        socket.write('\r\n');
        if (!room) {
          socket.once('drain', pump);
          return;
        }
      }
      socket.write('0\r\n\r\n', () => setTimeout(() => { resolve({ head }); socket.destroy(); }, 100));
    };
    pump();
  });

  assert.equal(outcome.error, undefined, String(outcome.error));
  assert.match(outcome.head, /^HTTP\/1\.1 413/);
  assert.ok(Date.now() - started < 3000, 'the drain should not run into its 5 s timer');
});

test('only files in the photo field are stored; a file under another field name is ignored', async (t) => {
  const { dir, store, item, server } = scratch(t);
  const base = await listen(server);
  const form = new FormData();
  form.set('verdict', 'approved');
  form.set('feedback', '');
  form.append('attachment', new Blob([new Uint8Array(PNG)], { type: 'image/png' }), 'sneaky.png');

  const response = await get(`${base}/items/${item.id}/feedback`, { method: 'POST', body: form, redirect: 'manual' });

  assert.equal(response.status, 303);
  assert.equal(store.listFiles(item.id).length, 0);
  assert.deepEqual(filesOnDisk(dir), []);
});

test('a urlencoded body over 1 MB is a 413 and saves nothing', async (t) => {
  const { store, item, server } = scratch(t);
  const base = await listen(server);

  const response = await get(`${base}/items/${item.id}/feedback`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: `verdict=note&feedback=${'a'.repeat(1024 * 1024)}`,
  });

  assert.equal(response.status, 413);
  assert.equal(store.getItem(item.id)?.status, 'open');
});

test('a retest link lands on the processed card it names', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'lookover-server-'));
  const store = openStore(join(dir, 'queue.sqlite'));
  const project = store.registerProject({ slug: 'app', name: 'App', identity: `${dir}/.git`, identity_kind: 'git', root: '/repos/app', accent: '#336699' });
  const old = store.addItem({ projectId: project.id, title: 'The first go' });
  store.saveFeedback(old.id, { verdict: 'needs-work', feedback: 'not yet' });
  store.processItem(old.id, 'fixed in PR #1');
  store.addItem({ projectId: project.id, title: 'The retest', retestOf: old.id });
  const server = createServer(store);
  const base = await listen(server);
  t.after(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); store.close(); rmSync(dir, { recursive: true, force: true }); });

  const html = await (await get(`${base}/p/app`)).text();

  assert.match(html, new RegExp(`<a href="#item-${old.id}">#${old.id}</a>`));
  assert.match(html, new RegExp(`<div class="done" id="item-${old.id}">`));
});

test('the header names the directory the project lives in, shortened to ~ under HOME', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'lookover-server-'));
  const store = openStore(join(dir, 'queue.sqlite'));
  store.registerProject({ slug: 'alpha-app', name: 'Alpha App', identity: `${dir}/.git`, identity_kind: 'git', root: join(homedir(), 'Code', 'alpha', 'alpha-app'), accent: '#336699' });
  const server = createServer(store);
  const base = await listen(server);
  t.after(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); store.close(); rmSync(dir, { recursive: true, force: true }); });

  const html = await (await get(`${base}/p/alpha-app`)).text();

  assert.match(html, /<title>Alpha App · Lookover<\/title>/);
  assert.match(html, /<h1>Alpha App<\/h1>/);
  assert.match(html, /<p class="sub">alpha-app · ~\/Code\/alpha<\/p>/);
});

test('a root outside HOME keeps its absolute parent in the header', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'lookover-server-'));
  const store = openStore(join(dir, 'queue.sqlite'));
  store.registerProject({ slug: 'app', name: 'App', identity: `${dir}/.git`, identity_kind: 'git', root: '/srv/repos/app', accent: '#336699' });
  const server = createServer(store);
  const base = await listen(server);
  t.after(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); store.close(); rmSync(dir, { recursive: true, force: true }); });

  assert.match(await (await get(`${base}/p/app`)).text(), /<p class="sub">app · \/srv\/repos<\/p>/);
});

// /all's counterpart to a project page's place line: how many projects
// there are to jump between, singular at one, omitted with none.
test('/all shows how many projects there are, and omits the line when there are none', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'lookover-server-'));
  const store = openStore(join(dir, 'queue.sqlite'));
  const server = createServer(store);
  const base = await listen(server);
  t.after(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); store.close(); rmSync(dir, { recursive: true, force: true }); });

  assert.match(await (await get(`${base}/all`)).text(), /<h1>All projects<\/h1><\/header>/);
  assert.doesNotMatch(await (await get(`${base}/all`)).text(), /<p class="sub">/);

  store.registerProject({ slug: 'one', name: 'One', identity: `${dir}/.one`, identity_kind: 'git', root: '/repos/one', accent: '#336699' });
  assert.match(await (await get(`${base}/all`)).text(), /<h1>All projects<\/h1><p class="sub">1 project<\/p>/);

  store.registerProject({ slug: 'two', name: 'Two', identity: `${dir}/.two`, identity_kind: 'git', root: '/repos/two', accent: '#336699' });
  assert.match(await (await get(`${base}/all`)).text(), /<h1>All projects<\/h1><p class="sub">2 projects<\/p>/);
});

test('the favicon and the selected picker segment carry the project accent, theme by theme', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'lookover-server-'));
  const store = openStore(join(dir, 'queue.sqlite'));
  const project = store.registerProject({ slug: 'app', name: 'App', identity: `${dir}/.git`, identity_kind: 'git', root: '/repos/app', accent: '#336699' });
  store.addItem({ projectId: project.id, title: 'Open card' });
  const server = createServer(store);
  const base = await listen(server);
  t.after(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); store.close(); rmSync(dir, { recursive: true, force: true }); });
  const light = accentOnLight('#336699');
  const dark = accentOnDark('#336699');

  const html = await (await get(`${base}/p/app`)).text();

  assert.match(html, /<link rel="icon" href="data:image\/svg\+xml,/);
  assert.match(html, /<link rel="icon" media="\(prefers-color-scheme:dark\)" href="data:image\/svg\+xml,/);
  const icons = [...html.matchAll(/<link rel="icon"[^>]* href="data:image\/svg\+xml,([^"]+)">/g)].map((m) => decodeURIComponent(m[1] ?? ''));
  assert.equal(icons.length, 2);
  assert.match(icons[0] ?? '', new RegExp(`<circle [^>]*stroke="${light}"`), `the light favicon's lens is not ${light}`);
  assert.match(icons[1] ?? '', new RegExp(`<circle [^>]*stroke="${dark}"`), `the dark favicon's lens is not ${dark}`);
  assert.ok(html.includes(`--page-accent:${light}`), `the light theme accent is not ${light}`);
  assert.ok(html.includes(`--page-accent:${dark}`), `the dark theme accent is not ${dark}`);
  assert.match(html, new RegExp(`<a style="--bl:${light};[^"]*" class="tile selected" href="/p/app"><span class="t">App</span><span class="n" data-count-for="app">1</span></a>`));
});

// Four projects, one more than the row can hold. Dates fix recency into an
// order (one oldest .. four newest) that disagrees with the open-count order
// (one highest .. three lowest), so a picker that fell back to recency would
// show a different set of tiles, not just a different order of the same set.
test('tiles rank by open count, descending, with recency breaking a tie', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'lookover-server-'));
  const store = openStore(join(dir, 'queue.sqlite'));
  const made: Record<string, number> = {};
  for (const slug of ['one', 'two', 'three', 'four']) {
    made[slug] = store.registerProject({ slug, name: slug, identity: `${dir}/.${slug}`, identity_kind: 'git', root: `/repos/${slug}`, accent: '#336699' }).id;
  }
  const counts: Record<string, number> = { one: 3, two: 2, three: 1, four: 1 };
  for (const [slug, n] of Object.entries(counts)) {
    for (let i = 0; i < n; i += 1) store.addItem({ projectId: made[slug] ?? 0, title: `card ${i} for ${slug}` });
  }
  // Every row is written in the same second, so activity has to be dated by
  // hand or the tiebreak decides and the test measures insertion order.
  const db = new DatabaseSync(join(dir, 'queue.sqlite'));
  db.prepare("UPDATE projects SET created_at = '2020-01-01 00:00:00'").run();
  for (const [year, slug] of [['2021', 'one'], ['2022', 'two'], ['2023', 'three'], ['2024', 'four']] as const) {
    db.prepare(`UPDATE items SET created_at = '${year}-01-01 00:00:00' WHERE project_id = ?`).run(made[slug] ?? 0);
  }
  db.close();
  const server = createServer(store);
  const base = await listen(server);
  t.after(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); store.close(); rmSync(dir, { recursive: true, force: true }); });
  const tiles = (html: string): string[] => [...html.matchAll(/class="tile[^"]*" href="([^"]+)"/g)].map((match) => match[1] ?? '');

  // one (3) > two (2) > four (1, newer) > three (1, older): three is excluded.
  const all = await (await get(`${base}/all`)).text();
  assert.deepEqual(tiles(all), ['/all', '/p/one', '/p/two', '/p/four']);

  // three ranks 4th, so its own page replaces the last ranked slot (four)
  // rather than adding a fifth tile: the row stays four tiles wide.
  const excluded = await (await get(`${base}/p/three`)).text();
  assert.deepEqual(tiles(excluded), ['/all', '/p/one', '/p/two', '/p/three']);
  assert.match(excluded, /<a style="[^"]*" class="tile selected" href="\/p\/three">/);

  // four is already ranked in, so its own page adds nothing.
  const included = await (await get(`${base}/p/four`)).text();
  assert.deepEqual(tiles(included), ['/all', '/p/one', '/p/two', '/p/four']);
  assert.equal((included.match(/class="tile selected"/g) ?? []).length, 1);
});

// Five projects, one busy and four quiet. Dates fix the quiet ones' recency
// (a-newest .. d-oldest) since they tie at zero. Vacuous without all three
// pages: a picker that always showed 4 tiles, or always the same 3 projects,
// would pass any one of them alone.
test('zero-open projects fill the remaining tile slots after the busiest, capped at a fixed row width', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'lookover-server-'));
  const store = openStore(join(dir, 'queue.sqlite'));
  const busy = store.registerProject({ slug: 'busy', name: 'busy', identity: `${dir}/.busy`, identity_kind: 'git', root: '/repos/busy', accent: '#336699' });
  const made: Record<string, number> = { busy: busy.id };
  for (const slug of ['quiet-a', 'quiet-b', 'quiet-c', 'quiet-d']) {
    made[slug] = store.registerProject({ slug, name: slug, identity: `${dir}/.${slug}`, identity_kind: 'git', root: `/repos/${slug}`, accent: '#336699' }).id;
  }
  for (let i = 0; i < 5; i += 1) store.addItem({ projectId: busy.id, title: `card ${i}` });
  const db = new DatabaseSync(join(dir, 'queue.sqlite'));
  for (const [year, slug] of [['2024', 'quiet-a'], ['2023', 'quiet-b'], ['2022', 'quiet-c'], ['2021', 'quiet-d']] as const) {
    db.prepare("UPDATE projects SET created_at = ? WHERE id = ?").run(`${year}-01-01 00:00:00`, made[slug] ?? 0);
  }
  db.close();
  const server = createServer(store);
  const base = await listen(server);
  t.after(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); store.close(); rmSync(dir, { recursive: true, force: true }); });
  const tiles = (html: string): string[] => [...html.matchAll(/class="tile[^"]*" href="([^"]+)"/g)].map((match) => match[1] ?? '');

  // busy (5) > quiet-a (0, newest) > quiet-b (0, next): quiet-c and quiet-d
  // never reach a tile on any page below.
  const all = await (await get(`${base}/all`)).text();
  assert.deepEqual(tiles(all), ['/all', '/p/busy', '/p/quiet-a', '/p/quiet-b']);

  // Already ranked in: its own page shows the same four tiles.
  const top3 = await (await get(`${base}/p/busy`)).text();
  assert.deepEqual(tiles(top3), ['/all', '/p/busy', '/p/quiet-a', '/p/quiet-b']);
  assert.match(top3, /<a style="[^"]*" class="tile selected" href="\/p\/busy">/);

  // Not ranked in: replaces the last slot (quiet-b), still four tiles.
  const nonTop3 = await (await get(`${base}/p/quiet-c`)).text();
  assert.deepEqual(tiles(nonTop3), ['/all', '/p/busy', '/p/quiet-a', '/p/quiet-c']);
  assert.match(nonTop3, /<a style="[^"]*" class="tile selected" href="\/p\/quiet-c">/);
});

// Vacuous without the five-project half: a page that never rendered the
// select at all would pass the two-project assertion on its own.
test('the select is left out when every project already has a tile', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'lookover-server-'));
  const store = openStore(join(dir, 'queue.sqlite'));
  for (const slug of ['one', 'two']) {
    const project = store.registerProject({ slug, name: slug, identity: `${dir}/.${slug}`, identity_kind: 'git', root: `/repos/${slug}`, accent: '#336699' });
    store.addItem({ projectId: project.id, title: `card for ${slug}` });
  }
  const server = createServer(store);
  const base = await listen(server);
  t.after(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); store.close(); rmSync(dir, { recursive: true, force: true }); });

  const html = await (await get(`${base}/all`)).text();

  assert.equal((html.match(/class="tile[ "]/g) ?? []).length, 3);
  assert.doesNotMatch(html, /class="jump"/);
});

// The row is now fixed-width regardless of open counts, so the select's
// presence tracks project count against TILE_COUNT, not who has anything
// open: four quiet projects still leave one without a tile.
test('the select still renders when there are more projects than tiles, even with nothing open anywhere', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'lookover-server-'));
  const store = openStore(join(dir, 'queue.sqlite'));
  for (const slug of ['one', 'two', 'three', 'four']) {
    store.registerProject({ slug, name: slug, identity: `${dir}/.${slug}`, identity_kind: 'git', root: `/repos/${slug}`, accent: '#336699' });
  }
  const server = createServer(store);
  const base = await listen(server);
  t.after(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); store.close(); rmSync(dir, { recursive: true, force: true }); });

  const html = await (await get(`${base}/all`)).text();

  assert.equal((html.match(/class="tile[ "]/g) ?? []).length, 4);
  assert.match(html, /class="jump"/);
});

// The select's own labels: a count in parens above zero, the bare name at
// zero, and the data attributes the update script rebuilds a label from. A
// fourth (delta) project keeps total projects above TILE_COUNT so the
// select renders regardless of which three land a tile.
test('select option labels carry the open count, and each option carries data-name and data-open-for', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'lookover-server-'));
  const store = openStore(join(dir, 'queue.sqlite'));
  const alpha = store.registerProject({ slug: 'alpha', name: 'Alpha', identity: `${dir}/.alpha`, identity_kind: 'git', root: '/repos/alpha', accent: '#336699' });
  const gamma = store.registerProject({ slug: 'gamma', name: 'Gamma', identity: `${dir}/.gamma`, identity_kind: 'git', root: '/repos/gamma', accent: '#336699' });
  store.registerProject({ slug: 'beta', name: 'Beta', identity: `${dir}/.beta`, identity_kind: 'git', root: '/repos/beta', accent: '#336699' });
  store.registerProject({ slug: 'delta', name: 'Delta', identity: `${dir}/.delta`, identity_kind: 'git', root: '/repos/delta', accent: '#336699' });
  for (let i = 0; i < 5; i += 1) store.addItem({ projectId: alpha.id, title: `card ${i}` });
  for (let i = 0; i < 2; i += 1) store.addItem({ projectId: gamma.id, title: `card ${i}` });
  const server = createServer(store);
  const base = await listen(server);
  t.after(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); store.close(); rmSync(dir, { recursive: true, force: true }); });

  const html = await (await get(`${base}/all`)).text();

  assert.match(html, /<option value="all" data-name="All projects" data-open-for="all" selected>All projects \(7\)<\/option>/);
  assert.match(html, /<option value="alpha" data-name="Alpha" data-open-for="alpha">Alpha \(5\)<\/option>/);
  assert.match(html, /<option value="beta" data-name="Beta" data-open-for="beta">Beta<\/option>/);
  assert.match(html, /<option value="gamma" data-name="Gamma" data-open-for="gamma">Gamma \(2\)<\/option>/);
  assert.match(html, /<option value="delta" data-name="Delta" data-open-for="delta">Delta<\/option>/);
});

// The tab title leads with the current view's own open count, not a global
// total: an all-projects total on a quiet project's page would be false.
test('the tab title leads with the view\'s open count, and drops the prefix at zero', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'lookover-server-'));
  const store = openStore(join(dir, 'queue.sqlite'));
  const busy = store.registerProject({ slug: 'busy', name: 'Busy', identity: `${dir}/.busy`, identity_kind: 'git', root: '/repos/busy', accent: '#336699' });
  store.registerProject({ slug: 'quiet', name: 'Quiet', identity: `${dir}/.quiet`, identity_kind: 'git', root: '/repos/quiet', accent: '#336699' });
  for (let i = 0; i < 4; i += 1) store.addItem({ projectId: busy.id, title: `card ${i}` });
  const server = createServer(store);
  const base = await listen(server);
  t.after(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); store.close(); rmSync(dir, { recursive: true, force: true }); });

  assert.match(await (await get(`${base}/p/busy`)).text(), /<title>\(4\) Busy · Lookover<\/title>/);
  assert.match(await (await get(`${base}/p/quiet`)).text(), /<title>Quiet · Lookover<\/title>/);
  assert.match(await (await get(`${base}/all`)).text(), /<title>\(4\) All projects · Lookover<\/title>/);
});

// The fourth combination the test above does not reach: /all with nothing
// open on any project.
test('the tab title is bare on /all when nothing is open anywhere', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'lookover-server-'));
  const store = openStore(join(dir, 'queue.sqlite'));
  store.registerProject({ slug: 'one', name: 'One', identity: `${dir}/.one`, identity_kind: 'git', root: '/repos/one', accent: '#336699' });
  store.registerProject({ slug: 'two', name: 'Two', identity: `${dir}/.two`, identity_kind: 'git', root: '/repos/two', accent: '#336699' });
  const server = createServer(store);
  const base = await listen(server);
  t.after(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); store.close(); rmSync(dir, { recursive: true, force: true }); });

  assert.match(await (await get(`${base}/all`)).text(), /<title>All projects · Lookover<\/title>/);
});

// A slug never moves once registered, so `lookover init --name` on an existing
// project leaves name and slug disagreeing. Vacuous if the fixtures agree:
// every other picker test sets name === slug, which is why a select sorted by
// slug passed them all while its own docblock said "by name".
test('the project select is ordered by the name it shows, not by the slug behind it', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'lookover-server-'));
  const store = openStore(join(dir, 'queue.sqlite'));
  for (const [slug, name] of [['alpha', 'Zulu'], ['bravo', 'Yankee'], ['charlie', 'Xray'], ['delta', 'Whiskey'], ['echo', 'Victor']] as const) {
    store.registerProject({ slug, name, identity: `${dir}/.${slug}`, identity_kind: 'git', root: `/repos/${slug}`, accent: '#336699' });
  }
  const server = createServer(store);
  const base = await listen(server);
  t.after(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); store.close(); rmSync(dir, { recursive: true, force: true }); });

  const html = await (await get(`${base}/all`)).text();
  const labelsIn = (form: string): (string | undefined)[] =>
    [...form.matchAll(/<option value="[^"]*"[^>]*>([^<]+)<\/option>/g)].map((match) => match[1]);
  const jumpAt = html.indexOf('<form class="jump"');
  const jump = html.slice(jumpAt, html.indexOf('</form>', jumpAt));
  const filer = html.slice(html.indexOf('<label for="new-project">'), html.indexOf('<label for="new-title">'));

  // Both selects, because the filing form has one too and it shows the same
  // column.
  assert.deepEqual(labelsIn(jump), ['All projects', 'Victor', 'Whiskey', 'Xray', 'Yankee', 'Zulu']);
  assert.deepEqual(labelsIn(filer), ['Victor', 'Whiskey', 'Xray', 'Yankee', 'Zulu']);
});

// Vacuous without the stored-nothing half: a route that 400d and saved the
// verdict anyway would pass on the status code alone, and a tester who got a
// 404 page after a save could not tell which had happened either.
test('a save on an archived project is a 400 that stores nothing, not a redirect to a 404', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'lookover-server-'));
  const store = openStore(join(dir, 'queue.sqlite'));
  const project = store.registerProject({ slug: 'gone', name: 'Gone', identity: `${dir}/.git`, identity_kind: 'git', root: '/repos/gone', accent: '#336699' });
  const item = store.addItem({ projectId: project.id, title: 'Card on a project about to be archived' });
  store.archiveProject(project.slug);
  const server = createServer(store);
  const base = await listen(server);
  t.after(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); store.close(); rmSync(dir, { recursive: true, force: true }); });

  const response = await get(`${base}/items/${item.id}/feedback`, {
    method: 'POST',
    body: new URLSearchParams({ verdict: 'needs-work', feedback: 'the footer jumps' }),
    redirect: 'manual',
  });

  assert.equal(response.status, 400);
  assert.match(await response.text(), /archived/);
  assert.equal(store.getItem(item.id)?.status, 'open');
  assert.equal(store.getItem(item.id)?.verdict, null);
  assert.equal(store.getItem(item.id)?.feedback, null);
});

// The no-JavaScript path: the select is a GET form, so the slug arrives as a
// query and / has to turn it into the path the bookmark uses.
test('GET / with a project query redirects to that project, or 404s for one it does not have', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'lookover-server-'));
  const store = openStore(join(dir, 'queue.sqlite'));
  store.registerProject({ slug: 'app', name: 'App', identity: `${dir}/.git`, identity_kind: 'git', root: '/repos/app', accent: '#336699' });
  const gone = store.registerProject({ slug: 'gone', name: 'Gone', identity: `${dir}/.g`, identity_kind: 'git', root: '/repos/gone', accent: '#993366' });
  store.archiveProject(gone.slug);
  const server = createServer(store);
  const base = await listen(server);
  t.after(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); store.close(); rmSync(dir, { recursive: true, force: true }); });
  const go = async (query: string): Promise<Response> => get(`${base}/${query}`, { redirect: 'manual' });

  assert.equal((await go('?project=app')).headers.get('location'), '/p/app');
  assert.equal((await go('?project=all')).headers.get('location'), '/all');
  assert.equal((await go('?project=gone')).status, 404);
  assert.equal((await go('?project=nope')).status, 404);
  assert.equal((await go('')).headers.get('location'), '/p/app');
});

test('GET / with a default project redirects there even when several projects exist and keeps the token', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'lookover-server-'));
  const store = openStore(join(dir, 'queue.sqlite'));
  store.registerProject({ slug: 'alpha', name: 'Alpha', identity: `${dir}/.alpha`, identity_kind: 'path', root: '/repos/alpha', accent: '#336699' });
  store.registerProject({ slug: 'app', name: 'App', identity: `${dir}/.git`, identity_kind: 'git', root: '/repos/app', accent: '#336699' });
  store.registerProject({ slug: 'omega', name: 'Omega', identity: `${dir}/.omega`, identity_kind: 'path', root: '/repos/omega', accent: '#336699' });
  const server = createServer(store, { defaultProject: 'app', token: 'secret' });
  const base = await listen(server);
  t.after(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); store.close(); rmSync(dir, { recursive: true, force: true }); });

  const response = await get(`${base}/?t=secret`, { redirect: 'manual' });

  assert.equal(response.status, 303);
  assert.equal(response.headers.get('location'), '/p/app?t=secret');
});

test('GET / ignores an archived or unknown default project and uses the existing project-count rule', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'lookover-server-'));
  const store = openStore(join(dir, 'queue.sqlite'));
  store.registerProject({ slug: 'alpha', name: 'Alpha', identity: `${dir}/.alpha`, identity_kind: 'path', root: '/repos/alpha', accent: '#336699' });
  store.registerProject({ slug: 'app', name: 'App', identity: `${dir}/.git`, identity_kind: 'git', root: '/repos/app', accent: '#336699' });
  const gone = store.registerProject({ slug: 'gone', name: 'Gone', identity: `${dir}/.gone`, identity_kind: 'path', root: '/repos/gone', accent: '#336699' });
  store.archiveProject(gone.slug);
  const archived = createServer(store, { defaultProject: 'gone' });
  const archivedBase = await listen(archived);
  t.after(async () => { await new Promise<void>((resolve) => archived.close(() => resolve())); store.close(); rmSync(dir, { recursive: true, force: true }); });

  assert.equal((await get(`${archivedBase}/`, { redirect: 'manual' })).headers.get('location'), '/all');

  const unknown = createServer(store, { defaultProject: 'nope' });
  const unknownBase = await listen(unknown);
  t.after(async () => { await new Promise<void>((resolve) => unknown.close(() => resolve())); });

  assert.equal((await get(`${unknownBase}/`, { redirect: 'manual' })).headers.get('location'), '/all');
});

test('an accent that is not #rrggbb never reaches the page CSS', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'lookover-server-'));
  const store = openStore(join(dir, 'queue.sqlite'));
  const project = store.registerProject({ slug: 'app', name: 'App', identity: `${dir}/.git`, identity_kind: 'git', root: '/repos/app', accent: '#369;}body{display:none}a{color:red' });
  store.addItem({ projectId: project.id, title: 'Open card' });
  const server = createServer(store);
  const base = await listen(server);
  t.after(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); store.close(); rmSync(dir, { recursive: true, force: true }); });

  const html = await (await get(`${base}/p/app`)).text();

  assert.doesNotMatch(html, /body\{display:none\}/);
  assert.doesNotMatch(html, /color:red/);
  assert.ok(html.includes(`--page-accent:${accentOnLight(NEUTRAL_ACCENT)}`), 'a rejected accent should fall back to the neutral');
});

test('cards render two verdict submit buttons and no note button, required feedback, and the waiting selection', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'lookover-server-'));
  const store = openStore(join(dir, 'queue.sqlite'));
  const project = store.registerProject({ slug: 'app', name: 'App', identity: `${dir}/.git`, identity_kind: 'git', root: '/repos/app', accent: '#336699' });
  const open = store.addItem({ projectId: project.id, title: 'Open card', url: 'https://app.test/page' });
  const answered = store.addItem({ projectId: project.id, title: 'Answered card' });
  store.saveFeedback(answered.id, { verdict: 'needs-work', feedback: 'the footer jumps' });
  const server = createServer(store);
  const base = await listen(server);
  t.after(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); store.close(); rmSync(dir, { recursive: true, force: true }); });

  const html = await (await get(`${base}/p/app`)).text();
  const openCard = html.slice(html.indexOf(`id="item-${open.id}"`), html.indexOf(`id="item-${answered.id}"`));

  assert.match(openCard, /<button class="verdict approved" type="submit" name="verdict" value="approved" formnovalidate>Approved<\/button>/);
  assert.match(openCard, /<button class="verdict needs-work" type="submit" name="verdict" value="needs-work">Needs work<\/button>/);
  assert.doesNotMatch(openCard, /value="note"/);
  assert.match(openCard, /<textarea name="feedback" required/);
  assert.doesNotMatch(openCard, /type="radio" name="verdict"/);
  assert.match(openCard, /<span class="id">#\d+<\/span>/);
  assert.match(openCard, /<a class="open" href="https:\/\/app\.test\/page" rel="noopener noreferrer">/);
  assert.match(html, /<details class="fold answer"><summary>Change your answer/);
  assert.match(html, /<button class="verdict needs-work selected" type="submit" name="verdict" value="needs-work">Needs work<\/button>/);
});

test('a note verdict still posts, and its waiting card keeps the Note badge with only two buttons in the fold', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'lookover-server-'));
  const store = openStore(join(dir, 'queue.sqlite'));
  const project = store.registerProject({ slug: 'app', name: 'App', identity: `${dir}/.git`, identity_kind: 'git', root: '/repos/app', accent: '#336699' });
  const item = store.addItem({ projectId: project.id, title: 'Noted card' });
  const server = createServer(store);
  const base = await listen(server);
  t.after(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); store.close(); rmSync(dir, { recursive: true, force: true }); });

  const saved = await get(`${base}/items/${item.id}/feedback`, { method: 'POST', body: new URLSearchParams({ verdict: 'note', feedback: 'just a thought' }), redirect: 'manual' });
  assert.equal(saved.status, 303);
  assert.equal(store.getItem(item.id)?.verdict, 'note');

  const html = await (await get(`${base}/p/app`)).text();
  const card = html.slice(html.indexOf(`id="item-${item.id}"`));
  assert.match(card, /<span class="badge note">Note<\/span>/);
  assert.equal((card.match(/<button class="verdict /g) ?? []).length, 2);
  assert.doesNotMatch(card, /selected"/);
});

test('approved keeps the accent while waiting buttons mark the saved verdict', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'lookover-server-'));
  const store = openStore(join(dir, 'queue.sqlite'));
  const project = store.registerProject({ slug: 'app', name: 'App', identity: `${dir}/.git`, identity_kind: 'git', root: '/repos/app', accent: '#336699' });
  const open = store.addItem({ projectId: project.id, title: 'Open card' });
  const answered = store.addItem({ projectId: project.id, title: 'Answered card' });
  store.saveFeedback(answered.id, { verdict: 'approved', feedback: '' });
  const server = createServer(store);
  const base = await listen(server);
  t.after(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); store.close(); rmSync(dir, { recursive: true, force: true }); });

  const html = await (await get(`${base}/p/app`)).text();
  const openCard = html.slice(html.indexOf(`id="item-${open.id}"`), html.indexOf(`id="item-${answered.id}"`));
  const answeredCard = html.slice(html.indexOf(`id="item-${answered.id}"`));

  assert.match(openCard, /<button class="verdict approved"/);
  assert.match(answeredCard, /<button class="verdict approved selected"/);
  // All belongs to no project, so it is the one tile that carries no hue.
  assert.match(html, /<a class="tile all" href="\/all">/);
});

// Vacuous unless the store hands the page an interleaved list: the assertion
// below would hold on an already-grouped one whatever renderPage did, so the
// sort keys are chosen to interleave Beta and Alpha in queue order.
test('All view groups cards by project; a single project page keeps queue order', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'lookover-server-'));
  const store = openStore(join(dir, 'queue.sqlite'));
  const alpha = store.registerProject({ slug: 'alpha', name: 'Alpha', identity: `${dir}/.a`, identity_kind: 'git', root: '/repos/alpha', accent: '#336699' });
  const beta = store.registerProject({ slug: 'beta', name: 'Beta', identity: `${dir}/.b`, identity_kind: 'git', root: '/repos/beta', accent: '#993366' });
  const b1 = store.addItem({ projectId: beta.id, title: 'Beta first', sort: 1 });
  const a1 = store.addItem({ projectId: alpha.id, title: 'Alpha first', sort: 2 });
  const b2 = store.addItem({ projectId: beta.id, title: 'Beta second', sort: 3 });
  const a2 = store.addItem({ projectId: alpha.id, title: 'Alpha second', sort: 4 });
  const server = createServer(store);
  const base = await listen(server);
  t.after(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); store.close(); rmSync(dir, { recursive: true, force: true }); });
  const order = (html: string): number[] => [...html.matchAll(/id="item-(\d+)"/g)].map((match) => Number(match[1]));

  assert.deepEqual(store.listItems({ status: 'open', order: 'queue', excludeArchived: true }).map((item) => item.id), [b1.id, a1.id, b2.id, a2.id]);
  assert.deepEqual(order(await (await get(`${base}/all`)).text()), [a1.id, a2.id, b1.id, b2.id]);
  assert.deepEqual(order(await (await get(`${base}/p/beta`)).text()), [b1.id, b2.id]);
});

// Pins the two sort values the queue order actually distinguishes. Vacuous if
// the third card is left out: an unprioritised card must carry no badge at
// all, or "Soon" would just mean "not first".
test('a card the lead marked sort 1 says Blocking and sort 2 says Soon; anything else says nothing', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'lookover-server-'));
  const store = openStore(join(dir, 'queue.sqlite'));
  const project = store.registerProject({ slug: 'app', name: 'App', identity: `${dir}/.git`, identity_kind: 'git', root: '/repos/app', accent: '#336699' });
  const blocking = store.addItem({ projectId: project.id, title: 'Blocking card', sort: 1 });
  const soon = store.addItem({ projectId: project.id, title: 'Soon card', sort: 2 });
  const ordinary = store.addItem({ projectId: project.id, title: 'Ordinary card', sort: 3 });
  const unset = store.addItem({ projectId: project.id, title: 'Unset card' });
  const server = createServer(store);
  const base = await listen(server);
  t.after(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); store.close(); rmSync(dir, { recursive: true, force: true }); });
  const html = await (await get(`${base}/p/app`)).text();
  const cardFor = (id: number): string => html.slice(html.indexOf(`id="item-${id}"`), html.indexOf(`id="item-${id}"`) + 400);

  assert.match(cardFor(blocking.id), /<span class="prio first">Blocking<\/span>/);
  assert.match(cardFor(soon.id), /<span class="prio">Soon<\/span>/);
  assert.doesNotMatch(cardFor(ordinary.id), /class="prio/);
  assert.doesNotMatch(cardFor(unset.id), /class="prio/);
});

// The 303 after a save sends the browser to #item-<id>, and the card has by
// then MOVED from open to waiting. Pins the id in all three sections at once,
// because an anchor that exists in only the section a card started in is the
// bug that drops the tester at the foot of the page.
test('every card carries its anchor id in whichever section it is in, and a save lands on it', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'lookover-server-'));
  const store = openStore(join(dir, 'queue.sqlite'));
  const project = store.registerProject({ slug: 'app', name: 'App', identity: `${dir}/.git`, identity_kind: 'git', root: '/repos/app', accent: '#336699' });
  const stillOpen = store.addItem({ projectId: project.id, title: 'Still open' });
  const willMove = store.addItem({ projectId: project.id, title: 'About to be answered' });
  const finished = store.addItem({ projectId: project.id, title: 'Already processed' });
  store.saveFeedback(finished.id, { verdict: 'approved', feedback: '' });
  store.processItem(finished.id, 'done');
  const server = createServer(store);
  const base = await listen(server);
  t.after(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); store.close(); rmSync(dir, { recursive: true, force: true }); });

  const saved = await get(`${base}/items/${willMove.id}/feedback`, { method: 'POST', body: new URLSearchParams({ verdict: 'needs-work', feedback: 'the footer jumps' }), redirect: 'manual' });

  assert.equal(saved.status, 303);
  assert.equal(saved.headers.get('location'), `/p/app#item-${willMove.id}`);
  assert.equal(store.getItem(willMove.id)?.status, 'feedback');
  const html = await (await get(`${base}/p/app`)).text();
  const section = (heading: string): string => html.slice(html.indexOf(heading), html.indexOf('</section>', html.indexOf(heading)));
  assert.match(section('Awaiting your test'), new RegExp(`id="item-${stillOpen.id}"`));
  assert.match(section('Waiting for the agent'), new RegExp(`id="item-${willMove.id}"`));
  assert.match(section('Processed'), new RegExp(`id="item-${finished.id}"`));
});

test('a card the tester files themselves gets an anchor the redirect can land on', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'lookover-server-'));
  const store = openStore(join(dir, 'queue.sqlite'));
  const project = store.registerProject({ slug: 'app', name: 'App', identity: `${dir}/.git`, identity_kind: 'git', root: '/repos/app', accent: '#336699' });
  const server = createServer(store);
  const base = await listen(server);
  t.after(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); store.close(); rmSync(dir, { recursive: true, force: true }); });

  const filed = await get(`${base}/items/new`, { method: 'POST', body: new URLSearchParams({ project: 'app', title: 'Found it', body: 'the footer jumps' }), redirect: 'manual' });

  const created = store.listItems({ projectId: project.id })[0];
  assert.ok(created !== undefined);
  assert.equal(filed.headers.get('location'), `/p/app#item-${created.id}`);
  assert.match(await (await get(`${base}/p/app`)).text(), new RegExp(`id="item-${created.id}"`));
});

// The view field is attacker-reachable like any form field, so the slug it
// names is resolved against the store rather than pasted into a Location.
test('the view field decides where a save returns, and a bogus one falls back to the project', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'lookover-server-'));
  const store = openStore(join(dir, 'queue.sqlite'));
  const project = store.registerProject({ slug: 'app', name: 'App', identity: `${dir}/.git`, identity_kind: 'git', root: '/repos/app', accent: '#336699' });
  const gone = store.registerProject({ slug: 'gone', name: 'Gone', identity: `${dir}/.g`, identity_kind: 'git', root: '/repos/gone', accent: '#993366' });
  store.archiveProject(gone.slug);
  const server = createServer(store);
  const base = await listen(server);
  t.after(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); store.close(); rmSync(dir, { recursive: true, force: true }); });
  const save = async (view: string | undefined): Promise<string | null> => {
    const item = store.addItem({ projectId: project.id, title: 'A card' });
    const body = new URLSearchParams({ verdict: 'needs-work', feedback: 'no' });
    if (view !== undefined) body.set('view', view);
    return (await get(`${base}/items/${item.id}/feedback`, { method: 'POST', body, redirect: 'manual' })).headers.get('location');
  };

  assert.match(await save('app') ?? '', /^\/p\/app#item-\d+$/);
  assert.match(await save('all') ?? '', /^\/all#item-\d+$/);
  assert.match(await save('../../etc/passwd') ?? '', /^\/p\/app#item-\d+$/);
  assert.match(await save('gone') ?? '', /^\/p\/app#item-\d+$/);
  assert.match(await save(undefined) ?? '', /^\/p\/app#item-\d+$/);
  assert.match(await (await get(`${base}/p/app`)).text(), /<input type="hidden" name="view" value="app">/);
  assert.match(await (await get(`${base}/all`)).text(), /<input type="hidden" name="view" value="all">/);
});

// The header's mark is lookover's, so it wears the brand colour whatever the
// project's accent is; the favicon is the one copy that carries the accent.
test('the header carries the lookover wordmark and its mark wears the brand colour, not the accent', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'lookover-server-'));
  const store = openStore(join(dir, 'queue.sqlite'));
  store.registerProject({ slug: 'app', name: 'App', identity: `${dir}/.git`, identity_kind: 'git', root: '/repos/app', accent: '#336699' });
  const server = createServer(store);
  const base = await listen(server);
  t.after(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); store.close(); rmSync(dir, { recursive: true, force: true }); });

  const html = await (await get(`${base}/p/app`)).text();
  const brand = html.match(/<p class="brand">.*?<\/p>/)?.[0] ?? '';

  assert.match(brand, /^<p class="brand"><svg class="mark" width="17" height="17" viewBox="0 0 100 100" aria-hidden="true">/);
  assert.match(brand, /stroke="#B86BF0"/);
  assert.doesNotMatch(brand, /--accent|#336699/i);
  assert.match(brand, /<\/svg>lookover<\/p>$/);
  // The wordmark sits above the project's own name, not in place of it.
  assert.ok(html.indexOf('>lookover</p>') < html.indexOf('<h1>App</h1>'), 'the wordmark should precede the h1');
});

test('the small mark files in docs/assets are the shapes the page draws, with baked colours', async () => {
  const { markShapes } = await import('./page.ts');
  const read = (name: string) => readFileSync(fileURLToPath(new URL(`../docs/assets/${name}`, import.meta.url)), 'utf8');

  assert.ok(read('logo-mark-small.svg').includes(markShapes('#B86BF0', '#1F2937')), 'the light small mark should be the page mark');
  assert.ok(read('logo-mark-small-dark.svg').includes(markShapes('#B86BF0', '#E6EDF3')), 'the dark small mark should be the page mark');
});

test('every logo SVG is self-contained: no text, fonts, links or stylesheet variables', () => {
  const dir = fileURLToPath(new URL('../docs/assets/', import.meta.url));
  const names = readdirSync(dir).filter((name) => name.startsWith('logo') && name.endsWith('.svg'));

  assert.deepEqual(names.sort(), ['logo-card.svg', 'logo-dark.svg', 'logo-mark-dark.svg', 'logo-mark-small-dark.svg', 'logo-mark-small.svg', 'logo-mark.svg', 'logo.svg']);
  for (const name of names) {
    const file = readFileSync(join(dir, name), 'utf8');
    assert.match(file, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="[^"]+" width="[^"]+" height="[^"]+" role="img" aria-label="lookover">/, name);
    assert.doesNotMatch(file, /<text|font-family|@font-face|href=|url\(|var\(--/, name);
  }
});

test('the README opens on the logo card', () => {
  const readme = readFileSync(fileURLToPath(new URL('../README.md', import.meta.url)), 'utf8');

  assert.equal(readme.split('\n')[0], '<p align="center"><img src="docs/assets/logo-card.svg" alt="lookover" height="112"></p>');
});

// The Go button is the no-JavaScript path and the script hides it. Pins the
// CSS that lets it actually disappear: button{display:block} outranks the UA
// sheet's [hidden], so hidden=true alone left it on screen.
test('the Go button can be hidden by the script that replaces it', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'lookover-server-'));
  const store = openStore(join(dir, 'queue.sqlite'));
  store.registerProject({ slug: 'app', name: 'App', identity: `${dir}/.git`, identity_kind: 'git', root: '/repos/app', accent: '#336699' });
  const server = createServer(store);
  const base = await listen(server);
  t.after(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); store.close(); rmSync(dir, { recursive: true, force: true }); });

  const html = await (await get(`${base}/p/app`)).text();

  assert.match(html, /\.jump \.go\[hidden\]\{display:none\}/);
  assert.match(html, /const g=f\.querySelector\('\.go'\);g\.hidden=true/);
});

test('every animation and transition on the page sits inside the no-preference reduced-motion block', () => {
  const html = renderPage({ projects: [], current: 'all', open: [], waiting: [], done: [], counts: new Map() });
  const css = html.slice(html.indexOf('<style>') + 7, html.indexOf('</style>'));
  const opener = '@media(prefers-reduced-motion:no-preference){';
  const start = css.indexOf(opener);
  assert.ok(start >= 0, 'the page should have a reduced-motion block');
  let depth = 0;
  let end = start + opener.length - 1;
  for (; end < css.length; end += 1) {
    if (css[end] === '{') depth += 1;
    if (css[end] === '}') depth -= 1;
    if (depth === 0) break;
  }
  const motion = css.slice(start, end + 1);
  const rest = css.slice(0, start) + css.slice(end + 1);

  assert.match(motion, /\.card:target\{animation:settle/);
  assert.match(motion, /button:active/);
  assert.doesNotMatch(rest, /animation:|transition:/);
});

const JSON_HEADERS = { accept: 'application/json' };

interface Saved { ok: boolean; error?: string; item?: ItemWithProject; html?: string; counts?: { project: { open: number; feedback: number; processed: number }; all: { open: number; feedback: number; processed: number } } }

test('a feedback post asking for JSON answers 200 with the saved row and the waiting card, and no redirect', async (t) => {
  const { store, item, server } = scratch(t);
  const archived = store.registerProject({ slug: 'old', name: 'Old', identity: '/repos/old', identity_kind: 'git', root: '/repos/old', accent: '#884422' });
  store.addItem({ projectId: archived.id, title: 'Archived card' });
  store.archiveProject(archived.slug);
  const base = await listen(server);

  const response = await get(`${base}/items/${item.id}/feedback`, { method: 'POST', headers: JSON_HEADERS, body: new URLSearchParams({ verdict: 'needs-work', feedback: 'the footer jumps', view: 'app' }), redirect: 'manual' });

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('location'), null);
  assert.match(response.headers.get('content-type') ?? '', /^application\/json/);
  const body = await response.json() as Saved;
  assert.equal(body.ok, true);
  assert.deepEqual(body.item, { ...store.getItem(item.id), project: 'app', files: [] });
  assert.deepEqual(body.counts, { project: { open: 0, feedback: 1, processed: 0 }, all: { open: 0, feedback: 1, processed: 0 } });
  assert.equal(body.item?.status, 'feedback');
  assert.equal(body.item?.verdict, 'needs-work');
  assert.match(body.html ?? '', new RegExp(`^<form class="card" id="item-${item.id}" method="post" enctype="multipart/form-data" action="/items/${item.id}/feedback">`));
  assert.match(body.html ?? '', /<span class="badge needs-work">Needs work<\/span>/);
  assert.match(body.html ?? '', /<div class="quote">the footer jumps<\/div>/);
  assert.match(body.html ?? '', /<details class="fold answer"><summary>Change your answer/);
  assert.equal((body.html ?? '').match(/type="submit" name="verdict"/g)?.length, 2);
});

test('the card a JSON save returns is byte-for-byte the card the page renders for it', async (t) => {
  const { store, item, server } = scratch(t, { token: 'secret' });
  const base = await listen(server);

  const body = await (await get(`${base}/items/${item.id}/feedback?t=secret`, { method: 'POST', headers: JSON_HEADERS, body: new URLSearchParams({ verdict: 'approved', feedback: '', view: 'app' }) })).json() as Saved;

  const page = await (await get(`${base}/p/app?t=secret`)).text();
  assert.ok(page.includes(body.html ?? 'missing'), 'the page should contain the returned card verbatim');
  assert.match(body.html ?? '', /action="\/items\/\d+\/feedback\?t=secret"/);
  assert.match(body.html ?? '', /<input type="hidden" name="t" value="secret">/);
  assert.equal(store.getItem(item.id)?.verdict, 'approved');
});

test('a JSON save escapes the tester\'s words and the title like the page does', async (t) => {
  const { store, project, server } = scratch(t);
  const hostile = store.addItem({ projectId: project.id, title: '<img src=x onerror=alert(1)>' });
  const base = await listen(server);

  const body = await (await get(`${base}/items/${hostile.id}/feedback`, { method: 'POST', headers: JSON_HEADERS, body: new URLSearchParams({ verdict: 'needs-work', feedback: '<script>alert(1)</script>' }) })).json() as Saved;

  assert.doesNotMatch(body.html ?? '', /<script|<img/);
  assert.match(body.html ?? '', /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(body.html ?? '', /&lt;img src=x onerror=alert\(1\)&gt;/);
});

test('a JSON save with photos returns the card with its photo strip and the --json file list', async (t) => {
  const { dir, store, item, server } = scratch(t);
  const base = await listen(server);

  const body = await (await get(`${base}/items/${item.id}/feedback`, { method: 'POST', headers: JSON_HEADERS, body: upload({ name: 'a.png', data: PNG }, { name: 'b.gif', data: GIF, type: 'image/gif' }) })).json() as Saved;

  assert.equal(store.listFiles(item.id).length, 2);
  assert.deepEqual(body.item?.files.map((file) => [file.side, file.name, file.mime, file.path.startsWith(dir)]), [['feedback', 'a.png', 'image/png', true], ['feedback', 'b.gif', 'image/gif', true]]);
  assert.match(body.html ?? '', /<div class="shots"><a href="\/files\/1"><img src="\/files\/1" alt="a\.png" loading="lazy"><\/a><a href="\/files\/2">/);
});

test('a JSON save from the All view returns the card with its project badge, and from a project page without one', async (t) => {
  const { store, project, server } = scratch(t);
  const second = store.addItem({ projectId: project.id, title: 'Another card' });
  const base = await listen(server);
  const answer = async (id: number, view: string): Promise<string> => ((await (await get(`${base}/items/${id}/feedback`, { method: 'POST', headers: JSON_HEADERS, body: new URLSearchParams({ verdict: 'approved', feedback: '', view }) })).json()) as Saved).html ?? '';

  assert.match(await answer(1, 'all'), /class="project-badge">App<\/span>/);
  assert.doesNotMatch(await answer(second.id, 'app'), /class="project-badge"/);
});

test('a JSON save keeps the retest line the page shows', async (t) => {
  const { store, project, server } = scratch(t);
  const first = store.addItem({ projectId: project.id, title: 'Round one' });
  store.saveFeedback(first.id, { verdict: 'needs-work', feedback: 'no' });
  store.processItem(first.id, 'fixed');
  const again = store.addItem({ projectId: project.id, title: 'Round two', retestOf: first.id });
  const base = await listen(server);

  const body = await (await get(`${base}/items/${again.id}/feedback`, { method: 'POST', headers: JSON_HEADERS, body: new URLSearchParams({ verdict: 'approved', feedback: '' }) })).json() as Saved;

  assert.match(body.html ?? '', new RegExp(`previously: Needs work on <a href="#item-${first.id}">`));
});

test('a JSON refusal keeps the redirect path\'s status and message, and stores nothing', async (t) => {
  const { store, project, item, server } = scratch(t);
  const gone = store.registerProject({ slug: 'gone', name: 'Gone', identity: `${project.root}/.g`, identity_kind: 'git', root: '/repos/gone', accent: '#993366' });
  const stranded = store.addItem({ projectId: gone.id, title: 'On a dead project' });
  store.archiveProject(gone.slug);
  const done = store.addItem({ projectId: project.id, title: 'Already answered' });
  store.saveFeedback(done.id, { verdict: 'approved', feedback: '' });
  store.processItem(done.id, 'ok');
  const base = await listen(server);
  const post = async (path: string, fields: Record<string, string>, headers: Record<string, string>): Promise<[number, string]> => {
    const response = await get(`${base}${path}`, { method: 'POST', headers, body: new URLSearchParams(fields), redirect: 'manual' });
    return [response.status, await response.text()];
  };
  const refusals: [string, Record<string, string>, number, string][] = [
    [`/items/${item.id}/feedback`, { verdict: 'needs-work', feedback: '  ' }, 400, 'feedback is required unless approved'],
    [`/items/${done.id}/feedback`, { verdict: 'needs-work', feedback: 'again' }, 400, 'item cannot receive feedback'],
    [`/items/999/feedback`, { verdict: 'approved', feedback: '' }, 400, 'item cannot receive feedback'],
    [`/items/${stranded.id}/feedback`, { verdict: 'needs-work', feedback: 'x' }, 400, 'that project is archived'],
    ['/items/new', { project: 'app', title: '', body: 'x' }, 400, 'invalid new item'],
    ['/items/new', { project: 'gone', title: 'x', body: '' }, 400, 'invalid new item'],
  ];

  for (const [path, fields, status, message] of refusals) {
    assert.deepEqual(await post(path, fields, {}), [status, `${message}\n`], `plain ${path}`);
    assert.deepEqual(await post(path, fields, JSON_HEADERS), [status, JSON.stringify({ ok: false, error: message })], `json ${path}`);
  }
  assert.equal(store.getItem(item.id)?.status, 'open');
  assert.equal(store.listItems({ projectId: project.id, status: 'feedback' }).length, 0);
});

test('a JSON post with a photo over 10 MB is a 413 with the same message, and stores nothing', async (t) => {
  const { dir, store, item, server } = scratch(t);
  const base = await listen(server);
  const big = Buffer.concat([PNG, Buffer.alloc(11 * 1024 * 1024)]);

  const response = await get(`${base}/items/${item.id}/feedback`, { method: 'POST', headers: JSON_HEADERS, body: upload({ name: 'big.png', data: big }) });

  assert.equal(response.status, 413);
  const body = await response.json() as Saved;
  assert.equal(body.ok, false);
  assert.match(body.error ?? '', /^big\.png is 11\.0 MB/);
  assert.equal(store.getItem(item.id)?.status, 'open');
  assert.deepEqual(filesOnDisk(dir), []);
});

test('a JSON post with a truncated multipart body is a 400 with the bad-upload message', async (t) => {
  const { store, item, server } = scratch(t);
  const base = await listen(server);

  const response = await get(`${base}/items/${item.id}/feedback`, { method: 'POST', headers: { ...JSON_HEADERS, 'content-type': 'multipart/form-data; boundary=xyz' }, body: '--xyz\r\nContent-Disposition: form-data; name="feedback"\r\n\r\nhalf' });

  assert.equal(response.status, 400);
  const body = await response.json() as Saved;
  assert.equal(body.ok, false);
  assert.match(body.error ?? '', /^bad upload: /);
  assert.equal(store.getItem(item.id)?.status, 'open');
});

test('a new-item post asking for JSON files the row and answers with it and its card', async (t) => {
  const { store, project, server } = scratch(t);
  const base = await listen(server);

  const response = await get(`${base}/items/new`, { method: 'POST', headers: JSON_HEADERS, body: new URLSearchParams({ project: 'app', title: 'Found it', body: 'The footer jumps', view: 'all' }), redirect: 'manual' });

  assert.equal(response.status, 200);
  const created = store.listItems({ projectId: project.id, status: 'feedback' })[0];
  assert.ok(created !== undefined);
  const body = await response.json() as Saved;
  assert.equal(body.ok, true);
  assert.deepEqual(body.item, { ...store.getItem(created.id), project: 'app', files: [] });
  assert.deepEqual(body.counts, { project: { open: 1, feedback: 1, processed: 0 }, all: { open: 1, feedback: 1, processed: 0 } });
  assert.match(body.html ?? '', new RegExp(`^<form[^>]* class="card" id="item-${created.id}"`));
  assert.match(body.html ?? '', /<div class="quote">The footer jumps<\/div>/);
  assert.match(body.html ?? '', /class="project-badge">App<\/span>/);
});

test('only an explicit application/json Accept gets JSON; a browser navigation or */* still gets the 303', async (t) => {
  const { store, project, server } = scratch(t);
  const base = await listen(server);
  const accepts: [string | undefined, number][] = [[undefined, 303], ['*/*', 303], ['text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', 303], ['application/json', 200], ['text/html, Application/JSON;q=0.9', 200]];

  for (const [accept, status] of accepts) {
    const card = store.addItem({ projectId: project.id, title: `Card for ${accept}` });
    const response = await get(`${base}/items/${card.id}/feedback`, { method: 'POST', headers: accept === undefined ? {} : { accept }, body: new URLSearchParams({ verdict: 'approved', feedback: '' }), redirect: 'manual' });
    assert.equal(response.status, status, String(accept));
    if (status === 303) {
      assert.equal(response.headers.get('location'), `/p/app#item-${card.id}`);
      assert.equal(await response.text(), '');
    }
  }
});

function pageScript(openCards = 0): string {
  const open = Array.from({ length: openCards }, (_, index) => ({ id: index + 1, project_id: 1, title: `Open ${index + 1}`, details: '', source: 'lane', url: null, ref: null, retest_of: null, sort: null, status: 'open', verdict: null, feedback: null, created_at: '', feedback_at: null, processed_at: null, processed_note: null }) satisfies Item);
  const html = renderPage({ projects: [], current: 'all', open, waiting: [], done: [], counts: new Map() });
  return html.slice(html.indexOf('<script>') + 8, html.indexOf('</script>'));
}

function runPaste(options: { files: { name: string; type: string; size: number }[]; current?: { name: string; type: string; size: number }[] }) {
  class FakeElement {
    children: FakeElement[] = [];
    attributes: Record<string, string> = {};
    textContent = '';
    hidden = true;
    src = '';
    alt = '';
    className = '';
    type = '';
    dataset: Record<string, string> = {};
    tagName: string;
    constructor(tagName: string) { this.tagName = tagName; }
    append(...nodes: FakeElement[]) { this.children.push(...nodes); }
    replaceChildren(...nodes: FakeElement[]) { this.children = nodes; }
    querySelector(selector: string): FakeElement | null { return selector === 'span' ? this.children.find((child) => child.tagName === 'span') ?? null : null; }
    querySelectorAll(selector: string): FakeElement[] { return selector === 'img' ? this.children.flatMap((child) => child.tagName === 'img' ? [child] : child.querySelectorAll(selector)) : []; }
    matches(selector: string) { return selector === '.photo-input' ? this.className === 'photo-input' : selector === '.pick-remove' ? this.className === 'pick-remove' : false; }
    closest(selector: string) { return selector === 'form.card' ? form : null; }
  }
  class FakeDataTransfer {
    items = { add: (file: { name: string; type: string; size: number }) => this.added.push(file) };
    added: { name: string; type: string; size: number }[] = [];
    get files() { return this.added; }
  }
  const input = Object.assign(new FakeElement('input'), { files: options.current ?? [] });
  input.className = 'photo-input';
  const picks = new FakeElement('div');
  picks.className = 'picks';
  const form = new FakeElement('form');
  form.matches = (selector: string) => selector === 'form.card';
  form.querySelector = (selector: string) => selector === '.photo-input' ? input : selector === '.picks' ? picks : null;
  const toast = { textContent: '', classList: { add: () => undefined, remove: () => undefined } };
  let paste: ((event: { target: FakeElement; clipboardData: { files: typeof options.files }; preventDefault: () => void }) => void) | undefined;
  let click: ((event: { target: FakeElement }) => void) | undefined;
  const urls: string[] = [];
  const revoked: string[] = [];
  const sandbox = {
    document: {
      querySelector: () => null,
      getElementById: () => toast,
      createElement: (tagName: string) => new FakeElement(tagName),
      addEventListener: (type: string, handler: unknown) => { if (type === 'paste') paste = handler as typeof paste; if (type === 'click') click = handler as typeof click; },
    },
    Element: FakeElement,
    HTMLElement: FakeElement,
    HTMLInputElement: FakeElement,
    DataTransfer: FakeDataTransfer,
    URL: { createObjectURL: (file: { name: string }) => { const url = `blob:${file.name}`; urls.push(url); return url; }, revokeObjectURL: (url: string) => revoked.push(url) },
    setInterval: () => 0,
    setTimeout: () => 0,
    clearTimeout: () => undefined,
    fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve({ open: 0 }) }),
    Error,
    TypeError,
  };
  vm.runInNewContext(pageScript(), sandbox);
  const event = { target: input, clipboardData: { files: options.files }, preventDefault: () => undefined };
  paste?.(event);
  return { input, picks, toast, urls, revoked, remove: (index: number) => { const target = new FakeElement('button'); target.className = 'pick-remove'; target.dataset.index = String(index); click?.({ target }); } };
}

test('the page script appends pasted image files and renders named previews', () => {
  const run = runPaste({ files: [{ name: 'shot.png', type: 'image/png', size: 100 }] });
  assert.deepEqual(run.input.files.map((file) => file.name), ['shot.png']);
  assert.equal(run.picks.hidden, false);
  assert.equal(run.picks.children.length, 1);
  assert.equal(run.picks.children[0]?.children[0]?.alt, 'shot.png');
});

test('the page script ignores text-only pastes and refuses a sixth image', () => {
  const text = runPaste({ files: [{ name: 'note.txt', type: 'text/plain', size: 100 }] });
  assert.deepEqual(text.input.files, []);
  const tooMany = runPaste({ current: Array.from({ length: 5 }, (_, index) => ({ name: `${index}.png`, type: 'image/png', size: 100 })), files: [{ name: 'sixth.png', type: 'image/png', size: 100 }] });
  assert.equal(tooMany.input.files.length, 5);
  assert.match(tooMany.toast.textContent, /5 allowed at once/);
});

test('the page script refuses an oversized pasted image without changing the input', () => {
  const run = runPaste({ files: [{ name: 'large.png', type: 'image/png', size: 10 * 1024 * 1024 + 1 }] });
  assert.deepEqual(run.input.files, []);
  assert.match(run.toast.textContent, /limit is 10 MB per file/);
});

test('the page script removes a pasted image and revokes its preview URL', () => {
  const run = runPaste({ files: [{ name: 'one.png', type: 'image/png', size: 100 }, { name: 'two.png', type: 'image/png', size: 100 }] });
  assert.deepEqual(run.input.files.map((file) => file.name), ['one.png', 'two.png']);
  run.remove(0);
  assert.deepEqual(run.input.files.map((file) => file.name), ['two.png']);
  assert.deepEqual(run.revoked, ['blob:one.png', 'blob:two.png']);
});

interface FakeCard { dataset: Record<string, string>; buttons: { name: string; value: string; disabled: boolean }[]; replaced?: unknown; reset?: boolean; folded: boolean; filer?: { open: boolean }; action: string }

// Runs the page's own script against a stub DOM, so what it does on submit is
// observed rather than matched as text. Returns the handler's promise.
function runSubmit(options: { reply: () => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>; filer?: boolean; submitter?: { name: string; value: string }; folded?: boolean; openCards?: number; serverOpen?: () => number; select?: { value: string } }) {
  const toast = { textContent: '', shown: false, classList: { add: (name: string) => { if (name === 'show') toast.shown = true; }, remove: (name: string) => { if (name === 'show') toast.shown = false; } } };
  const calls: { url: string; init: { method: string; body: Map<string, string>; headers: Record<string, string> } }[] = [];
  const fired: string[] = [];
  class FakeForm {}
  class FakeFormData extends Map<string, string> {
    constructor(form: FakeCard) { super(); this.set('feedback', 'the footer jumps'); this.set('action-was', form.action); }
  }
  const next = { classList: { add: (name: string) => fired.push(`class:${name}`) }, querySelector: (): { focus: (o: unknown) => void } => ({ focus: (o: unknown) => fired.push(`focus:${JSON.stringify(o)}`) }) };
  const card: FakeCard = { dataset: {}, buttons: [{ name: 'verdict', value: 'approved', disabled: false }, { name: 'verdict', value: 'needs-work', disabled: false }], folded: options.folded ?? false, action: '/items/7/feedback?t=x' };
  const form = Object.assign(Object.create(FakeForm.prototype), {
    dataset: card.dataset,
    get action() { return card.action; },
    matches: (selector: string) => selector === 'form.card',
    closest: () => (options.filer === true ? (card.filer = { open: true }) : null),
    querySelectorAll: () => card.buttons,
    querySelector: (selector: string) => (selector === 'select' ? (options.select ?? null) : card.folded ? {} : null),
    reset: () => { card.reset = true; if (options.select) options.select.value = 'first'; },
    replaceWith: (node: unknown) => { card.replaced = node; fired.push('replaceWith'); },
  });
  const anchor = { textContent: '' };
  const line = { hidden: true, querySelector: () => anchor };
  const openHeading = { textContent: String(options.openCards ?? 0) };
  const feedbackHeading = { textContent: '0' };
  const tiles = [{ dataset: { countFor: 'all' }, textContent: '0' }, { dataset: { countFor: 'app' }, textContent: String(options.openCards ?? 0) }, { dataset: { countFor: 'other' }, textContent: '9' }];
  const selectOptions = [{ dataset: { openFor: 'all', name: 'All projects' }, textContent: 'All projects' }, { dataset: { openFor: 'app', name: 'App' }, textContent: 'App' }, { dataset: { openFor: 'other', name: 'Other' }, textContent: 'Other (9)' }];
  let poll: (() => Promise<void>) | undefined;
  let submit: ((event: unknown) => Promise<void>) | undefined;
  const documentStub = {
    title: '',
    querySelector: (selector: string) => selector === '[data-section="open"] .n' ? openHeading : selector === '[data-section="feedback"] .n' ? feedbackHeading : null,
    querySelectorAll: (selector: string) => selector === '[data-count-for]' ? tiles : selector === '[data-open-for]' ? selectOptions : [],
    getElementById: (name: string) => (name === 'new-count' ? line : toast),
    addEventListener: (type: string, handler: (event: unknown) => Promise<void>) => { if (type === 'submit') submit = handler; },
    createElement: () => ({ set innerHTML(_html: string) { fired.push('parsed'); }, content: { firstElementChild: next } }),
  };
  const sandbox = {
    document: documentStub,
    HTMLFormElement: FakeForm,
    FormData: FakeFormData,
    TypeError,
    Error,
    setInterval: (callback: () => Promise<void>) => { poll = callback; return 0; },
    setTimeout: () => 0,
    clearTimeout: () => undefined,
    fetch: (url: string, init: { method: string; body: Map<string, string>; headers: Record<string, string> }) => {
      if (url.startsWith('/api/counts')) return Promise.resolve({ ok: true, json: () => Promise.resolve({ open: options.serverOpen?.() ?? 0 }) });
      calls.push({ url, init });
      return options.reply();
    },
    scrollTo: () => fired.push('scrollTo'),
    location: { set href(_value: string) { fired.push('navigate'); }, get href() { return ''; } },
  };
  vm.runInNewContext(pageScript(options.openCards), sandbox);
  let prevented = false;
  const done = submit?.({ target: form, preventDefault: () => { prevented = true; }, submitter: options.submitter });
  const again = (): Promise<void> => submit?.({ target: form, preventDefault: () => undefined }) ?? Promise.resolve();
  return { done: done ?? Promise.resolve(), again, line, anchor, poll: async (): Promise<void> => { await poll?.(); }, toast, calls, card, fired, prevented: () => prevented, next, tiles, options: selectOptions, get title() { return documentStub.title; }, openHeading, feedbackHeading };
}

const savedReply = (verdict: string, open = 0, feedback = 0) => () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true, item: { verdict, project: 'app' }, html: '<form class="card"></form>', counts: { project: { open, feedback, processed: 0 }, all: { open, feedback, processed: 0 } } }) });

test('the page script posts a card in the background with the tapped verdict and the same URL, then swaps the card in place', async () => {
  const run = runSubmit({ reply: savedReply('needs-work'), submitter: { name: 'verdict', value: 'needs-work' } });
  assert.equal(run.prevented(), true);
  assert.ok(run.card.buttons.every((button) => button.disabled), 'buttons should disable while the request is in flight');
  await run.done;

  assert.equal(run.calls.length, 1);
  assert.equal(run.calls[0]?.url, '/items/7/feedback?t=x');
  assert.equal(run.calls[0]?.init.method, 'POST');
  assert.equal(run.calls[0]?.init.headers.accept, 'application/json');
  assert.equal(run.calls[0]?.init.body.get('verdict'), 'needs-work');
  assert.equal(run.card.replaced, run.next);
  assert.deepEqual([...run.fired], ['parsed', 'class:settle', 'replaceWith', 'focus:{"preventScroll":true}']);
  assert.equal(run.toast.textContent, 'Needs work saved');
  assert.equal(run.toast.shown, true);
});

test('the page script applies saved counts while saying Approved and never scrolls or navigates', async () => {
  const run = runSubmit({ reply: savedReply('approved', 1, 2), submitter: { name: 'verdict', value: 'approved' } });
  await run.done;

  assert.equal(run.toast.textContent, 'Approved');
  assert.equal(run.tiles[1]?.textContent, '1');
  assert.equal(run.tiles[2]?.textContent, '9');
  assert.equal(run.openHeading.textContent, '1');
  assert.equal(run.feedbackHeading.textContent, '2');
  assert.equal(run.calls[0]?.init.body.get('verdict'), 'approved');
  assert.ok(!run.fired.includes('scrollTo') && !run.fired.includes('navigate'));
});

test('the page script clears the filer, closes its fold and says Sent to the agent instead of swapping a card', async () => {
  const run = runSubmit({ reply: savedReply('note'), filer: true });
  await run.done;

  assert.equal(run.card.reset, true);
  assert.equal(run.card.filer?.open, false);
  assert.equal(run.card.replaced, undefined);
  assert.equal(run.toast.textContent, 'Sent to the agent');
});

test('the page script keeps the filer\'s Project select on the tester\'s choice after clearing the form', async () => {
  const select = { value: 'second' };
  const run = runSubmit({ reply: savedReply('note'), filer: true, select });
  await run.done;

  assert.equal(run.card.reset, true);
  assert.equal(select.value, 'second');
});

test('the page script shows the server\'s message on a refusal, re-enables the buttons and leaves the card alone', async () => {
  const run = runSubmit({ reply: () => Promise.resolve({ ok: false, status: 413, json: () => Promise.resolve({ ok: false, error: 'big.png is 11.0 MB, over the 10 MB limit' }) }), submitter: { name: 'verdict', value: 'needs-work' } });
  await run.done;

  assert.equal(run.toast.textContent, 'big.png is 11.0 MB, over the 10 MB limit');
  assert.ok(run.card.buttons.every((button) => !button.disabled));
  assert.equal(run.card.replaced, undefined);
  assert.equal(run.card.dataset.busy, undefined);
});

test('the page script survives a dead network and a non-JSON answer with a toast and live buttons', async () => {
  const offline = runSubmit({ reply: () => Promise.reject(new TypeError('Failed to fetch')) });
  await offline.done;
  assert.equal(offline.toast.textContent, 'Could not reach lookover. It may have saved; reload before retrying.');
  assert.ok(offline.card.buttons.every((button) => !button.disabled));

  const garbage = runSubmit({ reply: () => Promise.resolve({ ok: false, status: 502, json: () => Promise.reject(new SyntaxError('no json')) }) });
  await garbage.done;
  assert.equal(garbage.toast.textContent, 'Could not save (502)');
  assert.ok(garbage.card.buttons.every((button) => !button.disabled));
});

test('a second submit while one is in flight sends nothing', async () => {
  let release: () => void = () => undefined;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const run = runSubmit({ reply: async () => { await pending; return { ok: true, status: 200, json: () => Promise.resolve({ ok: true, item: { verdict: 'approved' }, html: '<form class="card"></form>' }) }; } });
  assert.equal(run.card.dataset.busy, '1');
  const second = run.again();
  release();
  await Promise.all([run.done, second]);
  assert.equal(run.calls.length, 1);
});

test('answering an Awaiting card in place keeps the new-cards notice hidden, and the next real arrival still shows it', async () => {
  let open = 2;
  const run = runSubmit({ reply: savedReply('approved', 1), openCards: 2, serverOpen: () => open, submitter: { name: 'verdict', value: 'approved' } });
  await run.done;
  open = 1;
  await run.poll();
  assert.equal(run.line.hidden, true);

  open = 2;
  await run.poll();
  assert.equal(run.line.hidden, false);
  assert.equal(run.anchor.textContent, '1 new card, reload');
});

test('answering a card already waiting, or filing a new one, does not change the new-cards count', async () => {
  let open = 2;
  const waiting = runSubmit({ reply: savedReply('needs-work', 2, 1), folded: true, openCards: 2, serverOpen: () => open, submitter: { name: 'verdict', value: 'needs-work' } });
  await waiting.done;
  await waiting.poll();
  assert.equal(waiting.line.hidden, true);
  open = 3;
  await waiting.poll();
  assert.equal(waiting.anchor.textContent, '1 new card, reload');

  open = 2;
  const filer = runSubmit({ reply: savedReply('note', 2, 1), filer: true, openCards: 2, serverOpen: () => open });
  await filer.done;
  open = 3;
  await filer.poll();
  assert.equal(filer.anchor.textContent, '1 new card, reload');
});

// Runs the poll's own setInterval callback, so a wrong branch or count
// source in setTitle shows up as the wrong document.title, not as text
// matched out of the script's source.
test('the 30s poll sets the tab title from its own fetched count, and drops the prefix at zero', async () => {
  let open = 3;
  const run = runSubmit({ reply: savedReply('approved', 0, 0), serverOpen: () => open, submitter: { name: 'verdict', value: 'approved' } });
  await run.done;
  await run.poll();
  assert.equal(run.title, '(3) All projects · Lookover');

  open = 0;
  await run.poll();
  assert.equal(run.title, 'All projects · Lookover');
});

// counts.project and counts.all differ on purpose: pageScript renders the
// all view, so a setTitle that read the wrong branch (the saved item's own
// project instead of the current view) would show 9, not 4.
test('a background save sets the tab title from the view\'s own count, not the saved item\'s project', async () => {
  const reply = () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true, item: { verdict: 'approved', project: 'app' }, html: '<form class="card"></form>', counts: { project: { open: 9, feedback: 0, processed: 0 }, all: { open: 4, feedback: 0, processed: 0 } } }) });
  const run = runSubmit({ reply, submitter: { name: 'verdict', value: 'approved' } });

  await run.done;

  assert.equal(run.title, '(4) All projects · Lookover');
});

test('a background save relabels the matching jump option with the saved count, bare at zero, and leaves the rest alone', async () => {
  const some = runSubmit({ reply: savedReply('approved', 4, 2), submitter: { name: 'verdict', value: 'approved' } });
  await some.done;
  assert.equal(some.options[0]?.textContent, 'All projects (4)');
  assert.equal(some.options[1]?.textContent, 'App (4)');
  assert.equal(some.options[2]?.textContent, 'Other (9)');

  const none = runSubmit({ reply: savedReply('approved', 0, 0), submitter: { name: 'verdict', value: 'approved' } });
  await none.done;
  assert.equal(none.options[0]?.textContent, 'All projects');
  assert.equal(none.options[1]?.textContent, 'App');
});

test('every form keeps method, action and multipart encoding so the page works with no script, and the toast is a status region', async (t) => {
  const { store, project, item, server } = scratch(t);
  store.saveFeedback(store.addItem({ projectId: project.id, title: 'Waiting one' }).id, { verdict: 'approved', feedback: '' });
  const base = await listen(server);

  const html = await (await get(`${base}/p/app`)).text();

  const forms = html.match(/<form[^>]* class="card"[^>]*>/g) ?? [];
  assert.equal(forms.length, 3, 'the filer, the open card and the waiting card');
  for (const form of forms) {
    assert.match(form, /method="post"/);
    assert.match(form, /enctype="multipart\/form-data"/);
    assert.match(form, /action="\/items\/(new|\d+\/feedback)"/);
  }
  assert.ok(html.includes(`id="item-${item.id}"`));
  assert.match(html, /<div id="toast" class="toast" role="status"><\/div>/);
  assert.match(html, /\.toast\{position:fixed;[^}]*background:var\(--ink\);color:var\(--cell\)/);
  assert.match(html, /\.card\.settle\{animation:settle/);
});

import { createReadStream } from 'node:fs';
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { URL } from 'node:url';

import { ImageError, prepareImages, storedPath, storeImages, type PreparedImage } from './files.ts';
import {
  BodyTooLargeError,
  isMultipart,
  MAX_BODY_BYTES,
  MultipartError,
  parseMultipart,
  readBody,
  type MultipartFile,
} from './multipart.ts';
import { withProjectSlug, type ItemWithProject } from './commands/render.ts';
import { renderCard, renderPage } from './page.ts';
import type { Counts, FileSide, Item, Store, Verdict } from './store.ts';

export interface ServerOptions {
  token?: string;
  /** The store's home, where files/ lives. Uploads and /files/<id> need it. */
  home?: string;
  defaultProject?: string;
}

const URLENCODED_BODY_BYTES = 1024 * 1024;
const PHOTO_FIELD = 'photo';
const DISCARD_BYTES = 200 * 1024 * 1024;
const DISCARD_MS = 5000;

interface Form {
  fields: URLSearchParams;
  files: MultipartFile[];
}

export function createServer(store: Store, options: ServerOptions = {}) {
  return createHttpServer((request, response) => {
    void handleRequest(store, options, request, response);
  });
}

async function handleRequest(store: Store, options: ServerOptions, request: IncomingMessage, response: ServerResponse): Promise<void> {
  const parsed = new URL(request.url ?? '/', 'http://localhost');
  if (options.token !== undefined && parsed.searchParams.get('t') !== options.token) {
    send(response, 401, 'text/plain; charset=utf-8', 'unauthorized\n');
    return;
  }

  try {
    if (request.method === 'GET' && parsed.pathname === '/api/counts') {
      const project = parsed.searchParams.get('project');
      if (project === null || project === 'all') {
        sendJson(response, store.counts(undefined, { excludeArchived: true }));
        return;
      }
      const found = store.findProject(project);
      if (found === undefined || found.archived_at !== null) {
        send(response, 404, 'text/plain; charset=utf-8', 'not found\n');
        return;
      }
      sendJson(response, store.counts(found.id));
      return;
    }

    if (request.method === 'GET') {
      if (parsed.pathname === '/') {
        // The picker's select posts here as a GET when the page has no
        // JavaScript, because a slug is a path segment and a form cannot
        // build one.
        const asked = parsed.searchParams.get('project');
        if (asked === 'all') {
          redirect(response, `/all${tokenQuery(options)}`);
          return;
        }
        if (asked !== null && asked !== '') {
          const wanted = store.findProject(asked);
          if (wanted === undefined || wanted.archived_at !== null) {
            send(response, 404, 'text/plain; charset=utf-8', 'not found\n');
            return;
          }
          redirect(response, `/p/${encodeURIComponent(wanted.slug)}${tokenQuery(options)}`);
          return;
        }
        if (options.defaultProject !== undefined) {
          const selected = store.findProject(options.defaultProject);
          if (selected !== undefined && selected.archived_at === null) {
            redirect(response, `/p/${encodeURIComponent(selected.slug)}${tokenQuery(options)}`);
            return;
          }
        }
        const projects = store.listProjects();
        if (projects.length === 1) {
          redirect(response, `/p/${encodeURIComponent(projects[0]?.slug ?? '')}${tokenQuery(options)}`);
          return;
        }
        if (projects.length > 1) {
          redirect(response, `/all${tokenQuery(options)}`);
          return;
        }
        sendPage(response, store, 'all', options.token);
        return;
      }
      if (parsed.pathname === '/all') {
        sendPage(response, store, 'all', options.token);
        return;
      }
      const fileMatch = /^\/files\/(\d+)$/.exec(parsed.pathname);
      if (fileMatch !== null) {
        sendFile(store, options, Number(fileMatch[1]), response);
        return;
      }
      const match = /^\/p\/([^/]+)$/.exec(parsed.pathname);
      if (match !== null) {
        const slug = decodeURIComponent(match[1] ?? '');
        const project = store.findProject(slug);
        if (project === undefined || project.archived_at !== null) {
          send(response, 404, 'text/plain; charset=utf-8', 'not found\n');
          return;
        }
        sendPage(response, store, project.slug, options.token);
        return;
      }
    }

    if (request.method === 'POST' && parsed.pathname === '/items/new') {
      const form = await readForm(request);
      const title = (form.fields.get('title') ?? '').trim();
      const body = (form.fields.get('body') ?? '').trim();
      const projectSlug = form.fields.get('project') ?? '';
      const project = store.findProject(projectSlug);
      if (project === undefined || project.archived_at !== null || title === '' || title.length > 200) {
        fail(request, response, 400, 'invalid new item');
        return;
      }
      const photos = preparePhotos(form);
      const item = store.addItem({ projectId: project.id, title, details: '', source: 'chris', status: 'feedback', verdict: 'note', feedback: body });
      attach(store, options, project.slug, item.id, 'feedback', photos);
      saved(store, options, request, response, form, item.id, project.slug);
      return;
    }

    const feedbackMatch = /^\/items\/(\d+)\/feedback$/.exec(parsed.pathname);
    if (request.method === 'POST' && feedbackMatch !== null) {
      const id = Number(feedbackMatch[1]);
      const form = await readForm(request);
      const verdictField = form.fields.get('verdict');
      const verdict = validVerdict(verdictField) ? verdictField : 'note';
      const feedback = (form.fields.get('feedback') ?? '').trim();
      if (feedback === '' && verdict !== 'approved') {
        fail(request, response, 400, 'feedback is required unless approved');
        return;
      }
      const item = store.getItem(id);
      if (item === undefined || (item.status !== 'open' && item.status !== 'feedback')) {
        fail(request, response, 400, 'item cannot receive feedback');
        return;
      }
      // The last project-scoped path without this gate. Without it the save
      // stored fine and the 303 landed on the archived project's own 404, so
      // the tester saw a not-found page and could not tell whether the
      // feedback had been kept.
      const owner = store.getProject(item.project_id);
      if (owner === undefined || owner.archived_at !== null) {
        fail(request, response, 400, 'that project is archived');
        return;
      }
      const photos = preparePhotos(form);
      store.saveFeedback(id, { verdict, feedback });
      attach(store, options, owner.slug, id, 'feedback', photos);
      saved(store, options, request, response, form, id, owner.slug);
      return;
    }

    send(response, 404, 'text/plain; charset=utf-8', 'not found\n');
  } catch (error) {
    sendError(request, response, error);
  }
}

/**
 * Hanging up on a client that is still uploading makes it see a reset instead
 * of the 413, so read and drop up to DISCARD_BYTES more, for at most
 * DISCARD_MS, without buffering. Past either bound the connection is closed.
 * readBody abandons its iterator with a 'readable' listener attached, which
 * would keep the stream paused; it is removed first.
 */
function discardRest(request: IncomingMessage): void {
  let dropped = 0;
  request.removeAllListeners('readable');
  request.on('data', (chunk: Buffer) => {
    dropped += chunk.length;
    if (dropped > DISCARD_BYTES) request.destroy();
  });
  request.once('error', () => undefined);
  const timer = setTimeout(() => request.destroy(), DISCARD_MS);
  timer.unref();
  request.once('close', () => clearTimeout(timer));
  request.resume();
}

function sendError(request: IncomingMessage, response: ServerResponse, error: unknown): void {
  if (error instanceof BodyTooLargeError) {
    fail(request, response, 413, 'upload is too large');
    discardRest(request);
    return;
  }
  if (error instanceof ImageError) {
    fail(request, response, error.reason === 'size' ? 413 : 400, error.message);
    return;
  }
  if (error instanceof MultipartError) {
    fail(request, response, 400, `bad upload: ${error.message}`);
    return;
  }
  fail(request, response, 500, error instanceof Error ? error.message : String(error));
}

/** The background submit asks for JSON; a plain form post never does. */
function wantsJson(request: IncomingMessage): boolean {
  return (request.headers.accept ?? '').split(',').some((type) => type.split(';')[0]?.trim().toLowerCase() === 'application/json');
}

/** A refusal keeps its status and message either way; only the body's shape follows the Accept header. */
function fail(request: IncomingMessage, response: ServerResponse, status: number, message: string): void {
  if (wantsJson(request)) send(response, status, 'application/json; charset=utf-8', JSON.stringify({ ok: false, error: message }));
  else send(response, status, 'text/plain; charset=utf-8', `${message}\n`);
}

/**
 * Where a write ends. A form post is sent back to its card; a background
 * submit gets the saved row and the card as the page would draw it, so the
 * page can swap it in place without a reload.
 */
function saved(store: Store, options: ServerOptions, request: IncomingMessage, response: ServerResponse, form: Form, id: number, slug: string): void {
  if (!wantsJson(request)) {
    redirect(response, `${viewPath(store, form, request, slug, options)}#item-${id}`);
    return;
  }
  const item = store.getItem(id);
  if (item === undefined) throw new Error('the saved item is missing');
  const view = { projects: store.listProjects(), current: viewSlug(store, form, slug), retestVerdicts: retestVerdictsFor(store, [item]), files: store.listFilesFor([id]), token: options.token };
  // The same shape as `lookover ... --json`. Without a home no file can exist.
  const shaped = options.home === undefined ? { ...item, project: slug, files: [] } : withProjectSlug(store, options.home, [item])[0];
  if (shaped === undefined) throw new Error('the saved item is missing');
  sendJson(response, {
    ok: true,
    item: shaped,
    html: renderCard(view, item, true),
    counts: { project: store.counts(item.project_id), all: store.counts(undefined, { excludeArchived: true }) },
  });
}

function sendPage(response: ServerResponse, store: Store, current: string, token: string | undefined): void {
  const projects = store.listProjects();
  const project = current === 'all' ? undefined : projects.find((entry) => entry.slug === current);
  const projectId = project?.id;
  const options = { projectId, excludeArchived: true };
  const counts = new Map<number, Counts>(projects.map((entry) => [entry.id, store.counts(entry.id)]));
  const open = store.listItems({ ...options, status: 'open', order: 'queue' });
  const waiting = store.listItems({ ...options, status: 'feedback', order: 'newest' });
  const done = store.listItems({ ...options, status: 'processed', order: 'newest', limit: 50 });
  const retestVerdicts = retestVerdictsFor(store, [...open, ...waiting, ...done]);
  const files = store.listFilesFor([...open, ...waiting].map((item) => item.id));
  send(response, 200, 'text/html; charset=utf-8', renderPage({ projects, byActivity: store.listProjectsByActivity(), current, open, waiting, done, counts, retestVerdicts, files, token }));
}

function retestVerdictsFor(store: Store, items: Item[]): Map<number, string | null> {
  const verdicts = new Map<number, string | null>();
  for (const item of items) {
    if (item.retest_of !== null && !verdicts.has(item.retest_of)) {
      verdicts.set(item.retest_of, store.getItem(item.retest_of)?.verdict ?? null);
    }
  }
  return verdicts;
}

async function readForm(request: IncomingMessage): Promise<Form> {
  const type = request.headers['content-type'];
  const multipart = isMultipart(type);
  const limit = multipart ? MAX_BODY_BYTES : URLENCODED_BODY_BYTES;

  // A declared length over the limit is refused before a byte is read.
  if (Number(request.headers['content-length'] ?? 0) > limit) {
    throw new BodyTooLargeError(`request body is over ${limit} bytes`);
  }

  const body = await readBody(request, limit);
  return multipart
    ? parseMultipart(body, type)
    : { fields: new URLSearchParams(body.toString('utf8')), files: [] };
}

/** Checks every photo before a row is written, so a refusal stores nothing. */
function preparePhotos(form: Form): PreparedImage[] {
  return prepareImages(form.files.filter((file) => file.field === PHOTO_FIELD));
}

function attach(store: Store, options: ServerOptions, slug: string, itemId: number, side: FileSide, photos: PreparedImage[]): void {
  if (photos.length === 0) return;
  if (options.home === undefined) throw new Error('this server has no store home to keep photos in');
  storeImages(store, options.home, slug, itemId, side, photos);
}

function sendFile(store: Store, options: ServerOptions, id: number, response: ServerResponse): void {
  const file = store.getFile(id);
  if (file === undefined || options.home === undefined) {
    send(response, 404, 'text/plain; charset=utf-8', 'not found\n');
    return;
  }

  let path: string;
  try {
    path = storedPath(options.home, file.path);
  } catch {
    send(response, 404, 'text/plain; charset=utf-8', 'not found\n');
    return;
  }

  const stream = createReadStream(path);
  stream.once('error', () => {
    if (!response.headersSent) send(response, 404, 'text/plain; charset=utf-8', 'not found\n');
    else response.destroy();
  });
  stream.once('open', () => {
    response.writeHead(200, {
      'content-type': file.mime,
      'content-length': file.size,
      'content-disposition': 'inline',
      'cache-control': 'private, max-age=31536000',
      'x-content-type-options': 'nosniff',
    });
    // pipe() leaves the source open when the client hangs up mid-body.
    response.once('close', () => stream.destroy());
    stream.pipe(response);
  });
}

function validVerdict(value: string | null): value is Verdict {
  return value === 'approved' || value === 'needs-work' || value === 'note';
}

/**
 * Where to send the tester after a save. The form's own `view` field is the
 * only reliable source: the page sets `referrer: no-referrer`, so a browser
 * POST carries no Referer at all and the old referer branch never fired,
 * which sent every save from a project page to /all.
 */
function viewPath(store: Store, form: Form, request: IncomingMessage, fallbackProject: string | undefined, options: ServerOptions): string {
  const asked = form.fields.get('view');
  if (asked === 'all') return `/all${tokenQuery(options)}`;
  if (asked !== null && asked !== '') {
    const project = store.findProject(asked);
    if (project !== undefined && project.archived_at === null) {
      return `/p/${encodeURIComponent(project.slug)}${tokenQuery(options)}`;
    }
  }

  const referer = request.headers.referer;
  if (referer !== undefined) {
    try {
      const path = new URL(referer).pathname;
      if (path === '/all' || /^\/p\/[^/]+$/.test(path)) return `${path}${tokenQuery(options)}`;
    } catch { /* use the safe fallback */ }
  }
  return fallbackProject === undefined ? `/all${tokenQuery(options)}` : `/p/${encodeURIComponent(fallbackProject)}${tokenQuery(options)}`;
}

/** The view a card is drawn for: the one the form names when it is real, else the card's own project. */
function viewSlug(store: Store, form: Form, fallbackProject: string): string {
  const asked = form.fields.get('view');
  if (asked === 'all') return 'all';
  const project = asked === null || asked === '' ? undefined : store.findProject(asked);
  return project !== undefined && project.archived_at === null ? project.slug : fallbackProject;
}

function tokenQuery(options: ServerOptions): string {
  return options.token === undefined ? '' : `?t=${encodeURIComponent(options.token)}`;
}

function redirect(response: ServerResponse, location: string): void {
  response.writeHead(303, { location });
  response.end();
}

function sendJson(response: ServerResponse, value: Counts | { ok: true; item: ItemWithProject; html: string; counts: { project: Counts; all: Counts } }): void {
  send(response, 200, 'application/json; charset=utf-8', JSON.stringify(value));
}

function send(response: ServerResponse, status: number, contentType: string, body: string): void {
  response.writeHead(status, { 'content-type': contentType });
  response.end(body);
}

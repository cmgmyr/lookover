import { DatabaseSync } from 'node:sqlite';

export type ItemStatus = 'open' | 'feedback' | 'processed';
export type Verdict = 'approved' | 'needs-work' | 'note';

export interface LegacyItemRow {
  title: string;
  details: string;
  source: string;
  status: ItemStatus;
  verdict: Verdict | null;
  feedback: string | null;
  created_at: string;
  feedback_at: string | null;
  processed_at: string | null;
  processed_note: string | null;
  ref: string | null;
}

export const ITEM_STATUSES: readonly ItemStatus[] = ['open', 'feedback', 'processed'];

/** Row shapes are the column names, so lane 2 can serve them and lane 5 import them. */
export interface Project {
  id: number;
  slug: string;
  name: string;
  identity: string;
  identity_kind: string;
  root: string;
  url: string | null;
  accent: string;
  created_at: string;
  archived_at: string | null;
}

export interface Item {
  id: number;
  project_id: number;
  title: string;
  details: string;
  source: string;
  url: string | null;
  ref: string | null;
  retest_of: number | null;
  sort: number | null;
  status: ItemStatus;
  verdict: Verdict | null;
  feedback: string | null;
  created_at: string;
  feedback_at: string | null;
  processed_at: string | null;
  processed_note: string | null;
}

export type FileSide = 'card' | 'feedback';

/** `path` is relative to <home>/files, so a store can be moved. */
export interface FileRow {
  id: number;
  item_id: number;
  side: FileSide;
  name: string;
  path: string;
  mime: string;
  size: number;
  created_at: string;
}

export interface AddFileInput {
  itemId: number;
  side: FileSide;
  name: string;
  mime: string;
  size: number;
  path: string;
}

export interface Counts {
  open: number;
  feedback: number;
  processed: number;
}

/**
 * A colour, or a function that picks one from every accent already stored.
 * The function runs INSIDE registerProject's transaction, because a caller
 * that read the accents itself and then called in with a hex would be doing a
 * check-then-act: two `lookover init` runs for different projects read the
 * same set, pick the same gap, and both commit it.
 */
export type AccentChoice = string | ((taken: string[]) => string);

export interface RegisterProjectInput {
  slug: string;
  name: string;
  identity: string;
  identity_kind: string;
  root: string;
  url?: string | null;
  accent: AccentChoice;
}

export interface AddItemInput {
  projectId: number;
  title: string;
  details?: string;
  source?: string;
  url?: string | null;
  ref?: string | null;
  retestOf?: number | null;
  sort?: number | null;
  status?: ItemStatus;
  verdict?: Verdict | null;
  feedback?: string | null;
}

export type ItemOrder = 'newest' | 'queue';

export interface ListItemsInput {
  projectId?: number;
  status?: ItemStatus;
  limit?: number;
  /** 'queue' is the tester's order: the lead's sort key first, then oldest id. */
  order?: ItemOrder;
  excludeArchived?: boolean;
}

export class StoreError extends Error {}

const MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE projects (
    id INTEGER PRIMARY KEY,
    slug TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    identity TEXT NOT NULL UNIQUE,
    identity_kind TEXT NOT NULL,
    root TEXT NOT NULL,
    url TEXT,
    accent TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    archived_at TEXT
  );

  CREATE TABLE items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL REFERENCES projects(id),
    title TEXT NOT NULL,
    details TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL DEFAULT '',
    url TEXT,
    ref TEXT,
    retest_of INTEGER REFERENCES items(id),
    sort INTEGER,
    status TEXT NOT NULL DEFAULT 'open'
      CHECK (status IN ('open', 'feedback', 'processed')),
    verdict TEXT CHECK (verdict IN ('approved', 'needs-work', 'note')),
    feedback TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    feedback_at TEXT,
    processed_at TEXT,
    processed_note TEXT
  );

  CREATE INDEX items_project_status ON items (project_id, status);
  `,
  `
  CREATE TABLE files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id INTEGER NOT NULL REFERENCES items(id),
    side TEXT NOT NULL CHECK (side IN ('card', 'feedback')),
    name TEXT NOT NULL,
    path TEXT NOT NULL UNIQUE,
    mime TEXT NOT NULL,
    size INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX files_item ON files (item_id);
  `,
];

function orderBy(order: ItemOrder | undefined): string {
  // Nulls last: an unsorted card queues behind every card the lead ranked.
  return order === 'queue' ? 'sort IS NULL, sort, id' : 'id DESC';
}

const LIVE_PROJECT = 'project_id IN (SELECT id FROM projects WHERE archived_at IS NULL)';

export function openStore(path: string): Store {
  return new Store(path);
}

const OPEN_ATTEMPTS = 20;
const BUSY_BACKOFF_MIN_MS = 10;
const BUSY_BACKOFF_SPREAD_MS = 40;

/**
 * Enabling WAL takes a lock of its own, and busy_timeout does not reliably
 * cover it, so the whole open retries rather than relying on the timeout.
 */
function openDatabase(path: string): DatabaseSync {
  let lastError: unknown;

  for (let attempt = 0; attempt < OPEN_ATTEMPTS; attempt += 1) {
    let db: DatabaseSync | undefined;
    try {
      db = new DatabaseSync(path);
      // busy_timeout is armed BEFORE journal_mode: the other order leaves the
      // WAL conversion racing with no timeout at all.
      db.exec('PRAGMA busy_timeout = 5000');
      db.exec('PRAGMA journal_mode = WAL');
      db.exec('PRAGMA foreign_keys = ON');
      return db;
    } catch (error) {
      try {
        db?.close();
      } catch {
        // The handle never opened, or is already gone; the original error wins.
      }
      if (!isBusy(error)) {
        throw error;
      }
      lastError = error;
      sleepMs(BUSY_BACKOFF_MIN_MS + Math.floor(Math.random() * (BUSY_BACKOFF_SPREAD_MS + 1)));
    }
  }

  throw lastError;
}

function isBusy(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /database is locked|SQLITE_BUSY|database table is locked/i.test(message);
}

function sleepMs(ms: number): void {
  // The store is synchronous, so the backoff has to block this thread too.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export class Store {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = openDatabase(path);
    this.migrate();
  }

  registerProject(input: RegisterProjectInput): Project {
    return this.write(() => {
      const existing = this.selectProject('identity', input.identity);

      if (existing !== undefined) {
        // The slug stays put on a rename: it is the handle `--project` and the
        // page's /p/<slug> URLs use, and moving it silently breaks both. So
        // does the accent, unless this call names one: a project that already
        // has a colour is not registering, and must not be handed a new one
        // because the caller could not see it from outside the transaction.
        const accent = typeof input.accent === 'string' ? input.accent : existing.accent;
        this.db
          .prepare('UPDATE projects SET name = ?, url = ?, accent = ? WHERE id = ?')
          .run(input.name, input.url ?? null, accent, existing.id);
        return this.requireProject('id', existing.id);
      }

      const clash = this.selectProject('slug', input.slug);
      if (clash !== undefined) {
        throw new StoreError(
          `slug '${input.slug}' is already registered for ${clash.root}; pick a different --name`,
        );
      }

      const accent =
        typeof input.accent === 'string'
          ? input.accent
          : input.accent(
              this.db
                .prepare('SELECT accent FROM projects')
                .all()
                .map((row) => String((row as Record<string, unknown>)['accent'] ?? '')),
            );

      this.db
        .prepare(
          `INSERT INTO projects (slug, name, identity, identity_kind, root, url, accent)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.slug,
          input.name,
          input.identity,
          input.identity_kind,
          input.root,
          input.url ?? null,
          accent,
        );

      return this.requireProject('identity', input.identity);
    });
  }

  findProject(slugOrIdentity: string): Project | undefined {
    const row = this.db
      .prepare('SELECT * FROM projects WHERE slug = ? OR identity = ? ORDER BY id LIMIT 1')
      .get(slugOrIdentity, slugOrIdentity);

    return row === undefined ? undefined : toProject(row);
  }

  getProject(id: number): Project | undefined {
    return this.selectProject('id', id);
  }

  listProjects(options: { includeArchived?: boolean } = {}): Project[] {
    const sql =
      options.includeArchived === true
        ? 'SELECT * FROM projects ORDER BY slug'
        : 'SELECT * FROM projects WHERE archived_at IS NULL ORDER BY slug';

    return this.db.prepare(sql).all().map(toProject);
  }

  /**
   * Non-archived projects, busiest first: the newest item's created_at, then
   * the project's own created_at for one that has never been filed to, so a
   * project registered a minute ago outranks one registered last year.
   */
  listProjectsByActivity(): Project[] {
    return this.db
      .prepare(
        `SELECT projects.* FROM projects
         LEFT JOIN items ON items.project_id = projects.id
         WHERE projects.archived_at IS NULL
         GROUP BY projects.id
         ORDER BY COALESCE(MAX(items.created_at), projects.created_at) DESC, projects.id DESC`,
      )
      .all()
      .map(toProject);
  }

  archiveProject(slug: string): Project {
    return this.write(() => {
      const project = this.selectProject('slug', slug);
      if (project === undefined) {
        throw new StoreError(`no project with slug '${slug}'`);
      }

      this.db
        .prepare("UPDATE projects SET archived_at = datetime('now') WHERE id = ?")
        .run(project.id);

      return this.requireProject('id', project.id);
    });
  }

  addItem(input: AddItemInput): Item {
    const status = input.status ?? 'open';

    return this.write(() => {
      if (input.retestOf !== undefined && input.retestOf !== null) {
        const target = this.getItem(input.retestOf);
        if (target === undefined) {
          throw new StoreError(`no item #${input.retestOf} to retest`);
        }
        // Item ids are global, so an id copied out of an --all listing can
        // point at another project's card.
        if (target.project_id !== input.projectId) {
          throw new StoreError(
            `item #${input.retestOf} belongs to another project; a retest stays in its own project`,
          );
        }
      }

      const result = this.db
        .prepare(
          `INSERT INTO items
             (project_id, title, details, source, url, ref, retest_of, sort,
              status, verdict, feedback, feedback_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                   CASE WHEN ? = 'feedback' THEN datetime('now') ELSE NULL END)`,
        )
        .run(
          input.projectId,
          input.title,
          input.details ?? '',
          input.source ?? '',
          input.url ?? null,
          input.ref ?? null,
          input.retestOf ?? null,
          input.sort ?? null,
          status,
          input.verdict ?? null,
          input.feedback ?? null,
          status,
        );

      return this.requireItem(Number(result.lastInsertRowid));
    });
  }

  /** Import keeps the legacy timestamps explicit instead of pretending they happened now. */
  importItem(input: LegacyItemRow & { projectId: number }): Item {
    return this.write(() => this.insertImportedItem(input));
  }

  /** All imported rows land together, so a failed batch cannot leave a partial queue. */
  importItems(inputs: readonly (LegacyItemRow & { projectId: number })[]): Item[] {
    return this.write(() => inputs.map((input) => this.insertImportedItem(input)));
  }

  listItems(options: ListItemsInput = {}): Item[] {
    const where: string[] = [];
    const params: (string | number)[] = [];

    if (options.projectId !== undefined) {
      where.push('project_id = ?');
      params.push(options.projectId);
    }
    if (options.status !== undefined) {
      where.push('status = ?');
      params.push(options.status);
    }
    if (options.excludeArchived === true) {
      where.push(LIVE_PROJECT);
    }

    const clause = where.length === 0 ? '' : ` WHERE ${where.join(' AND ')}`;
    const limit = options.limit ?? -1;

    return this.db
      .prepare(`SELECT * FROM items${clause} ORDER BY ${orderBy(options.order)} LIMIT ?`)
      .all(...params, limit)
      .map(toItem);
  }

  getItem(id: number): Item | undefined {
    const row = this.db.prepare('SELECT * FROM items WHERE id = ?').get(id);
    return row === undefined ? undefined : toItem(row);
  }

  /** open | feedback -> feedback. The tester may revise an answer; an agent may not. */
  saveFeedback(id: number, input: { verdict: Verdict; feedback: string }): Item {
    return this.write(() => {
      const item = this.requireItem(id);
      if (item.status === 'processed') {
        throw new StoreError(`item #${id} is processed; file a retest instead of reopening it`);
      }

      this.db
        .prepare(
          `UPDATE items SET status = 'feedback', verdict = ?, feedback = ?,
                            feedback_at = datetime('now')
           WHERE id = ? AND status IN ('open', 'feedback')`,
        )
        .run(input.verdict, input.feedback, id);

      return this.requireItem(id);
    });
  }

  /** feedback -> processed. Nothing else may be processed. */
  processItem(id: number, note: string): Item {
    return this.write(() => {
      const item = this.requireItem(id);
      if (item.status !== 'feedback') {
        throw new StoreError(`item #${id} is ${item.status}, not feedback`);
      }

      this.db
        .prepare(
          `UPDATE items SET status = 'processed', processed_at = datetime('now'),
                            processed_note = ?
           WHERE id = ? AND status = 'feedback'`,
        )
        .run(note, id);

      return this.requireItem(id);
    });
  }

  addFile(input: AddFileInput): FileRow {
    return this.addFiles([input])[0] as FileRow;
  }

  /** All rows or none: one transaction, so a batch never half-lands. */
  addFiles(inputs: readonly AddFileInput[]): FileRow[] {
    return this.write(() =>
      inputs.map((input) => {
        this.requireItem(input.itemId);

        const result = this.db
          .prepare(
            'INSERT INTO files (item_id, side, name, path, mime, size) VALUES (?, ?, ?, ?, ?, ?)',
          )
          .run(input.itemId, input.side, input.name, input.path, input.mime, input.size);

        return this.requireFile(Number(result.lastInsertRowid));
      }),
    );
  }

  getFile(id: number): FileRow | undefined {
    const row = this.db.prepare('SELECT * FROM files WHERE id = ?').get(id);
    return row === undefined ? undefined : toFile(row);
  }

  listFiles(itemId: number): FileRow[] {
    return this.db
      .prepare('SELECT * FROM files WHERE item_id = ? ORDER BY id')
      .all(itemId)
      .map(toFile);
  }

  /** Every requested id gets an entry, empty when the item has no files. */
  listFilesFor(itemIds: readonly number[]): Map<number, FileRow[]> {
    const byItem = new Map<number, FileRow[]>(itemIds.map((id) => [id, []]));
    if (itemIds.length === 0) {
      return byItem;
    }

    const marks = itemIds.map(() => '?').join(', ');
    const rows = this.db
      .prepare(`SELECT * FROM files WHERE item_id IN (${marks}) ORDER BY id`)
      .all(...itemIds)
      .map(toFile);

    for (const row of rows) {
      byItem.get(row.item_id)?.push(row);
    }
    return byItem;
  }

  counts(projectId?: number, options: { excludeArchived?: boolean } = {}): Counts {
    const where: string[] = [];
    const params: number[] = [];

    if (projectId !== undefined) {
      where.push('project_id = ?');
      params.push(projectId);
    }
    if (options.excludeArchived === true) {
      where.push(LIVE_PROJECT);
    }

    const clause = where.length === 0 ? '' : ` WHERE ${where.join(' AND ')}`;
    const rows = this.db
      .prepare(`SELECT status, COUNT(*) AS n FROM items${clause} GROUP BY status`)
      .all(...params);

    const counts: Counts = { open: 0, feedback: 0, processed: 0 };
    for (const row of rows) {
      const record = row as Record<string, unknown>;
      const status = String(record['status']);
      if (status === 'open' || status === 'feedback' || status === 'processed') {
        counts[status] = Number(record['n']);
      }
    }

    return counts;
  }

  countItems(projectId: number): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM items WHERE project_id = ?').get(projectId);
    return Number((row as Record<string, unknown>)['n']);
  }

  schemaVersion(): number {
    const row = this.db.prepare('SELECT version FROM schema_version WHERE id = 1').get();
    return row === undefined ? 0 : Number((row as Record<string, unknown>)['version']);
  }

  pragma(name: string): unknown {
    const row = this.db.prepare(`PRAGMA ${name}`).get();
    return row === undefined ? undefined : Object.values(row)[0];
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    // Bootstrap, version read and migration apply share ONE transaction. Split
    // them and two processes both read version 0 and both run migration 0.
    this.write(() => {
      this.db.exec(
        `CREATE TABLE IF NOT EXISTS schema_version (
           id INTEGER PRIMARY KEY CHECK (id = 1),
           version INTEGER NOT NULL
         )`,
      );
      this.db.exec('INSERT OR IGNORE INTO schema_version (id, version) VALUES (1, 0)');

      const row = this.db.prepare('SELECT version FROM schema_version WHERE id = 1').get();
      const applied = Number((row as Record<string, unknown>)['version']);

      for (const [index, sql] of MIGRATIONS.entries()) {
        if (index < applied) {
          continue;
        }

        this.db.exec(sql);
        this.db.prepare('UPDATE schema_version SET version = ? WHERE id = 1').run(index + 1);
      }
    });
  }

  private write<T>(fn: () => T): T {
    // IMMEDIATE takes the write lock at BEGIN, where busy_timeout can wait for
    // it, instead of upgrading mid-transaction where it cannot.
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // A failed BEGIN leaves nothing to roll back; the original error wins.
      }
      throw error;
    }
  }

  private selectProject(column: 'id' | 'slug' | 'identity', value: string | number): Project | undefined {
    const row = this.db.prepare(`SELECT * FROM projects WHERE ${column} = ?`).get(value);
    return row === undefined ? undefined : toProject(row);
  }

  private requireProject(column: 'id' | 'slug' | 'identity', value: string | number): Project {
    const project = this.selectProject(column, value);
    if (project === undefined) {
      throw new StoreError(`no project with ${column} '${value}'`);
    }
    return project;
  }

  private requireFile(id: number): FileRow {
    const file = this.getFile(id);
    if (file === undefined) {
      throw new StoreError(`no file #${id}`);
    }
    return file;
  }

  private requireItem(id: number): Item {
    const item = this.getItem(id);
    if (item === undefined) {
      throw new StoreError(`no item #${id}`);
    }
    return item;
  }

  private insertImportedItem(input: LegacyItemRow & { projectId: number }): Item {
    const result = this.db
      .prepare(
        `INSERT INTO items
           (project_id, title, details, source, url, ref, retest_of, sort,
            status, verdict, feedback, created_at, feedback_at, processed_at, processed_note)
         VALUES (?, ?, ?, ?, NULL, ?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.projectId,
        input.title,
        input.details,
        input.source,
        input.ref,
        input.status,
        input.verdict,
        input.feedback,
        input.created_at,
        input.feedback_at,
        input.processed_at,
        input.processed_note,
      );

    return this.requireItem(Number(result.lastInsertRowid));
  }
}

function toProject(row: unknown): Project {
  const record = row as Record<string, unknown>;
  return {
    id: Number(record['id']),
    slug: text(record['slug']),
    name: text(record['name']),
    identity: text(record['identity']),
    identity_kind: text(record['identity_kind']),
    root: text(record['root']),
    url: maybeText(record['url']),
    accent: text(record['accent']),
    created_at: text(record['created_at']),
    archived_at: maybeText(record['archived_at']),
  };
}

function toItem(row: unknown): Item {
  const record = row as Record<string, unknown>;
  return {
    id: Number(record['id']),
    project_id: Number(record['project_id']),
    title: text(record['title']),
    details: text(record['details']),
    source: text(record['source']),
    url: maybeText(record['url']),
    ref: maybeText(record['ref']),
    retest_of: maybeNumber(record['retest_of']),
    sort: maybeNumber(record['sort']),
    status: text(record['status']) as ItemStatus,
    verdict: maybeText(record['verdict']) as Verdict | null,
    feedback: maybeText(record['feedback']),
    created_at: text(record['created_at']),
    feedback_at: maybeText(record['feedback_at']),
    processed_at: maybeText(record['processed_at']),
    processed_note: maybeText(record['processed_note']),
  };
}

function toFile(row: unknown): FileRow {
  const record = row as Record<string, unknown>;
  return {
    id: Number(record['id']),
    item_id: Number(record['item_id']),
    side: text(record['side']) as FileSide,
    name: text(record['name']),
    path: text(record['path']),
    mime: text(record['mime']),
    size: Number(record['size']),
    created_at: text(record['created_at']),
  };
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : String(value);
}

function maybeText(value: unknown): string | null {
  return value === null || value === undefined ? null : text(value);
}

function maybeNumber(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}

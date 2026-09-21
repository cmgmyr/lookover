import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { basename, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { prepareImages, storeImages } from '../files.ts';
import { planImport, resolveImageRefs, findImageRefs } from '../import.ts';
import { CliError, withSession } from '../session.ts';
import type { LegacyItemRow } from '../store.ts';

const LEGACY_COLUMNS = ['id', 'title', 'details', 'source', 'status', 'verdict', 'feedback', 'created_at', 'feedback_at', 'processed_at', 'processed_note'];

export function runImport(argv: string[]): number {
  const { values } = parseArgs({
    args: argv,
    strict: true,
    options: {
      from: { type: 'string' }, images: { type: 'string' }, project: { type: 'string' }, 'dry-run': { type: 'boolean' },
    },
  });
  if (values.from === undefined) throw new CliError('import needs --from <sqlite>');
  if (values.project === undefined || values.project.trim() === '') throw new CliError('import needs --project <slug>');

  const legacy = openLegacy(values.from);
  try {
    validateSchema(legacy);
    const raw = legacy.prepare('SELECT id, title, details, source, status, verdict, feedback, created_at, feedback_at, processed_at, processed_note FROM items ORDER BY id').all();
    return withSession(({ home, store }) => {
      const project = store.findProject(values.project as string);
      if (project === undefined) throw new CliError(`no project with slug '${values.project}'`);
      const existing = store.countItems(project.id);
      if (existing > 0) throw new CliError(`project '${project.slug}' already has ${existing} items; import requires an empty project`);

      const rows = raw.map((value) => toLegacy(value));
      const plan = planImport(rows, project.id, values.images);
      const counts = countStatuses(rows);
      if (values['dry-run'] === true) {
        const plannedFiles = plan.matches.reduce((total, match) => total + match.files.length, 0);
        const plannedRows = plan.matches.filter((match) => match.files.length > 0).length;
        printReport(project.slug, counts, plan, plannedFiles, plannedRows, 0, [], values.images, true);
        return 0;
      }

      const items = store.importItems(plan.rows);
      let attached = 0;
      let failed = 0;
      const attachedRows = new Set<number>();
      const failures: string[] = [];
      if (values.images !== undefined) {
        for (let index = 0; index < rows.length; index += 1) {
          const refs = findImageRefs(rows[index]?.details ?? '');
          const files = resolveImageRefs(refs, values.images).flatMap((match) => match.files);
          for (let start = 0; start < files.length; start += 5) {
            try {
              const inputs = files.slice(start, start + 5).map((path) => ({ name: basename(path), data: readFileSync(path) }));
              const stored = storeImages(store, home, project.slug, items[index]!.id, 'card', prepareImages(inputs));
              attached += stored.length;
              if (stored.length > 0) attachedRows.add(items[index]!.id);
            } catch (error) {
              const batchSize = files.slice(start, start + 5).length;
              failed += batchSize;
              const legacyId = Number((raw[index] as Record<string, unknown>)['id']);
              const message = error instanceof Error ? error.message : String(error);
              failures.push(`failed to attach ${batchSize} files for #${legacyId}: ${message}`);
            }
          }
        }
      }
      printReport(project.slug, counts, plan, attached, attachedRows.size, failed, failures, values.images, false);
      return failed === 0 ? 0 : 1;
    });
  } finally {
    legacy.close();
  }
}

function openLegacy(path: string): DatabaseSync {
  try { return new DatabaseSync(path, { readOnly: true }); }
  catch { throw new CliError(`cannot open legacy sqlite '${path}' read-only`); }
}

function validateSchema(db: DatabaseSync): void {
  let columns: unknown[];
  try { columns = db.prepare('PRAGMA table_info(items)').all(); }
  catch { throw new CliError('legacy sqlite has no readable items table'); }
  const names = columns.map((column) => String((column as Record<string, unknown>)['name']));
  if (names.length !== LEGACY_COLUMNS.length || names.some((name, index) => name !== LEGACY_COLUMNS[index])) {
    throw new CliError('legacy sqlite items table does not match novelhood testing schema');
  }
}

function toLegacy(value: unknown): LegacyItemRow {
  const row = value as Record<string, unknown>;
  return {
    title: requiredText(row['title']), details: requiredText(row['details']), source: requiredText(row['source']),
    status: requiredText(row['status']) as LegacyItemRow['status'], verdict: nullableText(row['verdict']) as LegacyItemRow['verdict'],
    feedback: nullableText(row['feedback']), created_at: requiredText(row['created_at']), feedback_at: nullableText(row['feedback_at']),
    processed_at: nullableText(row['processed_at']), processed_note: nullableText(row['processed_note']),
    ref: row['id'] === undefined || row['id'] === null ? null : `novelhood #${Number(row['id'])}`,
  };
}

function requiredText(value: unknown): string { return typeof value === 'string' ? value : String(value ?? ''); }
function nullableText(value: unknown): string | null { return value === null || value === undefined ? null : String(value); }

function countStatuses(rows: readonly LegacyItemRow[]): { open: number; feedback: number; processed: number } {
  const counts = { open: 0, feedback: 0, processed: 0 };
  for (const row of rows) if (row.status in counts) counts[row.status as keyof typeof counts] += 1;
  return counts;
}

function printReport(slug: string, counts: { open: number; feedback: number; processed: number }, plan: ReturnType<typeof planImport>, attached: number, attachedRows: number, failed: number, failures: readonly string[], imagesDir: string | undefined, dryRun: boolean): void {
  const waiting = counts.feedback;
  process.stdout.write(`imported ${plan.rows.length} rows into ${slug} (${counts.open} open, ${waiting} waiting, ${counts.processed} processed); attached ${attached} files to ${attachedRows} rows; skipped ${plan.skipped.length} unreferenced files:\n`);
  for (const match of plan.matches) for (const file of match.files) process.stdout.write(`  attached ${relativeImagePath(file, imagesDir)}\n`);
  for (const file of plan.skipped) process.stdout.write(`  skipped ${relativeImagePath(file, imagesDir)}\n`);
  for (const failure of failures) process.stdout.write(`${failure}\n`);
  if (dryRun) process.stdout.write('--dry-run: nothing written\n');
}

function relativeImagePath(path: string, imagesDir: string | undefined): string {
  if (imagesDir === undefined) return path;
  const root = resolve(imagesDir);
  const child = relative(root, path);
  return child === '' || child.startsWith('..') ? path : child;
}

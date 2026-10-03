import { unlinkSync } from 'node:fs';
import { parseArgs } from 'node:util';

import { storedPath } from '../files.ts';
import { CliError, projectScope, withSession } from '../session.ts';
import type { FileRow } from '../store.ts';

const DEFAULT_DAYS = 30;

export function runPrune(argv: string[]): number {
  const { values } = parseArgs({
    args: argv,
    strict: true,
    options: {
      'older-than': { type: 'string' },
      project: { type: 'string' },
      all: { type: 'boolean' },
      yes: { type: 'boolean' },
    },
  });

  const days = parseDays(values['older-than']);

  return withSession(({ home, store }) => {
    const project = projectScope(store, values);
    const slugs = new Map(store.listProjects({ includeArchived: true }).map((p) => [p.id, p.slug]));

    // A card with a row that leaves files/ is skipped whole: pruning part of a
    // card is out of scope, and its rows must stay to show what is wrong.
    const cards = store.prunable(days, project?.id).filter((card) => {
      const bad = card.files.find((file) => !insideFiles(home, file));
      if (bad !== undefined) {
        process.stderr.write(`skipped #${card.id}: stored path leaves the files directory: ${bad.path}\n`);
      }
      return bad === undefined;
    });

    if (cards.length === 0) {
      process.stdout.write(`nothing to prune (cards processed more than ${days} days ago with images)\n`);
      return 0;
    }

    if (values.yes !== true) {
      for (const card of cards) {
        const label = `#${card.id} ${slugs.get(card.project_id) ?? '?'} ${card.title}`;
        process.stdout.write(`${label}: ${card.files.length} images, ${mb(sum(card.files))} MB\n`);
      }
      const all = cards.flatMap((card) => card.files);
      process.stdout.write(
        `${all.length} images, ${mb(sum(all))} MB on ${cards.length} cards; run with --yes to remove them\n`,
      );
      return 0;
    }

    const removed = store.pruneFiles(
      cards.map((card) => card.id),
      days,
    );
    const touched = new Set(removed.map((file) => file.item_id));

    // Rows are gone and committed; only now do the files go. A failure here
    // leaves an orphan file, never a row pointing at nothing.
    let failed = false;
    for (const file of removed) {
      try {
        unlinkSync(storedPath(home, file.path));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          process.stderr.write(`could not remove ${file.path}: ${(error as Error).message}\n`);
          failed = true;
        }
      }
    }

    if (removed.length === 0) {
      process.stdout.write(`nothing to prune (cards processed more than ${days} days ago with images)\n`);
      return failed ? 1 : 0;
    }

    process.stdout.write(`removed ${removed.length} images (${mb(sum(removed))} MB) from ${touched.size} cards\n`);
    return failed ? 1 : 0;
  });
}

function parseDays(raw: string | undefined): number {
  if (raw === undefined) {
    return DEFAULT_DAYS;
  }

  const match = /^(\d+)d$/.exec(raw);
  const days = match === null ? 0 : Number(match[1]);
  if (!Number.isSafeInteger(days) || days < 1) {
    throw new CliError(`'${raw}' is not a number of days; use --older-than <n>d, for example 30d`);
  }
  return days;
}

function insideFiles(home: string, file: FileRow): boolean {
  try {
    storedPath(home, file.path);
    return true;
  } catch {
    return false;
  }
}

function sum(files: readonly FileRow[]): number {
  return files.reduce((total, file) => total + file.size, 0);
}

function mb(bytes: number): string {
  return (bytes / 1024 / 1024).toFixed(1);
}

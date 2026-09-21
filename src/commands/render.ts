import { storedPath } from '../files.ts';
import type { FileSide, Item, Project, Store } from '../store.ts';

export interface ItemFile {
  id: number;
  side: FileSide;
  name: string;
  mime: string;
  size: number;
  /** Absolute, so an agent can open it without knowing where the store lives. */
  path: string;
}

export interface ItemWithProject extends Item {
  project: string;
  files: ItemFile[];
}

/**
 * Items carry their project slug, so --all output says which project each is
 * from, and their files, so an agent can open the tester's photo.
 */
export function withProjectSlug(store: Store, home: string, items: Item[]): ItemWithProject[] {
  const slugs = new Map<number, string>();
  for (const project of store.listProjects({ includeArchived: true })) {
    slugs.set(project.id, project.slug);
  }
  const files = store.listFilesFor(items.map((item) => item.id));

  return items.map((item) => ({
    ...item,
    project: slugs.get(item.project_id) ?? '?',
    files: (files.get(item.id) ?? []).map((file) => ({
      id: file.id,
      side: file.side,
      name: file.name,
      mime: file.mime,
      size: file.size,
      path: storedPath(home, file.path),
    })),
  }));
}

export function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

/** One line per card: id, status, project, title. */
export function printItemLines(items: ItemWithProject[], empty: string): void {
  if (items.length === 0) {
    process.stdout.write(`${empty}\n`);
    return;
  }

  for (const item of items) {
    const sort = item.sort === null ? '' : ` [${item.sort}]`;
    process.stdout.write(
      `#${item.id}  ${item.status.padEnd(9)} ${item.project}  ${item.title}${sort}\n`,
    );
  }
}

/** One block per card: what the lead needs to sweep a verdict into a lane. */
export function printFeedbackBlocks(items: ItemWithProject[], empty: string): void {
  if (items.length === 0) {
    process.stdout.write(`${empty}\n`);
    return;
  }

  items.forEach((item, index) => {
    if (index > 0) {
      process.stdout.write('\n');
    }

    process.stdout.write(`#${item.id}  ${item.project}  ${item.verdict ?? 'no verdict'}\n`);
    process.stdout.write(`  ${item.title}\n`);
    if (item.url !== null) {
      process.stdout.write(`  ${item.url}\n`);
    }
    if (item.feedback !== null && item.feedback !== '') {
      for (const line of item.feedback.split('\n')) {
        process.stdout.write(`  ${line}\n`);
      }
    }
    for (const file of item.files) {
      process.stdout.write(`  ${file.side} image: ${file.path}\n`);
    }
  });
}

export function projectLine(project: Project, counts: { open: number; feedback: number }): string {
  const url = project.url === null ? '' : `  ${project.url}`;
  const archived = project.archived_at === null ? '' : '  (archived)';
  return `${project.slug.padEnd(20)} ${String(counts.open).padStart(3)} open ${String(
    counts.feedback,
  ).padStart(3)} waiting  ${project.root}${url}${archived}`;
}

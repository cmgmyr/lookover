import { readFileSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import { parseArgs } from 'node:util';

import { MAX_FILE_BYTES, MAX_FILES, prepareImages, storeImages } from '../files.ts';
import { CliError, currentProject, withSession } from '../session.ts';

export function runAdd(argv: string[]): number {
  const { values } = parseArgs({
    args: argv,
    strict: true,
    options: {
      title: { type: 'string' },
      details: { type: 'string' },
      'details-file': { type: 'string' },
      source: { type: 'string' },
      url: { type: 'string' },
      ref: { type: 'string' },
      'retest-of': { type: 'string' },
      sort: { type: 'string' },
      project: { type: 'string' },
      image: { type: 'string', multiple: true },
    },
  });

  const title = values.title;
  if (title === undefined || title.trim() === '') {
    throw new CliError('add needs --title <title>');
  }

  if (values.details !== undefined && values['details-file'] !== undefined) {
    throw new CliError('--details and --details-file cannot be used together');
  }

  const details = readDetails(values.details, values['details-file']);
  const retestOf = optionalId(values['retest-of'], '--retest-of');
  const sort = optionalSort(values.sort);

  // Every image is checked before the card exists, so a bad one files nothing.
  const images = prepareImages(readImages(values.image ?? []));

  return withSession(({ home, store }) => {
    const project = currentProject(store, values.project);

    const item = store.addItem({
      projectId: project.id,
      title,
      details,
      source: values.source ?? '',
      url: values.url ?? null,
      ref: values.ref ?? null,
      retestOf,
      sort,
    });

    storeImages(store, home, project.slug, item.id, 'card', images);

    const count = images.length === 0 ? '' : ` (${images.length} ${images.length === 1 ? 'image' : 'images'})`;
    process.stdout.write(`added #${item.id} to ${project.slug}${count}\n`);
    return 0;
  });
}

function readImages(paths: string[]): { name: string; data: Buffer }[] {
  if (paths.length > MAX_FILES) {
    throw new CliError(`--image can be given at most ${MAX_FILES} times, not ${paths.length}`);
  }

  return paths.map((path) => {
    try {
      // The size check comes first so a huge file is refused unread.
      if (statSync(path).size > MAX_FILE_BYTES) {
        throw new CliError(`${basename(path)} is over the ${MAX_FILE_BYTES / 1024 / 1024} MB limit per image`);
      }
      return { name: basename(path), data: readFileSync(path) };
    } catch (error) {
      if (error instanceof CliError) {
        throw error;
      }
      throw new CliError(`cannot read --image ${path}`);
    }
  });
}

function readDetails(inline: string | undefined, path: string | undefined): string {
  if (inline !== undefined) {
    return inline;
  }
  if (path === undefined) {
    return '';
  }

  try {
    // No trimming: agents put markdown, fences and `---` in here and the row
    // has to match the file byte for byte.
    return readFileSync(path, 'utf8');
  } catch {
    throw new CliError(`cannot read --details-file ${path}`);
  }
}

function optionalId(raw: string | undefined, flag: string): number | null {
  if (raw === undefined) {
    return null;
  }

  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new CliError(`${flag} must be a positive item id, not '${raw}'`);
  }
  return value;
}

function optionalSort(raw: string | undefined): number | null {
  if (raw === undefined) {
    return null;
  }

  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 3) {
    throw new CliError(`--sort must be 1, 2 or 3, not '${raw}'`);
  }
  return value;
}

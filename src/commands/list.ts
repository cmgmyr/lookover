import { parseArgs } from 'node:util';

import { CliError, projectScope, withSession } from '../session.ts';
import { ITEM_STATUSES, type ItemStatus } from '../store.ts';
import { printItemLines, printJson, withProjectSlug } from './render.ts';

const DEFAULT_LIMIT = 50;

export function runList(argv: string[]): number {
  const { values } = parseArgs({
    args: argv,
    strict: true,
    options: {
      project: { type: 'string' },
      all: { type: 'boolean' },
      status: { type: 'string' },
      limit: { type: 'string' },
      json: { type: 'boolean' },
    },
  });

  const status = parseStatus(values.status);
  const limit = parseLimit(values.limit);

  return withSession(({ home, store }) => {
    const project = projectScope(store, values);
    const items = withProjectSlug(
      store,
      home,
      store.listItems({
        projectId: project?.id,
        status,
        limit,
        excludeArchived: values.all === true,
      }),
    );

    if (values.json === true) {
      printJson(items);
    } else {
      printItemLines(items, 'no cards.');
    }

    return 0;
  });
}

function parseStatus(raw: string | undefined): ItemStatus | undefined {
  if (raw === undefined) {
    return undefined;
  }

  const match = ITEM_STATUSES.find((status) => status === raw);
  if (match === undefined) {
    throw new CliError(`--status must be one of ${ITEM_STATUSES.join(', ')}, not '${raw}'`);
  }
  return match;
}

function parseLimit(raw: string | undefined): number {
  if (raw === undefined) {
    return DEFAULT_LIMIT;
  }

  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new CliError(`--limit must be a positive whole number, not '${raw}'`);
  }
  return value;
}

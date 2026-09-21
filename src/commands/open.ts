import { parseArgs } from 'node:util';

import { projectScope, withSession } from '../session.ts';
import { printItemLines, printJson, withProjectSlug } from './render.ts';

export function runOpen(argv: string[]): number {
  const { values } = parseArgs({
    args: argv,
    strict: true,
    options: {
      project: { type: 'string' },
      all: { type: 'boolean' },
      count: { type: 'boolean' },
      json: { type: 'boolean' },
    },
  });

  return withSession(({ home, store }) => {
    const project = projectScope(store, values);
    const all = values.all === true;

    if (values.count === true) {
      // Just the integer, so a status line or a board pad can carry it.
      process.stdout.write(`${store.counts(project?.id, { excludeArchived: all }).open}\n`);
      return 0;
    }

    const items = withProjectSlug(
      store,
      home,
      store.listItems({
        projectId: project?.id,
        status: 'open',
        order: 'queue',
        excludeArchived: all,
      }),
    );

    if (values.json === true) {
      printJson(items);
    } else {
      printItemLines(items, 'nothing to test. A real and good state.');
    }

    return 0;
  });
}

import { parseArgs } from 'node:util';

import { projectScope, withSession } from '../session.ts';
import { printFeedbackBlocks, printJson, withProjectSlug } from './render.ts';

export function runFeedback(argv: string[]): number {
  const { values } = parseArgs({
    args: argv,
    strict: true,
    options: {
      project: { type: 'string' },
      all: { type: 'boolean' },
      json: { type: 'boolean' },
    },
  });

  return withSession(({ home, store }) => {
    const project = projectScope(store, values);
    const items = withProjectSlug(
      store,
      home,
      store.listItems({
        projectId: project?.id,
        status: 'feedback',
        excludeArchived: values.all === true,
      }),
    );

    if (values.json === true) {
      printJson(items);
    } else {
      printFeedbackBlocks(items, 'nothing waiting on the agent.');
    }

    return 0;
  });
}

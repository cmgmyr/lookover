import { parseArgs } from 'node:util';

import { CliError, withSession } from '../session.ts';

export function runProcess(argv: string[]): number {
  const { values, positionals } = parseArgs({
    args: argv,
    strict: true,
    allowPositionals: true,
    options: {
      note: { type: 'string' },
    },
  });

  const raw = positionals[0];
  if (raw === undefined) {
    throw new CliError('process needs an item id');
  }

  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) {
    throw new CliError(`'${raw}' is not an item id`);
  }

  const note = values.note;
  if (note === undefined || note.trim() === '') {
    throw new CliError('process needs --note <text>');
  }

  return withSession(({ store }) => {
    store.processItem(id, note);
    process.stdout.write(`processed #${id}\n`);
    return 0;
  });
}

import { parseArgs } from 'node:util';

import { CliError, withSession } from '../session.ts';
import { printJson, projectLine } from './render.ts';

export function runProject(argv: string[]): number {
  const subcommand = argv[0];

  if (subcommand === 'list') {
    return listProjects(argv.slice(1));
  }
  if (subcommand === 'archive') {
    return archiveProject(argv.slice(1));
  }

  throw new CliError(
    subcommand === undefined
      ? 'project needs a subcommand: list or archive'
      : `unknown project subcommand '${subcommand}'; expected list or archive`,
  );
}

function listProjects(argv: string[]): number {
  const { values } = parseArgs({
    args: argv,
    strict: true,
    options: {
      json: { type: 'boolean' },
      all: { type: 'boolean' },
    },
  });

  return withSession(({ store }) => {
    const projects = store.listProjects({ includeArchived: values.all === true });

    if (values.json === true) {
      printJson(projects.map((project) => ({ ...project, counts: store.counts(project.id) })));
      return 0;
    }

    if (projects.length === 0) {
      process.stdout.write('no projects registered; run `lookover init --name <name>`\n');
      return 0;
    }

    for (const project of projects) {
      process.stdout.write(`${projectLine(project, store.counts(project.id))}\n`);
    }

    return 0;
  });
}

function archiveProject(argv: string[]): number {
  const { positionals } = parseArgs({ args: argv, strict: true, allowPositionals: true });

  const slug = positionals[0];
  if (slug === undefined) {
    throw new CliError('project archive needs a slug');
  }

  return withSession(({ store }) => {
    store.archiveProject(slug);
    process.stdout.write(`archived ${slug}\n`);
    return 0;
  });
}

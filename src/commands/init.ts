import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

import { accentForRegistration } from '../accent.ts';
import { dbPath, ensureHome, resolveHome, STORE_DIR } from '../home.ts';
import { projectIdentity } from '../identity.ts';
import { slugify } from '../slug.ts';
import { CliError } from '../session.ts';
import { openStore } from '../store.ts';

const ACCENT_PATTERN = /^#[0-9a-fA-F]{6}$/;

export function runInit(argv: string[]): number {
  const { values } = parseArgs({
    args: argv,
    strict: true,
    options: {
      local: { type: 'boolean' },
      name: { type: 'string' },
      url: { type: 'string' },
      accent: { type: 'string' },
    },
  });

  const name = values.name;
  if (name === undefined || name.trim() === '') {
    throw new CliError('init needs --name <name>');
  }

  const slug = slugify(name);
  if (slug === '') {
    throw new CliError(`--name '${name}' has no letters or digits to make a slug from`);
  }

  if (values.accent !== undefined && !ACCENT_PATTERN.test(values.accent)) {
    throw new CliError(`--accent must look like #rrggbb, not '${values.accent}'`);
  }

  const explicitHome = process.env['LOOKOVER_HOME'];
  if (values.local === true && explicitHome !== undefined && explicitHome.trim() !== '') {
    // resolveHome puts LOOKOVER_HOME ahead of the local walk-up, so a store
    // written here would be one no other command ever reads.
    throw new CliError(
      'LOOKOVER_HOME is set, and every other command reads it before a local ' +
        'store; unset it or drop --local',
    );
  }

  const identity = projectIdentity(process.cwd());
  const home =
    values.local === true
      ? join(identity.root, STORE_DIR)
      : resolveHome(process.env, process.cwd());

  ensureHome(home);
  if (values.local === true) {
    ignoreLocalStore(identity.root);
  }

  const store = openStore(dbPath(home));
  try {
    const existing = store.findProject(identity.identity);

    // A flag that was not passed keeps what is stored. Re-running init to
    // correct a name must not silently drop the base URL or a chosen accent.
    const project = store.registerProject({
      slug: existing?.slug ?? slug,
      name,
      identity: identity.identity,
      identity_kind: identity.kind,
      root: identity.root,
      url: values.url ?? existing?.url ?? null,
      // The function, not a colour: the store calls it inside the transaction
      // that inserts the row, so two inits racing cannot pick the same gap.
      // It is never called for a project that already exists.
      accent: values.accent ?? accentForRegistration,
    });

    process.stdout.write(`${existing === undefined ? 'registered' : 'updated'} ${project.slug}\n`);
    process.stdout.write(`store: ${home}\n`);
  } finally {
    store.close();
  }

  return 0;
}

function ignoreLocalStore(root: string): void {
  const path = join(root, '.gitignore');
  const entry = `${STORE_DIR}/`;

  let current = '';
  try {
    current = readFileSync(path, 'utf8');
  } catch {
    writeFileSync(path, `${entry}\n`);
    return;
  }

  if (current.split('\n').some((line) => line.trim() === entry || line.trim() === STORE_DIR)) {
    return;
  }

  appendFileSync(path, current.endsWith('\n') || current === '' ? `${entry}\n` : `\n${entry}\n`);
}

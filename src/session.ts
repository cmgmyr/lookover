import { dbPath, ensureHome, resolveHome } from './home.ts';
import { projectIdentity } from './identity.ts';
import { openStore, type Project, type Store } from './store.ts';

/** An error the user caused. The CLI prints its message and nothing else. */
export class CliError extends Error {}

export interface Session {
  home: string;
  store: Store;
}

export function withSession<T>(fn: (session: Session) => T): T {
  const home = ensureHome(resolveHome(process.env, process.cwd()));
  const store = openStore(dbPath(home));

  try {
    return fn({ home, store });
  } finally {
    store.close();
  }
}

/** The named project, else the one registered for the current directory. */
export function currentProject(store: Store, slug: string | undefined): Project {
  if (slug !== undefined) {
    const named = store.findProject(slug);
    if (named === undefined) {
      throw new CliError(`no project with slug '${slug}'`);
    }
    return named;
  }

  const { identity } = projectIdentity(process.cwd());
  const registered = store.findProject(identity);
  if (registered === undefined) {
    throw new CliError(
      'no project registered for this directory; run `lookover init --name <name>`',
    );
  }

  return registered;
}

/** undefined means every project, which is what --all asks for. */
export function projectScope(
  store: Store,
  options: { project?: string | undefined; all?: boolean | undefined },
): Project | undefined {
  if (options.all === true) {
    if (options.project !== undefined) {
      throw new CliError('--project and --all cannot be used together');
    }
    return undefined;
  }

  return currentProject(store, options.project);
}

import { readFileSync } from 'node:fs';

import { runAdd } from './commands/add.ts';
import { runFeedback } from './commands/feedback.ts';
import { runInit } from './commands/init.ts';
import { runImport } from './commands/import.ts';
import { runList } from './commands/list.ts';
import { runOpen } from './commands/open.ts';
import { runProcess } from './commands/process.ts';
import { runProject } from './commands/project.ts';
import { runSkill } from './commands/skill.ts';
import { runServe } from './commands/serve.ts';

const USAGE = `lookover - a manual-testing queue for agent crews and one human tester.

usage: lookover <command> [options]

  init [--local] --name <name> [--url <base url>] [--accent #rrggbb]
      Register the current directory's project.

  add --title <t> (--details <d> | --details-file <path>)
      [--source <s>] [--url <u>] [--ref <r>] [--retest-of <id>]
      [--sort 1|2|3] [--project <slug>] [--image <path>]...
      File a card for the tester. --image attaches a PNG, JPEG, WebP or
      GIF (10 MB each, 5 per card).

  feedback [--project <slug> | --all] [--json]
      Cards the tester has answered and the agent has not processed.

  process <id> --note <text>
      Mark an answered card handled.

  open [--project <slug> | --all] [--count] [--json]
      Cards still waiting on the tester.

  list [--project <slug> | --all] [--status <s>] [--limit N] [--json]
      Cards in any status, newest first (default limit 50).

  project list [--json] [--all]
  project archive <slug>
      Manage registered projects.

  skill install [--to agents|claude|project] [--force]
      Install the Lookover agent skill.

  skill path
      Print the installed skill source directory.

  serve [--host <host>] [--port <port>] [--token <token>] [--no-replace]
      Serve the manual-testing page.

  import --from <sqlite> [--images <dir>] --project <slug> [--dry-run]
      Import a novelhood testing queue into an empty project.

  help        Print this text.
  --version   Print the version.

Without --project, the project is the one registered for the current
directory. Store location: $LOOKOVER_HOME, else the nearest .lookover/
walking up from the current directory, else ~/.config/lookover.
`;

// A Map, not an object literal: `lookover constructor` would find
// Object.prototype.constructor on a literal and try to run it.
const COMMANDS = new Map<string, (argv: string[]) => number>([
  ['init', runInit],
  ['import', runImport],
  ['add', runAdd],
  ['feedback', runFeedback],
  ['process', runProcess],
  ['open', runOpen],
  ['list', runList],
  ['project', runProject],
  ['skill', runSkill],
  ['serve', runServe],
]);

export async function main(argv: string[]): Promise<number> {
  const command = argv[0];
  const rest = argv.slice(1);

  if (command === '--version' || command === '-v') {
    process.stdout.write(`${version()}\n`);
    return 0;
  }

  if (command === 'help' || command === '--help' || command === '-h') {
    process.stdout.write(USAGE);
    return 0;
  }

  if (command === undefined) {
    process.stderr.write(USAGE);
    return 2;
  }

  const run = COMMANDS.get(command);
  if (run === undefined) {
    process.stderr.write(`lookover: unknown command '${command}'\n\n`);
    process.stderr.write(USAGE);
    return 2;
  }

  try {
    return run(rest);
  } catch (error) {
    // Everything the user can get wrong is one line on stderr and exit 1;
    // exit 2 is reserved for "that is not a command".
    process.stderr.write(`lookover: ${describe(error)}\n`);
    return 1;
  }
}

function describe(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function version(): string {
  const pkg = readFileSync(new URL('../package.json', import.meta.url), 'utf8');
  return (JSON.parse(pkg) as { version: string }).version;
}

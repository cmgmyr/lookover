import { parseArgs } from 'node:util';

import { installSkill, installTarget, skillSourceDir, type SkillInstallTarget } from '../skill.ts';

export function runSkill(argv: string[]): number {
  const subcommand = argv[0];
  const args = argv.slice(1);
  if (subcommand === 'path') {
    if (args.length > 0) throw new Error('skill path takes no options');
    process.stdout.write(`${skillSourceDir()}\n`);
    return 0;
  }
  if (subcommand !== 'install') {
    throw new Error('skill needs install or path');
  }

  const { values } = parseArgs({
    args,
    strict: true,
    options: {
      to: { type: 'string', default: 'agents' },
      force: { type: 'boolean' },
    },
  });
  const to = values.to;
  if (to !== 'agents' && to !== 'claude' && to !== 'project') {
    throw new Error('--to must be agents, claude, or project');
  }

  const target = installTarget(to as SkillInstallTarget);
  const result = installSkill({ to: to as SkillInstallTarget, force: values.force });
  process.stdout.write(`${result === 'already' ? 'already installed' : 'installed'} ${target}\n`);
  return 0;
}

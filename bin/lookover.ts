#!/usr/bin/env node

// The default 'warning' listener has to go before src/cli.ts loads, so the
// import of node:sqlite below is dynamic: a static one would run first.
process.removeAllListeners('warning');
process.on('warning', (warning) => {
  if (warning.name === 'ExperimentalWarning') return;
  process.stderr.write(`${warning.stack ?? `${warning.name}: ${warning.message}`}\n`);
});
process.stdout.on('error', (error) => {
  if ((error as NodeJS.ErrnoException).code === 'EPIPE') {
    process.exit(0);
  }
  throw error;
});

const { main } = await import('../src/cli.ts');

process.exitCode = await main(process.argv.slice(2));

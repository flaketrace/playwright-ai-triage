#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { runEval } from './cli/eval.js';
import { runLabel } from './cli/label.js';

const USAGE = `Usage:
  playwright-ai-triage eval [--draws=N] [--json]
  playwright-ai-triage label --run <path-to-sink-envelope.json>`;

export async function dispatch(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (command === 'eval') return runEval(rest);
  if (command === 'label') return runLabel(rest);
  console.error(`Unknown command: ${command ?? '(none)'}\n\n${USAGE}`);
  return 2;
}

// Only run when this file is the process entrypoint — importing it (as the
// tests do, to exercise `dispatch` directly) must not also start the CLI.
// npm installs `bin` entries as symlinks: Node's ESM loader resolves
// import.meta.url to the REAL (post-symlink) path, but process.argv[1] is
// the path Node was invoked with (the symlink path) — so a plain string
// comparison never matches when the CLI is run via its installed bin.
// realpathSync resolves the symlink before comparing.
const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(realpathSync(entry)).href) {
  dispatch(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    },
  );
}

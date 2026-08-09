#!/usr/bin/env node
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
if (import.meta.url === `file://${process.argv[1]}`) {
  dispatch(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    },
  );
}

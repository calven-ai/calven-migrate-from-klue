#!/usr/bin/env node
import { main } from '../src/cli.mjs';

main().catch((err) => {
  process.stderr.write(`\nError: ${err.message}\n`);
  process.exitCode = 1;
});

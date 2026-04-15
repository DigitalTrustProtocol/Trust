#!/usr/bin/env node
import 'dotenv/config';
import { program } from './cli.js';

async function main(): Promise<void> {
  await program.parseAsync(process.argv);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

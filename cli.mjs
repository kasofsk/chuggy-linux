#!/usr/bin/env node
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

import { cliMain } from "./commands.mjs";

// An exit rather than an exit code: a run that failed can leave placements in
// flight, which would otherwise hold the process open until they finish.
process.exit(
  await cliMain(process.argv.slice(2), {
    environment: process.env,
    home: homedir(),
    uid: process.getuid?.() ?? -1,
    node: process.execPath,
    cli: fileURLToPath(import.meta.url),
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
  }),
);

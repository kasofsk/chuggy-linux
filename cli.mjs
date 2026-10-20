#!/usr/bin/env node
/**
 * The entry. On a Node below the floor it says so and exits 2, could not run,
 * having imported nothing that Node may not parse, so this file keeps to the
 * syntax `nodeFloor.mjs` keeps to. On any other, it holds nothing but the call.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";

import { nodeRefusal } from "./nodeFloor.mjs";

const manifest = JSON.parse(
  readFileSync(new URL("package.json", import.meta.url), "utf8"),
);
const version = manifest.version;

async function cliRun() {
  const [os, commands, systemd] = await Promise.all([
    import("node:os"),
    import("./commands.mjs"),
    import("./systemd.mjs"),
  ]);
  return commands.cliMain(process.argv.slice(2), {
    environment: process.env,
    home: os.homedir(),
    uid: typeof process.getuid === "function" ? process.getuid() : -1,
    hostname: os.hostname(),
    arch: process.arch,
    fetch: globalThis.fetch,
    packageName: manifest.name,
    version,
    node: process.execPath,
    nodeVersion: process.versions.node,
    cli: fileURLToPath(import.meta.url),
    systemd: systemd.systemdCalled,
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
  });
}

const refusal = nodeRefusal(version, process.versions.node, process.execPath);
if (refusal === undefined)
  // An exit rather than an exit code: a run that failed can leave placements
  // in flight, which would otherwise hold the process open until they finish.
  cliRun().then((status) => process.exit(status));
else {
  process.stderr.write(`${refusal}\n`);
  process.exitCode = 2;
}

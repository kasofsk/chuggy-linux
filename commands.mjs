/**
 * The `chuggy-linux` commands. Each answers an exit status: 0 done, 1 failed,
 * 2 asked wrongly, and `deniedExitStatus` when the plane denied the pool,
 * which is the one failure the service unit does not restart after.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";

import { poolCredentials } from "@chuggy/worker-core/poolCredentials.mjs";
import { workerPoolClientPass } from "@chuggy/worker-core/poolLoop.mjs";

import { controlAsked, controlServer, controlSocketPath } from "./control.mjs";
import { doctorFindings, findingLine } from "./doctor.mjs";
import {
  jobNetwork,
  passLine,
  runnerDirectories,
  runnerEngine,
  runnerLoop,
  runnerParts,
  runnerPlane,
  runnerSetup,
  runnerTokens,
  runtimeDirectory,
  scratchRemovedOnSignal,
} from "./runner.mjs";
import { runnerPaths } from "./runnerConfig.mjs";
import {
  deniedExitStatus,
  serviceCommands,
  serviceUnit,
} from "./systemdUnit.mjs";

/**
 * @typedef {object} CliHost
 * @property {Readonly<Record<string, string | undefined>>} environment
 * @property {string} home
 * @property {number} uid
 * @property {string} node the Node binary running this
 * @property {string} cli this CLI's entry, as an absolute path
 * @property {(line: string) => void} out
 * @property {(line: string) => void} err
 *
 * @typedef {{host: CliHost, poolFile: string, positionals: string[]}} CliCall
 */

/** The variable naming the pool file when `--pool` does not. */
export const poolFileVariable = "CHUGGY_LINUX_POOL";

const usage = `usage: chuggy-linux <command> [--pool <file>]

  run                     run the pool until the plane denies it
  once                    one pass, then wait for what it placed to start
  status                  this pool's containers, and what the service is placing
  stop <assignment>       stop one assignment's container
  doctor                  check everything a run needs
  install-service         write the systemd user unit that runs \`run\`

The pool file is --pool, or ${poolFileVariable}.`;

/** @param {CliCall} call */
async function started(call) {
  const setup = await runnerSetup(
    call.poolFile,
    call.host.environment,
    call.host.home,
  );
  const runner = await runnerParts(setup, {
    uid: call.host.uid,
    log: call.host.out,
  });
  return {
    setup,
    runner,
    socket: controlSocketPath(runtimeDirectory(setup.paths)),
  };
}

/** @param {CliCall} call */
async function run(call) {
  const { setup, runner, socket } = await started(call);
  await runnerDirectories(setup.paths);
  scratchRemovedOnSignal(runtimeDirectory(setup.paths));
  if ((await jobNetwork(runner.engine, setup.config.network)) === "Created")
    call.host.out(`made the job network ${setup.config.network}`);
  const server = await controlServer(socket, runner.backend);
  try {
    return await runnerLoop(runner.client, {
      sleep: (ms) => delay(ms),
      log: call.host.out,
    });
  } finally {
    server.close();
  }
}

/** @param {CliCall} call */
async function once(call) {
  const { setup, runner, socket } = await started(call);
  if ((await controlAsked(socket, { op: "status" })) !== undefined) {
    call.host.err(
      "a chuggy-linux service is running this pool; stop it before a pass of your own",
    );
    return 1;
  }
  await runnerDirectories(setup.paths);
  scratchRemovedOnSignal(runtimeDirectory(setup.paths));
  await jobNetwork(runner.engine, setup.config.network);
  const pass = await workerPoolClientPass(runner.client);
  await runner.backend.settled();
  if (pass.passed === "Reconciled") {
    call.host.out(passLine(pass));
    return 0;
  }
  call.host.err(`${pass.passed}: ${pass.evidence}`);
  return pass.passed === "Denied" ? deniedExitStatus : 1;
}

/** @param {CliCall} call */
async function status(call) {
  const { runner, socket } = await started(call);
  const containers = await runner.backend.containers();
  const answered =
    /** @type {{inFlight?: import("./containerBackend.mjs").InFlightPlacement[]} | undefined} */ (
      await controlAsked(socket, { op: "status" })
    );
  call.host.out(
    answered === undefined ? "service: not running" : "service: running",
  );
  for (const placement of answered?.inFlight ?? [])
    call.host.out(
      `${placement.name}  ${placement.phase.toLowerCase()}  ${placement.image}  ${placement.assignment}`,
    );
  for (const container of containers)
    call.host.out(
      `${container.name}  ${container.status}  deadline ${container.deadlineEpochSecs === undefined ? "none" : new Date(container.deadlineEpochSecs * 1000).toISOString()}  ${container.assignment ?? "no assignment"}`,
    );
  return 0;
}

/** @param {CliCall} call */
async function stop(call) {
  const [assignment] = call.positionals;
  if (assignment === undefined || call.positionals.length !== 1) {
    call.host.err(usage);
    return 2;
  }
  const { runner, socket } = await started(call);
  const answered =
    /** @type {{stopped?: string, evidence?: string, refused?: string} | undefined} */ (
      (await controlAsked(socket, { op: "stop", assignment })) ??
        (await runner.backend.stop(assignment))
    );
  if (answered.stopped === "Stopped") {
    call.host.out(`stopped ${assignment}`);
    return 0;
  }
  call.host.err(answered.evidence ?? answered.refused ?? "not stopped");
  return 1;
}

/** @param {CliCall} call */
async function doctor(call) {
  const findings = await doctorFindings({
    poolFile: call.poolFile,
    paths: runnerPaths(call.host.environment, call.host.home),
    uid: call.host.uid,
    parts: { engine: runnerEngine, tokens: runnerTokens, plane: runnerPlane },
  });
  for (const finding of findings)
    (finding.passed && finding.warning !== true
      ? call.host.out
      : call.host.err)(findingLine(finding));
  return findings.every((finding) => finding.passed) ? 0 : 1;
}

/** @param {CliCall} call */
async function installService(call) {
  await poolCredentials(call.poolFile);
  const { unit } = runnerPaths(call.host.environment, call.host.home);
  await mkdir(dirname(unit), { recursive: true });
  await writeFile(
    unit,
    serviceUnit({
      node: call.host.node,
      cli: call.host.cli,
      poolFile: call.poolFile,
    }),
  );
  call.host.out(`wrote ${unit}; start it with:`);
  for (const command of serviceCommands) call.host.out(`  ${command}`);
  return 0;
}

const commands = {
  run,
  once,
  status,
  stop,
  doctor,
  "install-service": installService,
};

/**
 * @param {readonly string[]} argv the arguments after the entry
 * @param {CliHost} host
 * @returns {Promise<number>} the exit status
 */
export async function cliMain(argv, host) {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      options: {
        pool: { type: "string" },
        help: { type: "boolean", short: "h" },
      },
      allowPositionals: true,
    });
  } catch (failure) {
    host.err(`${/** @type {Error} */ (failure).message}\n${usage}`);
    return 2;
  }
  const [name, ...positionals] = parsed.positionals;
  if (parsed.values.help === true || name === "help") {
    host.out(usage);
    return 0;
  }
  const command = Object.hasOwn(commands, name ?? "")
    ? commands[name]
    : undefined;
  if (command === undefined) {
    host.err(usage);
    return 2;
  }
  const poolFile = parsed.values.pool ?? host.environment[poolFileVariable];
  if (poolFile === undefined || poolFile === "") {
    host.err(
      `no pool file: name one with --pool or ${poolFileVariable}\n${usage}`,
    );
    return 2;
  }
  if (name !== "stop" && positionals.length > 0) {
    host.err(usage);
    return 2;
  }
  try {
    return await command({ host, poolFile: resolve(poolFile), positionals });
  } catch (failure) {
    host.err(failure instanceof Error ? failure.message : String(failure));
    return 1;
  }
}

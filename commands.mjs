/**
 * The `chuggy-linux` commands. Each answers an exit status: 0 done, 1 failed,
 * 2 asked wrongly, and `deniedExitStatus` when the plane denied the pool,
 * which is the one failure the service unit does not restart after.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";

import { poolCredentials } from "@chuggy/worker-core/poolCredentials.mjs";
import { workerPoolClientPass } from "@chuggy/worker-core/poolLoop.mjs";

import { controlAsked, controlServer } from "./control.mjs";
import { doctorFindings, findingLine } from "./doctor.mjs";
import {
  legacyService,
  poolFileServiceUnits,
  poolServiceAsked,
  poolServiceSockets,
  serviceUnitText,
} from "./poolService.mjs";
import {
  registerPoolDirectory,
  registerPoolFileWritten,
  registerRedeemed,
  registerRequest,
} from "./register.mjs";
import {
  jobNetwork,
  passLine,
  runnerDirectories,
  runnerEngine,
  runnerLeftoversRemoved,
  runnerLoop,
  runnerParts,
  runnerPlane,
  runnerSetup,
  runnerTokens,
  scratchRemovedOnSignal,
} from "./runner.mjs";
import {
  podmanRegistriesConf,
  runnerConfigLimits,
  runnerPaths,
} from "./runnerConfig.mjs";
import {
  deniedExitStatus,
  legacyServiceUnitName,
  serviceCommands,
  serviceUnit,
  serviceUnitName,
  shellQuoted,
  unitPoolFile,
} from "./systemdUnit.mjs";

/**
 * @typedef {object} CliHost
 * @property {Readonly<Record<string, string | undefined>>} environment
 * @property {string} home
 * @property {number} uid
 * @property {string} hostname
 * @property {string} arch as `process.arch` names it
 * @property {typeof globalThis.fetch} fetch
 * @property {import("./engine.mjs").Engine} [engine] a run's engine, when not the one the runner's file names
 * @property {import("@chuggy/worker-core/poolLoop.mjs").WorkerPoolClient["tokens"]} [tokens] a run's token source, when not the pool's issuer
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
       chuggy-linux register --api <origin> --token=<token> [--pool <name>]

  register                redeem a registration token for a pool file, the
                          pool named for this machine unless --pool names it
  run                     run the pool until the plane denies it
  once                    one pass, then wait for what it placed to start
  status                  this pool's limits and containers, and what the
                          service is placing
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
    engine: call.host.engine,
    tokens: call.host.tokens,
  });
  return {
    setup,
    runner,
    sockets: await poolServiceSockets(setup.paths, setup.credentials),
  };
}

/**
 * The service. It claims the pool's control socket before removing what a
 * killed run left, so a second service of the pool is refused before it can
 * remove the first's scratch.
 *
 * @param {CliCall} call
 */
async function run(call) {
  const { setup, runner, sockets } = await started(call);
  if (
    sockets.legacy !== undefined &&
    (await controlAsked(sockets.legacy.socket, { op: "status" })) !== undefined
  )
    throw new Error(
      sockets.legacy.serves === "ThisPool"
        ? `${legacyServiceUnitName} is running this pool; stop it before starting another service of it`
        : `${legacyServiceUnitName} is running a pool file this runner cannot read, which may be this pool's; stop it before starting another service of this pool`,
    );
  await runnerDirectories(setup.paths, runner.runtime);
  const server = await controlServer(sockets.own, runner.backend);
  try {
    await runnerLeftoversRemoved(runner.runtime);
    scratchRemovedOnSignal(runner.runtime);
    if ((await jobNetwork(runner.engine, setup.config.network)) === "Created")
      call.host.out(`made the job network ${setup.config.network}`);
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
  const { setup, runner, sockets } = await started(call);
  if ((await poolServiceAsked(sockets, { op: "status" })) !== undefined) {
    call.host.err(
      "a chuggy-linux service is running this pool; stop it before a pass of your own",
    );
    return 1;
  }
  await runnerDirectories(setup.paths, runner.runtime);
  await runnerLeftoversRemoved(runner.runtime);
  scratchRemovedOnSignal(runner.runtime);
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
  const { setup, runner, sockets } = await started(call);
  const containers = await runner.backend.containers();
  const answered =
    /** @type {{inFlight?: import("./containerBackend.mjs").InFlightPlacement[]} | undefined} */ (
      await poolServiceAsked(sockets, { op: "status" })
    );
  call.host.out(
    answered === undefined ? "service: not running" : "service: running",
  );
  call.host.out(`limits: ${runnerConfigLimits(setup.config)}`);
  for (const placement of answered?.inFlight ?? [])
    call.host.out(
      `${placement.name}  ${placement.kind.toLowerCase()}  ${placement.phase.toLowerCase()}  ${placement.image}  ${placement.assignment}`,
    );
  for (const container of containers)
    call.host.out(
      `${container.name}  ${container.kind.toLowerCase()}  ${container.status}  deadline ${container.deadlineEpochSecs === undefined ? "none" : new Date(container.deadlineEpochSecs * 1000).toISOString()}  ${container.assignment ?? "no assignment"}`,
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
  const { runner, sockets } = await started(call);
  const answered =
    /** @type {{stopped?: string, evidence?: string, refused?: string} | undefined} */ (
      (await poolServiceAsked(sockets, { op: "stop", assignment })) ??
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
    registriesConf: podmanRegistriesConf(
      call.host.environment,
      call.host.home,
      call.host.uid,
    ),
    parts: { engine: runnerEngine, tokens: runnerTokens, plane: runnerPlane },
  });
  for (const finding of findings)
    (finding.passed && finding.warning !== true
      ? call.host.out
      : call.host.err)(findingLine(finding));
  return findings.every((finding) => finding.passed) ? 0 : 1;
}

/**
 * Writes the pool file's own unit, refusing one of its name that serves
 * another file. Where the legacy unit serves this pool, the operator is told
 * to retire it before starting this one; one serving another pool is left to
 * run beside it.
 *
 * @param {CliCall} call
 */
async function installService(call) {
  const credentials = await poolCredentials(call.poolFile);
  const paths = runnerPaths(call.host.environment, call.host.home);
  const name = serviceUnitName(call.poolFile);
  const unit = join(paths.units, name);
  const existing = await serviceUnitText(unit);
  const served = existing === undefined ? undefined : unitPoolFile(existing);
  if (existing !== undefined && served !== call.poolFile)
    throw new Error(
      `${unit} serves ${served ?? "no pool file this runner named"}, not ${call.poolFile}; remove that unit if it is stale, or rename the pool file`,
    );
  await mkdir(paths.units, { recursive: true });
  await writeFile(
    unit,
    serviceUnit({
      node: call.host.node,
      cli: call.host.cli,
      poolFile: call.poolFile,
    }),
  );
  const legacyFound = await legacyService(paths, credentials);
  const legacy =
    legacyFound?.serves === "ThisPool" ? legacyFound.unit : undefined;
  call.host.out(
    legacy === undefined
      ? `wrote ${unit}; start it with:`
      : `wrote ${unit}; ${legacyServiceUnitName} serves this pool already, so retire it and start this one with:`,
  );
  for (const command of serviceCommands(name, legacy))
    call.host.out(`  ${command}`);
  return 0;
}

/**
 * Redeems a registration token and writes the pool file it answers. It takes
 * no pool file: its `--pool` is the name the pool takes.
 *
 * @param {CliHost} host
 * @param {import("./register.mjs").RegisterAsked} asked
 */
async function register(host, asked) {
  const requested = registerRequest(asked, host);
  if ("refused" in requested) {
    host.err(requested.refused);
    return 2;
  }
  const paths = runnerPaths(host.environment, host.home);
  const { pools } = paths;
  await registerPoolDirectory(pools);
  const pool = await registerRedeemed(requested.request, host.fetch);
  const { file, replaced } = await registerPoolFileWritten(pools, pool).catch(
    (/** @type {unknown} */ failure) => {
      throw new Error(
        `the pool file could not be written, and the token is spent, so mint another: ${failure instanceof Error ? failure.message : String(failure)}`,
        { cause: failure },
      );
    },
  );
  await poolCredentials(file);
  const verb = replaced ? "replaced" : "wrote";
  const units = await poolFileServiceUnits(paths, file);
  host.out(
    units.length === 0
      ? `${verb} ${file}; next:`
      : `${verb} ${file}; chuggy denies the pool's earlier registration, so its service stops until it is restarted:`,
  );
  host.out(`  chuggy-linux doctor --pool ${shellQuoted(file)}`);
  if (units.length === 0)
    host.out(`  chuggy-linux install-service --pool ${shellQuoted(file)}`);
  for (const unit of units)
    host.out(`  systemctl --user restart ${shellQuoted(unit)}`);
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
        api: { type: "string" },
        token: { type: "string" },
        help: { type: "boolean", short: "h" },
      },
      allowPositionals: true,
    });
  } catch (failure) {
    host.err(`${/** @type {Error} */ (failure).message}\n${usage}`);
    return 2;
  }
  const { values } = parsed;
  const [name, ...positionals] = parsed.positionals;
  if (values.help === true || name === "help") {
    host.out(usage);
    return 0;
  }
  const registering = name === "register";
  const command = Object.hasOwn(commands, name ?? "")
    ? commands[name]
    : undefined;
  if (
    (!registering &&
      (command === undefined ||
        values.api !== undefined ||
        values.token !== undefined)) ||
    (name !== "stop" && positionals.length > 0)
  ) {
    host.err(usage);
    return 2;
  }
  const poolFile = values.pool ?? host.environment[poolFileVariable];
  if (!registering && (poolFile === undefined || poolFile === "")) {
    host.err(
      `no pool file: name one with --pool or ${poolFileVariable}\n${usage}`,
    );
    return 2;
  }
  try {
    if (registering) return await register(host, values);
    return await command({
      host,
      poolFile: resolve(/** @type {string} */ (poolFile)),
      positionals,
    });
  } catch (failure) {
    host.err(failure instanceof Error ? failure.message : String(failure));
    return 1;
  }
}

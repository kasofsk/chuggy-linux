/**
 * The `chuggy-linux` commands. Each answers an exit status: 0 done, 1 failed,
 * 2 asked wrongly, `deniedExitStatus` when the plane denied the pool, which is
 * the one failure the service unit does not restart after, and
 * `updatedExitStatus` when `run` installed a release of itself to run again on.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";

import { poolCredentials } from "@chuggy/worker-core/poolCredentials.mjs";
import { poolIdentityPersonal } from "@chuggy/worker-core/poolIdentity.mjs";
import { workerPoolClientPass } from "@chuggy/worker-core/poolLoop.mjs";
import {
  poolRunnerPassLine,
  poolRunnerPlane,
  poolRunnerTokens,
} from "@chuggy/worker-core/poolRunner.mjs";

import { controlAsked, controlServer } from "@chuggy/worker-core/control.mjs";
import { localToolAskRefusal } from "@chuggy/worker-core/localTools.mjs";
import { diskFloorSaid, diskFreePorts } from "./diskFree.mjs";
import { claudeVersionAsked, doctorFindings, findingLine } from "./doctor.mjs";
import { mcpServed } from "./mcp.mjs";
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
} from "@chuggy/worker-core/register.mjs";
import {
  jobNetwork,
  runnerDirectories,
  runnerEngine,
  runnerLeftoversRemoved,
  runnerLoop,
  runnerParts,
  runnerSetup,
  runnerUpdates,
  scratchRemovedOnSignal,
} from "./runner.mjs";
import {
  podmanRegistriesConf,
  runnerConfigLimits,
  runnerPaths,
} from "./runnerConfig.mjs";
import {
  commandLine,
  deniedExitStatus,
  legacyServiceUnitName,
  serviceCommands,
  serviceLingerArgv,
  serviceEnableArgv,
  serviceReloadArgv,
  serviceRestartArgv,
  serviceStartArgvs,
  serviceUnit,
  serviceUnitBaseCharsMax,
  serviceUnitName,
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
 * @property {import("@chuggy/worker-core/engine.mjs").Engine} [engine] the engine a run and doctor reach, when not the one the runner's file names
 * @property {import("@chuggy/worker-core/poolLoop.mjs").WorkerPoolClient["tokens"]} [tokens] the token source a run and doctor reach, when not the pool's issuer
 * @property {import("@chuggy/worker-core/poolLoop.mjs").WorkerPoolClient["plane"]} [plane] the plane doctor polls, when not the pool's
 * @property {import("./diskFree.mjs").DiskFreePorts} [disk] what a run, doctor and status measure the engine's free disk by, when not this machine's own
 * @property {import("./systemd.mjs").Systemd} systemd how `systemctl` and `loginctl` are run
 * @property {string} packageName this copy's package, as its `package.json` names it
 * @property {string} version this copy's, as its `package.json` names it
 * @property {string} node the Node binary running this
 * @property {string} nodeVersion that Node's, as `process.versions.node` says it
 * @property {string} cli this CLI's entry, as an absolute path
 * @property {(line: string) => void} out
 * @property {(line: string) => void} err
 *
 * @typedef {{host: CliHost, poolFile: string, positionals: string[]}} CliCall
 */

/** The variable naming the pool file when `--pool` does not. */
export const poolFileVariable = "CHUGGY_LINUX_POOL";

const usage = `usage: chuggy-linux <command> [--pool <file>]
       chuggy-linux register --api <origin> --token=<token> [--pool <name> | --personal]
                             [--host] [--capability <token>]...
       chuggy-linux mcp --site <origin> --workspace <workspace> --project <project>
       chuggy-linux --version

  register                redeem a registration token for a pool file, the
                          pool named for this machine unless --pool names it,
                          or with --personal a member's personal token for
                          their personal runner's file, and start its service
                          where it can; it declares this machine's platform
                          and each --capability, which the token must permit,
                          and with --host runs a job that pins no image on
                          this machine itself
  run                     run the pool until the plane denies it
  once                    one pass, then wait for what it placed to start
  status                  this pool's limits and containers, and what the
                          service is placing
  stop <assignment>       stop one assignment's container
  doctor                  check everything a run needs
  install-service         write the systemd user unit that runs \`run\`
  mcp                     serve chuggy's tools for one project to a coding
                          agent on stdio, under your own sign-in

The pool file is --pool, or ${poolFileVariable}.`;

/**
 * The copy of this runner that is speaking.
 *
 * @param {CliHost} host
 * @returns {import("./runner.mjs").RunnerCopy}
 */
function runnerCopy(host) {
  return { package: host.packageName, version: host.version, cli: host.cli };
}

/**
 * @param {CliCall} call
 * @param {{places: boolean}} run whether the command places work, which alone needs the engine's socket
 */
async function started(call, run = { places: true }) {
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
    places: run.places,
    runner: { package: call.host.packageName, version: call.host.version },
    disk: call.host.disk,
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
 * remove the first's scratch. systemd names the run it started with
 * `INVOCATION_ID`.
 *
 * @param {CliCall} call
 */
async function run(call) {
  const { setup, runner, sockets } = await started(call);
  const updates = runnerUpdates(setup, runnerCopy(call.host));
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
      updates,
      underService: call.host.environment.INVOCATION_ID !== undefined,
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
    call.host.out(poolRunnerPassLine(pass));
    return 0;
  }
  call.host.err(`${pass.passed}: ${pass.evidence}`);
  return pass.passed === "Denied" ? deniedExitStatus : 1;
}

/**
 * The kind a status line names. A service from before sessions answers its
 * placements with none, and everything it placed is a job.
 *
 * @param {{kind?: string}} workload
 */
function statusKind(workload) {
  return workload.kind === "Session" ? "session" : "job";
}

/** @param {CliCall} call */
async function status(call) {
  const { setup, runner, sockets } = await started(call, { places: false });
  const containers = await runner.backend.containers();
  const answered =
    /** @type {{inFlight?: import("@chuggy/worker-core/containerBackend.mjs").InFlightPlacement[]} | undefined} */ (
      await poolServiceAsked(sockets, { op: "status" })
    );
  call.host.out(
    answered === undefined ? "service: not running" : "service: running",
  );
  call.host.out(`limits: ${runnerConfigLimits(setup.config, setup.poolFile)}`);
  const disk = await diskFloorSaid(setup.config, runner.engine, runner.disk);
  call.host.out(`disk floor: ${disk.detail}`);
  for (const placement of answered?.inFlight ?? [])
    call.host.out(
      `${placement.name}  ${statusKind(placement)}  ${placement.phase.toLowerCase()}  ${placement.image}  ${placement.assignment}`,
    );
  for (const container of containers)
    call.host.out(
      `${container.name}  ${statusKind(container)}  ${container.status}  deadline ${container.deadlineEpochSecs === undefined ? "none" : new Date(container.deadlineEpochSecs * 1000).toISOString()}  ${container.assignment ?? "no assignment"}`,
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
  const { runner, sockets } = await started(call, { places: false });
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

/** @param {unknown} failure */
function failureMessage(failure) {
  return failure instanceof Error ? failure.message : String(failure);
}

/**
 * The PATH a pool file's service is started with: the one its unit's own
 * drop-ins set, or else the user's service manager's, or nothing where
 * neither can be read.
 *
 * @param {CliHost} host
 * @param {string} poolFile
 * @returns {Promise<string | undefined>}
 */
async function servicePath(host, poolFile) {
  let name;
  try {
    name = serviceUnitName(poolFile);
  } catch {
    return undefined;
  }
  const unit = await host.systemd([
    "systemctl",
    "--user",
    "show",
    name,
    "--property",
    "Environment",
    "--value",
  ]);
  const own =
    unit.code === 0 ? /(?:^|\s)PATH=(\S+)/u.exec(unit.stdout)?.[1] : undefined;
  if (own !== undefined) return own;
  const manager = await host.systemd([
    "systemctl",
    "--user",
    "show-environment",
  ]);
  if (manager.code !== 0) return undefined;
  return /^PATH=(.*)$/mu.exec(manager.stdout)?.[1];
}

/**
 * doctor's findings for a pool file, reaching the engine, issuer and plane
 * the host names, or else those the files do.
 *
 * @param {CliHost} host
 * @param {string} poolFile
 */
function doctorFound(host, poolFile) {
  const paths = runnerPaths(host.environment, host.home);
  return doctorFindings({
    poolFile,
    paths,
    uid: host.uid,
    registriesConf: podmanRegistriesConf(host.environment, host.home, host.uid),
    node: host.node,
    cli: host.cli,
    path: host.environment.PATH,
    servicePath: () => servicePath(host, poolFile),
    claudeVersion: claudeVersionAsked,
    disk: host.disk ?? diskFreePorts,
    parts: {
      engine: (config) => host.engine ?? runnerEngine(config),
      tokens: (credentials) => host.tokens ?? poolRunnerTokens(credentials),
      plane: (credentials) =>
        host.plane ??
        poolRunnerPlane(credentials, {
          package: host.packageName,
          version: host.version,
        }),
      updates: (config) => runnerUpdates({ config, paths }, runnerCopy(host)),
    },
  });
}

/**
 * Whether a finding is one to read: a failure, or a pass with a warning.
 *
 * @param {import("./doctor.mjs").DoctorFinding} finding
 */
function doctorAside(finding) {
  return !finding.passed || finding.warning === true;
}

/**
 * Which copy is speaking, under which Node, and then each check.
 *
 * @param {CliCall} call
 */
async function doctor(call) {
  const { host } = call;
  host.out(
    `chuggy-linux ${host.version} at ${host.cli}, under Node ${host.nodeVersion} at ${host.node}`,
  );
  const findings = await doctorFound(host, call.poolFile);
  for (const finding of findings)
    (doctorAside(finding) ? host.err : host.out)(findingLine(finding));
  return findings.every((finding) => finding.passed) ? 0 : 1;
}

/**
 * Writes the pool file's own unit, refusing one of its name that serves
 * another file, and answers the unit's file and name, and the legacy unit's
 * file where that unit serves this pool.
 *
 * @param {CliHost} host
 * @param {string} poolFile
 */
async function installServiceUnit(host, poolFile) {
  const credentials = await poolCredentials(poolFile);
  const paths = runnerPaths(host.environment, host.home);
  const name = serviceUnitName(poolFile);
  const unit = join(paths.units, name);
  const existing = await serviceUnitText(unit);
  const served = existing === undefined ? undefined : unitPoolFile(existing);
  if (existing !== undefined && served !== poolFile)
    throw new Error(
      `${unit} serves ${served ?? "no pool file this runner named"}, not ${poolFile}; remove that unit if it is stale, or rename the pool file`,
    );
  await mkdir(paths.units, { recursive: true });
  await writeFile(
    unit,
    serviceUnit({ node: host.node, cli: host.cli, poolFile }),
  );
  const legacyFound = await legacyService(paths, credentials);
  const legacy =
    legacyFound?.serves === "ThisPool" ? legacyFound.unit : undefined;
  return { unit, name, legacy };
}

/**
 * Writes the pool file's own unit and prints how to start it. Where the
 * legacy unit serves this pool, the operator is told to retire it before
 * starting this one; one serving another pool is left to run beside it.
 *
 * @param {CliCall} call
 */
async function installService(call) {
  const { unit, name, legacy } = await installServiceUnit(
    call.host,
    call.poolFile,
  );
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
 * @typedef {object} RegisterServed what became of the written file's service
 * @property {string} said what the first line says of the service
 * @property {readonly string[]} why what failed, and what a check warned of
 * @property {string} [then] what the commands left are for, where `said` does not say
 * @property {readonly string[]} left the commands left to the operator, from the first not done
 */

/**
 * @param {string} since
 * @param {readonly string[]} why
 * @param {readonly string[]} left
 * @returns {RegisterServed}
 */
function registerUnserved(since, why, left) {
  return {
    said: `its service is not running, since ${since}; next:`,
    why,
    left,
  };
}

/**
 * What is left of a file's service from doctor's checks on: the checks, then
 * the unit install-service writes, which prints what starts it.
 *
 * @param {string} file
 */
function registerUnchecked(file) {
  return ["doctor", "install-service"].map((command) =>
    commandLine(["chuggy-linux", command, "--pool", file]),
  );
}

/**
 * A failed command and the first line it printed on stderr, or its exit
 * status where it printed none.
 *
 * @param {readonly string[]} argv
 * @param {import("./systemd.mjs").SystemdAnswer} answer
 */
function registerFailureLine(argv, answer) {
  const [said] = answer.stderr.trim().split("\n");
  return `${commandLine(argv)}: ${said === "" ? `exited ${String(answer.code)}` : said}`;
}

/**
 * Turns lingering on where it is not on, with no leave to ask anyone for a
 * password, and answers why it is not on where it could not be.
 *
 * @param {CliHost} host
 * @returns {Promise<string | undefined>}
 */
async function registerLingered(host) {
  const user = String(host.uid);
  const read = await host.systemd([
    "loginctl",
    "show-user",
    user,
    "--property",
    "Linger",
  ]);
  if (read.code === 0 && /^Linger=yes$/mu.test(read.stdout)) return undefined;
  const argv = ["loginctl", "--no-ask-password", "enable-linger", user];
  const answer = await host.systemd(argv);
  return answer.code === 0 ? undefined : registerFailureLine(argv, answer);
}

/**
 * Runs each command in turn, then turns lingering on. Where a command fails,
 * the service is not running, and what is left is that command on.
 *
 * @param {CliHost} host
 * @param {readonly (readonly string[])[]} argvs
 * @param {string} said what the first line says once every command ran
 * @param {(argv: readonly string[]) => string} since why the service is not running where `argv` failed
 * @param {readonly string[]} why what a check warned of
 * @returns {Promise<RegisterServed>}
 */
async function registerRan(host, argvs, said, since, why) {
  for (const [index, argv] of argvs.entries()) {
    const answer = await host.systemd(argv);
    if (answer.code !== 0)
      return registerUnserved(
        since(argv),
        [...why, registerFailureLine(argv, answer)],
        [...argvs.slice(index), serviceLingerArgv].map(commandLine),
      );
  }
  const lingered = await registerLingered(host);
  if (lingered === undefined) return { said, why, left: [] };
  return {
    said,
    why: [...why, lingered],
    then: "it runs only while you are logged in, until you run:",
    left: [commandLine(serviceLingerArgv)],
  };
}

/**
 * Restarts each unit serving the file, which still runs the registration it
 * read when it started. The file's own unit is written first as install-service writes
 * it, so what comes back is this copy under this Node, and then the units are
 * read again and each enabled: a unit may have been written and never
 * enabled. Where the write fails nothing is restarted, and what is left
 * begins with install-service.
 *
 * @param {CliHost} host
 * @param {string} file
 * @param {boolean} denied where chuggy denies the registration the units run,
 *   as it does a pool's and not a personal runner's
 * @param {readonly string[]} units
 * @returns {Promise<RegisterServed>}
 */
async function registerRestarted(host, file, denied, units) {
  const argvs = [
    serviceReloadArgv,
    ...units.map(serviceEnableArgv),
    ...units.map(serviceRestartArgv),
  ];
  /** @param {string} what */
  const since = (what) =>
    denied ? `chuggy denies the pool's earlier registration and ${what}` : what;
  try {
    await installServiceUnit(host, file);
  } catch (failure) {
    return registerUnserved(
      since("its unit could not be written"),
      [failureMessage(failure)],
      [
        ...registerUnchecked(file).slice(1),
        ...[...argvs, serviceLingerArgv].map(commandLine),
      ],
    );
  }
  return registerRan(
    host,
    argvs,
    `its service is running: restarted ${units.join(", ")}`,
    (argv) => since(`${commandLine(argv)} failed`),
    [],
  );
}

/**
 * Starts the service of a file its own unit here does not serve: doctor's
 * checks, then its unit as install-service writes it, then the user's service
 * manager asked to start it, and lingering on. Where the legacy unit serves
 * this pool, nothing is started, and what install-service prints is what is
 * left.
 *
 * @param {CliHost} host
 * @param {string} file
 * @param {string} written what register says it did with the file
 * @returns {Promise<RegisterServed>}
 */
async function registerStarted(host, file, written) {
  host.err(
    `${written}, and the token is spent; checking this machine before starting its service`,
  );
  const findings = await doctorFound(host, file);
  const why = findings.filter(doctorAside).map(findingLine);
  if (!findings.every((finding) => finding.passed))
    return registerUnserved("a check failed", why, registerUnchecked(file));
  let installed;
  try {
    installed = await installServiceUnit(host, file);
  } catch (failure) {
    return registerUnserved(
      "its unit could not be written",
      [...why, failureMessage(failure)],
      registerUnchecked(file).slice(1),
    );
  }
  const { name, legacy } = installed;
  if (legacy !== undefined)
    return registerUnserved(
      `${legacyServiceUnitName} serves this pool already`,
      why,
      serviceCommands(name, legacy),
    );
  return registerRan(
    host,
    serviceStartArgvs(name),
    `its service is running: started ${name}`,
    (argv) => `${commandLine(argv)} failed`,
    why,
  );
}

/**
 * The written file's service: its unit written again and restarted where the
 * file's own unit here already serves it, since that unit still runs the
 * registration it read, and started otherwise. Where the legacy unit serves
 * this pool, nothing is started, as the start path answers. What fails is
 * said rather than thrown, since the token is spent.
 *
 * @param {CliHost} host
 * @param {import("@chuggy/worker-core/register.mjs").RegisteredPool} pool
 * @param {string} file
 * @param {string} written what register says it did with the file
 * @returns {Promise<RegisterServed>}
 */
async function registerServed(host, pool, file, written) {
  try {
    const credentials = await poolCredentials(file);
    const paths = runnerPaths(host.environment, host.home);
    const name = serviceUnitName(file);
    const units = await poolFileServiceUnits(paths, file);
    if (!units.includes(name))
      return await registerStarted(host, file, written);
    const legacy = await legacyService(paths, credentials);
    if (legacy?.serves === "ThisPool")
      return registerUnserved(
        `${legacyServiceUnitName} serves this pool already`,
        [],
        serviceCommands(name, legacy.unit),
      );
    return await registerRestarted(
      host,
      file,
      !poolIdentityPersonal(pool),
      units,
    );
  } catch (failure) {
    return registerUnserved(
      "it could not be started",
      [failureMessage(failure)],
      registerUnchecked(file),
    );
  }
}

/**
 * Redeems a registration token, writes the pool file it answers, and leaves
 * the file's service running where it can. It takes no pool file: its
 * `--pool` is the name the pool takes, and `--personal` redeems a member's
 * personal token, which names no pool. Once the file is written it exits 0
 * whatever became of the service, since a rerun would spend another token.
 *
 * @param {CliHost} host
 * @param {Omit<import("@chuggy/worker-core/register.mjs").RegisterAsked, "capabilities"> & {capability?: string[] | undefined}} asked each `--capability` once per token
 */
async function register(host, { capability, ...asked }) {
  const requested = registerRequest(
    { ...asked, capabilities: capability },
    host,
  );
  if ("refused" in requested) {
    host.err(requested.refused);
    return 2;
  }
  const { pools } = runnerPaths(host.environment, host.home);
  await registerPoolDirectory(pools);
  const pool = await registerRedeemed(requested.request, host.fetch);
  const { file, replaced } = await registerPoolFileWritten(
    pools,
    pool,
    serviceUnitBaseCharsMax,
  ).catch((/** @type {unknown} */ failure) => {
    throw new Error(
      `the pool file could not be written, and the token is spent, so mint another: ${failureMessage(failure)}`,
      { cause: failure },
    );
  });
  const written = `${replaced ? "replaced" : "wrote"} ${file}`;
  const served = await registerServed(host, pool, file, written);
  host.out(`${written}; ${served.said}`);
  for (const line of served.why) host.err(line);
  if (served.then !== undefined) host.out(served.then);
  for (const command of served.left) host.out(`  ${command}`);
  return 0;
}

/** The options only `mcp` takes. */
const mcpOptions = ["site", "workspace", "project"];

/**
 * Serves the tools for one project. It takes no pool file, and every other
 * command's options are asked wrongly here.
 *
 * @param {CliHost} host
 * @param {Record<string, unknown>} values
 * @param {readonly string[]} positionals
 */
async function mcp(host, values, positionals) {
  const { site, workspace, project, ...others } = values;
  const asked =
    /** @type {{site?: string, workspace?: string, project?: string}} */ ({
      site,
      workspace,
      project,
    });
  if (positionals.length > 0 || Object.keys(others).length > 0) {
    host.err(usage);
    return 2;
  }
  const refused = localToolAskRefusal(asked);
  if (refused !== undefined) {
    host.err(`${refused}\n${usage}`);
    return 2;
  }
  try {
    return await mcpServed(
      host,
      runnerPaths(host.environment, host.home).signIns,
      /** @type {{site: string, workspace: string, project: string}} */ (asked),
    );
  } catch (failure) {
    host.err(failureMessage(failure));
    return 1;
  }
}

const commands = {
  run,
  once,
  status,
  stop,
  doctor,
  "install-service": installService,
};

/** Every option a command takes; each command refuses the ones it does not. */
const cliOptions = {
  pool: { type: "string" },
  api: { type: "string" },
  token: { type: "string" },
  personal: { type: "boolean" },
  host: { type: "boolean" },
  capability: { type: "string", multiple: true },
  site: { type: "string" },
  workspace: { type: "string" },
  project: { type: "string" },
  help: { type: "boolean", short: "h" },
  version: { type: "boolean" },
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
      options: cliOptions,
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
  if (values.version === true) {
    host.out(`chuggy-linux ${host.version}`);
    return 0;
  }
  if (name === "mcp") return await mcp(host, values, positionals);
  const registering = name === "register";
  const command = Object.hasOwn(commands, name ?? "")
    ? commands[name]
    : undefined;
  if (
    (!registering &&
      (command === undefined ||
        values.api !== undefined ||
        values.token !== undefined ||
        values.personal !== undefined ||
        values.host !== undefined ||
        values.capability !== undefined)) ||
    mcpOptions.some((option) => values[option] !== undefined) ||
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
    host.err(failureMessage(failure));
    return 1;
  }
}

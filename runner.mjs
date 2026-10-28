/**
 * The runner composed: the pool's credentials and the runner's file read, and
 * the container backend beside the worker core's pool runner, which passes
 * until the plane denies the pool or the runner has installed a release of
 * itself, from this package's own release downloads. Where the pool was
 * registered with `--host`, a job that pins no image runs on this machine
 * itself, beside the containers. Each poll advertises what the runner finds
 * of this machine and its file when the run starts. Every command starts
 * here.
 *
 * EVERY BACKEND IS TOLD THE KIND OF CLAUDE CREDENTIAL, a subscription's where
 * the runner's file names `claudeTokenFile`. The core withholds what would
 * choose another credential only from a workload told one, so a run that told
 * none would let a variable its jobs inherit outrank the token.
 */

import { readdirSync, rmSync } from "node:fs";
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { availableParallelism, totalmem } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { poolCredentials } from "@chuggy/worker-core/poolCredentials.mjs";
import {
  poolRunnerClient,
  poolRunnerLoop,
  poolRunnerTokens,
} from "@chuggy/worker-core/poolRunner.mjs";
import { runnerUpdater } from "@chuggy/worker-core/runnerUpdate.mjs";

import { containerBackend } from "@chuggy/worker-core/containerBackend.mjs";
import {
  hostBackend,
  hostPlatformsDeclared,
  hostRoutedBackend,
} from "@chuggy/worker-core/hostBackend.mjs";
import { containerEngine } from "@chuggy/worker-core/engine.mjs";
import {
  bindMountNameable,
  dockerContextArgv,
  dockerInfoArgv,
  networkCreateArgv,
  networkInspectArgv,
  podmanRemoteArgv,
  podmanSocketArgv,
  podmanVersionArgv,
} from "@chuggy/worker-core/engineArgv.mjs";
import {
  engineFailure,
  engineFailureLine,
} from "@chuggy/worker-core/engineErrors.mjs";
import { poolIdentityDigest } from "@chuggy/worker-core/poolIdentity.mjs";
import {
  registerAdvertised,
  registerPlatform,
} from "@chuggy/worker-core/register.mjs";
import { runtimeScratch } from "@chuggy/worker-core/runtimeScratch.mjs";

import { diskFloorBytes, diskFreePorts, engineDiskFree } from "./diskFree.mjs";
import { memoryFreeBytes, memoryReservedBytes } from "./memoryFree.mjs";
import {
  credentialFileRefusal,
  runnerCredentialDescribed,
  runnerCredentialsHanded,
  runnerConfig,
  runnerPaths,
  runnerPoolLimits,
} from "./runnerConfig.mjs";
import { deniedExitStatus, updatedExitStatus } from "./systemdUnit.mjs";

/**
 * @typedef {import("@chuggy/worker-core/poolCredentials.mjs").PoolCredentials} PoolCredentials
 * @typedef {import("@chuggy/worker-core/poolLoop.mjs").WorkerPoolClient} WorkerPoolClient
 * @typedef {import("@chuggy/worker-core/poolLoop.mjs").WorkerPoolBackend} WorkerPoolBackend
 * @typedef {import("@chuggy/worker-core/poolLoop.mjs").WorkerPoolUpdates} WorkerPoolUpdates
 * @typedef {import("@chuggy/worker-core/runnerUpdate.mjs").RunnerIdentity} RunnerIdentity
 * @typedef {import("@chuggy/worker-core/runnerUpdate.mjs").RunnerUpdatePorts} RunnerUpdatePorts
 * @typedef {import("@chuggy/worker-core/containerBackend.mjs").ContainerBackend} ContainerBackend
 * @typedef {import("@chuggy/worker-core/engine.mjs").Engine} Engine
 * @typedef {import("@chuggy/worker-core/engineArgv.mjs").EngineSocket} EngineSocket
 * @typedef {import("@chuggy/worker-core/poolIdentity.mjs").PoolIdentity} PoolIdentity
 * @typedef {import("./runnerConfig.mjs").RunnerConfig} RunnerConfig
 * @typedef {import("./runnerConfig.mjs").RunnerPaths} RunnerPaths
 *
 * @typedef {object} RunnerSetup
 * @property {string} poolFile
 * @property {PoolCredentials} credentials
 * @property {RunnerConfig} config
 * @property {RunnerPaths} paths
 *
 * @typedef {object} Runner
 * @property {string} runtime the pool's runtime directory
 * @property {Engine} engine
 * @property {import("./diskFree.mjs").DiskFreePorts} disk what the engine's free disk is measured by
 * @property {ContainerBackend} backend
 * @property {WorkerPoolClient} client
 *
 * @typedef {object} RunnerCopy the copy of this runner that is running
 * @property {string} package its package's name, as its `package.json` names it
 * @property {string} version as its `package.json` names it
 * @property {string} cli its entry, as an absolute path, at the root of the directory it is installed in
 */

/** Where this package's releases are downloaded from, and the one place a release chuggy names is taken from. */
export const runnerReleasePrefix =
  "https://github.com/kasofsk/chuggy-linux/releases/download/";

/** The wait before a pull the registry refused is made again under a fresh token. */
const pullRetryMs = 5_000;

/** The cap on an engine call with no deadline of its own, which guards a hung engine. */
const engineCallTimeoutMs = 300_000;

/**
 * @param {string} poolFile
 * @param {Readonly<Record<string, string | undefined>>} environment
 * @param {string} home
 * @returns {Promise<RunnerSetup>}
 */
export async function runnerSetup(poolFile, environment, home) {
  const paths = runnerPaths(environment, home);
  return {
    poolFile,
    credentials: await poolCredentials(poolFile),
    config: await runnerConfig(paths.config),
    paths,
  };
}

/**
 * @param {RunnerPaths} paths
 * @returns {string}
 */
export function runtimeDirectory(paths) {
  if (paths.runtime === undefined)
    throw new Error(
      "XDG_RUNTIME_DIR is not set; a systemd user session sets it, and the runner keeps its pull credentials and env files there",
    );
  return paths.runtime;
}

/**
 * A pool's own runtime directory under the runner's, so no two pools share a
 * control socket or scratch. It sits in `pools`, a name no scratch entry has.
 *
 * @param {RunnerPaths} paths
 * @param {PoolIdentity} identity
 */
export function poolRuntimeDirectory(paths, identity) {
  return join(runtimeDirectory(paths), "pools", poolIdentityDigest(identity));
}

/**
 * The lock a service takes to install a release of the runner: one for every
 * pool's service of this user, which all run the one install.
 *
 * @param {RunnerPaths} paths
 */
export function runnerUpdateLock(paths) {
  return join(runtimeDirectory(paths), "update.lock");
}

/**
 * The lock a service takes to start a job into its engine's memory: one for
 * every pool's service of this user on that engine.
 *
 * @param {RunnerPaths} paths
 * @param {"docker" | "podman"} engine
 */
export function runnerMemoryLock(paths, engine) {
  return join(runtimeDirectory(paths), "memory", `${engine}.lock`);
}

/**
 * The lock a service takes to ask a plane that claims by room for jobs, so
 * no two are given the same room: one for every pool's service of this user
 * on that engine, beside the memory lock.
 *
 * @param {RunnerPaths} paths
 * @param {"docker" | "podman"} engine
 */
export function runnerClaimLock(paths, engine) {
  return join(runtimeDirectory(paths), "memory", `${engine}.claim`);
}

/**
 * The lock a service takes to get and copy chuggy's runtime, so a pull for one
 * platform does not replace the variant another of this user's services is
 * copying from: one for every pool's service of this user on that engine.
 *
 * @param {RunnerPaths} paths
 * @param {"docker" | "podman"} engine
 */
export function runnerRuntimeLock(paths, engine) {
  return join(runtimeDirectory(paths), "runtime", `${engine}.lock`);
}

/**
 * What the container backend is told of what every pool's service of this
 * user on its engine shares: the memory budget the runner's file keeps and
 * reserves, and the memory, claim and runtime locks.
 *
 * @param {RunnerConfig} config
 * @param {RunnerPaths} paths
 */
export function runnerEngineSettings(config, paths) {
  return {
    memoryFreeBytesMin: memoryFreeBytes(config),
    memoryReservedBytes: memoryReservedBytes(config),
    memoryLock: runnerMemoryLock(paths, config.engine),
    memoryClaimLock: runnerClaimLock(paths, config.engine),
    runtimeLock: runnerRuntimeLock(paths, config.engine),
  };
}

/**
 * What a run is told of its runner's update of itself: on unless the
 * runner's file turns it off, and taken from this package's own release
 * downloads into the directory this copy is installed in.
 *
 * @param {Pick<RunnerSetup, "config" | "paths">} setup
 * @param {RunnerCopy} copy
 * @param {Partial<RunnerUpdatePorts>} [ports] where a suite stands in for the network, npm or the machine
 * @returns {WorkerPoolUpdates}
 */
export function runnerUpdates(setup, copy, ports) {
  return {
    on: setup.config.autoUpdate,
    updater: runnerUpdater(
      {
        runner: { package: copy.package, version: copy.version },
        releasePrefix: runnerReleasePrefix,
        installed: dirname(copy.cli),
        lockPath: runnerUpdateLock(setup.paths),
      },
      ports,
    ),
  };
}

/**
 * The capabilities each poll of a pool's run advertises, found when it
 * starts: this machine's platform, the agents the runner's file can run, and
 * what the file's `capabilities` declares or, where it is absent, the
 * rest of what the pool was registered with. A machine no pool runs on, and
 * a set past the contract's bound, are refused.
 *
 * @param {Pick<RunnerSetup, "credentials" | "config" | "paths">} setup
 * @param {string} arch as `process.arch` names this machine
 * @returns {string[]}
 */
export function runnerCapabilities(setup, arch) {
  const { credentials, config, paths } = setup;
  const found = registerPlatform(arch);
  if ("refused" in found) throw new Error(found.refused);
  const advertised = registerAdvertised({
    platforms: [found.platform],
    files: runnerCredentialsHanded(config),
    images: config.images,
    host: credentials.host === true,
    declared: config.capabilities,
    recorded: credentials.capabilities,
  });
  if ("refused" in advertised)
    throw new Error(
      `runner configuration ${paths.config}: capabilities: ${advertised.refused}`,
    );
  return advertised.capabilities;
}

/**
 * @param {RunnerConfig} config
 * @returns {Engine}
 */
export function runnerEngine(config) {
  return containerEngine(config.engine, engineCallTimeoutMs);
}

/** The scheme a unix socket is named by as an endpoint. */
const unixScheme = "unix://";

/** How `docker info` names a daemon that maps a job's uid onto another. */
const remappedDocker = { rootless: "rootless", userns: "with userns-remap" };

/** The first podman whose keep-id maps its user onto a uid and gid it is given. */
const podmanVersionMin = /** @type {const} */ ([4, 3]);

/**
 * Refuses rootless docker and userns-remap, because each maps a job's uid onto
 * one that cannot read the Claude credential's file, and any context but a unix
 * socket: a job mounts this machine's paths, which a remote daemon would find
 * on its own, and a pull of the pool's registry is told the endpoint alone,
 * without a context's certificates.
 *
 * @param {Engine} engine
 * @returns {Promise<string>} the endpoint docker's context names
 */
async function dockerEndpoint(engine) {
  const info = await engine.exec(dockerInfoArgv());
  if (info.code !== 0)
    throw new Error(`docker could not be asked: ${engineFailureLine(info)}`);
  const remapped = /\bname=(rootless|userns)\b/u.exec(info.stdout)?.[1];
  if (remapped !== undefined)
    throw new Error(
      `docker is running ${remappedDocker[remapped]}, where a job cannot read the Claude credential's file; use rootful docker without userns-remap, or rootless podman ("engine": "podman")`,
    );
  const context = await engine.exec(dockerContextArgv());
  if (context.code !== 0)
    throw new Error(
      `docker's context could not be read: ${engineFailureLine(context)}`,
    );
  const endpoint = context.stdout.trim();
  if (!endpoint.startsWith(unixScheme))
    throw new Error(
      `docker's context names "${endpoint}", and only a local docker, reached by a unix socket, is supported`,
    );
  return endpoint;
}

/**
 * Refuses a podman older than the first whose keep-id maps its user onto the
 * job's, which every job is run with, and a podman whose version cannot be
 * read.
 *
 * @param {Engine} engine
 */
async function podmanVersionChecked(engine) {
  const answer = await engine.exec(podmanVersionArgv());
  if (answer.code !== 0)
    throw new Error(`podman could not be asked: ${engineFailureLine(answer)}`);
  const version = answer.stdout.trim();
  const required = `podman ${podmanVersionMin.join(".")} or later is required`;
  const parsed = /^(\d+)\.(\d+)\.\d+(?:[-+][0-9A-Za-z.+-]+)?$/u.exec(version);
  if (parsed === null)
    throw new Error(`podman answered "${version}", not a version; ${required}`);
  const [major, minor] = [Number(parsed[1]), Number(parsed[2])];
  const [majorMin, minorMin] = podmanVersionMin;
  if (major < majorMin || (major === majorMin && minor < minorMin))
    throw new Error(
      `podman ${version} cannot map its user onto a job's with --userns=keep-id:uid=,gid=; ${required}`,
    );
}

/**
 * Refuses a remote podman client, whose service may be on another machine and
 * mounts a job's paths from there rather than from this one.
 *
 * @param {Engine} engine
 */
async function podmanLocalChecked(engine) {
  const answer = await engine.exec(podmanRemoteArgv());
  if (answer.code !== 0)
    throw new Error(
      `podman could not say whether it is a remote client: ${engineFailureLine(answer)}`,
    );
  const remote = answer.stdout.trim();
  if (remote === "true")
    throw new Error(
      "podman is a remote client here (CONTAINER_HOST, CONTAINER_CONNECTION or remote = true in containers.conf), whose service may be on another machine and mounts a job's paths from there; run the runner beside a local podman",
    );
  if (remote !== "false")
    throw new Error(
      `podman answered "${remote}" when asked whether it is a remote client`,
    );
}

/**
 * The endpoint a pull of the pool's registry is told, of an engine checked to
 * be one a job can be run by: docker's, from its context, which that pull,
 * made under a configuration directory of its own, would otherwise lose.
 * Podman has none.
 *
 * @param {RunnerConfig["engine"]} name
 * @param {Engine} engine
 * @returns {Promise<string | undefined>}
 */
export async function engineEndpoint(name, engine) {
  if (name === "docker") return dockerEndpoint(engine);
  await podmanVersionChecked(engine);
  await podmanLocalChecked(engine);
  return undefined;
}

/** What starts each engine's socket. */
const engineSocketStart = {
  docker: "sudo systemctl start docker",
  podman: "systemctl --user enable --now podman.socket",
};

/**
 * Where podman says its socket is on this machine, which it may name as an
 * endpoint, and whether it is there.
 *
 * @param {Engine} engine
 */
async function podmanSocket(engine) {
  const answer = await engine.exec(podmanSocketArgv());
  if (answer.code !== 0)
    throw new Error(
      `podman could not say where its socket is: ${engineFailureLine(answer)}`,
    );
  const said = /^(\S.*) (true|false)$/u.exec(answer.stdout.trim());
  if (said === null)
    throw new Error(
      `podman answered "${answer.stdout.trim()}" when asked where its socket is`,
    );
  const [, named, there] = said;
  const path = named.startsWith(unixScheme)
    ? named.slice(unixScheme.length)
    : named;
  return { path, there: there === "true" };
}

/**
 * The socket of this machine's engine each job is handed: docker's at the
 * endpoint its context names, or podman's where podman says, with the group
 * that owns it. One a bind mount cannot name is refused, and so is one that
 * is not there. Where the runner's file hands jobs none, there is none, and
 * nothing is asked.
 *
 * @param {RunnerConfig} config
 * @param {Engine} engine
 * @param {string | undefined} endpoint docker's, as `engineEndpoint` answers it
 * @returns {Promise<EngineSocket | undefined>}
 */
export async function engineSocketHanded(config, engine, endpoint) {
  if (!config.engineSocket) return undefined;
  const { path, there } =
    config.engine === "docker"
      ? { path: (endpoint ?? "").slice(unixScheme.length), there: true }
      : await podmanSocket(engine);
  const socket = `${config.engine}'s socket ${path}`;
  if (!isAbsolute(path) || !bindMountNameable(path))
    throw new Error(
      `${socket} cannot be named in a bind mount; serve the engine at an absolute path with no comma or line break, or set engineSocket to false`,
    );
  const stats = there ? await stat(path).catch(() => undefined) : undefined;
  if (stats === undefined)
    throw new Error(
      `${socket} is not there; start it with ${engineSocketStart[config.engine]}`,
    );
  return { path, gid: stats.gid };
}

/**
 * @typedef {{uid: number, log: (line: string) => void, engine?: Engine, tokens?: WorkerPoolClient["tokens"], fetch?: typeof globalThis.fetch, places?: boolean, spawn?: typeof import("node:child_process").spawn, runner?: RunnerIdentity, arch?: string, disk?: import("./diskFree.mjs").DiskFreePorts}} RunnerHost this process's uid, where its log lines go, the engine and token source when not those the files name, the fetch a job's or a session's plane is reached by when not the global one, `places: false` for a run that places nothing, which then asks nothing of the engine's socket and advertises nothing, what starts a job on this machine itself when not Node's own `spawn`, the package and version each poll names, this machine as `process.arch` names it when not this one, and what the engine's free disk is measured by when not this machine's own
 */

/**
 * The backend as a run's loop sees it on podman, where nothing held outlives
 * this process. Under the service's unit, podman leaves each container's
 * conmon in the unit's cgroup, and the unit's stop or restart signals conmon,
 * which passes the signal to the container. So an update waits for podman's
 * containers to end, as it waits for a job on this machine itself.
 *
 * @param {WorkerPoolBackend} backend
 * @returns {WorkerPoolBackend}
 */
export function heldEndingWithRunner(backend) {
  return {
    ...backend,
    held: async () =>
      (await backend.held()).map(({ assignment, kind }) => ({
        assignment,
        kind,
      })),
  };
}

/**
 * @param {RunnerSetup} setup
 * @param {RunnerHost} host
 * @returns {Promise<Runner>}
 */
export async function runnerParts(setup, host) {
  const { credentials, config, paths } = setup;
  const capabilities =
    host.places === false
      ? undefined
      : runnerCapabilities(setup, host.arch ?? process.arch);
  const runtimeDir = poolRuntimeDirectory(paths, credentials);
  const engine = host.engine ?? runnerEngine(config);
  const dockerHost = await engineEndpoint(config.engine, engine);
  const engineSocket =
    host.places === false
      ? undefined
      : await engineSocketHanded(config, engine, dockerHost);
  const tokens = host.tokens ?? poolRunnerTokens(credentials);
  const machine = {
    cpuMillis: availableParallelism() * 1000,
    memoryMib: Math.floor(totalmem() / (1024 * 1024)),
  };
  const handed = runnerCredentialsHanded(config);
  const disk = host.disk ?? diskFreePorts;
  const container = containerBackend(
    {
      engine: config.engine,
      pool: credentials,
      ...handed,
      registryHost: credentials.registryHost,
      dockerHost,
      timeoutSecsMax: config.timeoutSecsMax,
      outputBytesMax: config.outputBytesMax,
      environment: config.environment,
      network: config.network,
      runtimeDir,
      logDir: paths.logs,
      machine,
      pullRetryMs,
      images: config.images,
      volumes: config.volumes,
      ...(engineSocket === undefined ? {} : { engineSocket }),
      imageRecord: join(paths.images, `${config.engine}.json`),
      imageUnusedSecsMax: config.imageUnusedSecsMax,
      diskFreeBytesMin: diskFloorBytes(config),
      ...runnerEngineSettings(config, paths),
    },
    {
      engine,
      tokens,
      nowMs: Date.now,
      sleep: (ms, signal) => delay(ms, undefined, { signal }),
      log: host.log,
      tokenFileRefusal: (file, agent) =>
        credentialFileRefusal(
          runnerCredentialDescribed(handed.claudeCredential, agent),
          file,
          config.engine,
          host.uid,
        ),
      diskFree: () => engineDiskFree(config.engine, engine, disk),
    },
  );
  const backend = runnerHostRouted(setup, container, machine, host);
  const client = poolRunnerClient(
    credentials,
    config.engine === "podman" ? heldEndingWithRunner(backend) : backend,
    runnerPoolLimits(config, setup.poolFile),
    { tokens, fetch: host.fetch, runner: host.runner, capabilities },
  );
  return { runtime: runtimeDir, engine, disk, backend, client };
}

/**
 * The container backend, with this machine beside it where the pool was
 * registered with `--host`, taking each job that pins no image and names the
 * platform the pool declared it is.
 *
 * @param {RunnerSetup} setup
 * @param {ContainerBackend} container
 * @param {{cpuMillis: number, memoryMib: number}} machine
 * @param {RunnerHost} host
 * @returns {ContainerBackend}
 */
function runnerHostRouted(setup, container, machine, host) {
  const { credentials, config, paths } = setup;
  const platforms = hostPlatformsDeclared(credentials, "Linux");
  if (platforms.length === 0) return container;
  const handed = runnerCredentialsHanded(config);
  return hostRoutedBackend(
    container,
    hostBackend(
      {
        platforms,
        directory: join(paths.jobs, poolIdentityDigest(credentials)),
        logDir: paths.logs,
        ...handed,
        timeoutSecsMax: config.timeoutSecsMax,
        outputBytesMax: config.outputBytesMax,
        environment: config.environment,
        machine,
      },
      {
        log: host.log,
        ...(host.spawn === undefined ? {} : { spawn: host.spawn }),
        tokenFileRefusal: (file, agent) =>
          credentialFileRefusal(
            runnerCredentialDescribed(handed.claudeCredential, agent),
            file,
            "host",
            host.uid,
          ),
      },
    ),
    platforms,
  );
}

/**
 * The job network, made when it is missing. Every pool's run on the machine
 * shares it, so a creation that failed is one another run may have beaten.
 *
 * @param {Engine} engine
 * @param {string} network
 * @returns {Promise<"Present" | "Created">}
 */
export async function jobNetwork(engine, network) {
  const inspected = await engine.exec(networkInspectArgv(network));
  if (inspected.code === 0) return "Present";
  if (engineFailure(inspected) !== "NotFound")
    throw new Error(
      `network ${network} could not be inspected: ${engineFailureLine(inspected)}`,
    );
  const created = await engine.exec(networkCreateArgv(network));
  if (created.code === 0) return "Created";
  if ((await engine.exec(networkInspectArgv(network))).code === 0)
    return "Present";
  throw new Error(
    `network ${network} could not be created: ${engineFailureLine(created)}`,
  );
}

/**
 * The pool loop until the plane denies the pool, which the unit does not
 * restart, or until the runner has installed a release of itself, which the
 * unit restarts it on and a run started by hand is started again on.
 *
 * @param {WorkerPoolClient} client
 * @param {{sleep: (ms: number) => Promise<void>, log: (line: string) => void, updates: WorkerPoolUpdates, underService: boolean}} seams `underService` where systemd started the run
 * @returns {Promise<number>} the exit status
 */
export async function runnerLoop(client, seams) {
  const { underService, ...loop } = seams;
  const pass = await poolRunnerLoop(client, loop);
  if (pass.passed === "Denied") return deniedExitStatus;
  const release = `${seams.updates.updater.runner.package} ${pass.version}`;
  seams.log(
    underService
      ? `ending, for the service to restart on ${release}`
      : `ending: start this run again to run ${release}`,
  );
  return updatedExitStatus;
}

/**
 * The directories a pool's run writes under, made owner-only.
 *
 * @param {RunnerPaths} paths
 * @param {string} runtime the pool's runtime directory
 */
export async function runnerDirectories(paths, runtime) {
  await mkdir(runtime, { recursive: true, mode: 0o700 });
  await mkdir(paths.logs, { recursive: true, mode: 0o700 });
}

/**
 * Removes every pull credential and env file in a pool's runtime directory,
 * which only a run that no other run of the pool is beside may do: each is
 * one a killed run did not get to remove.
 *
 * @param {string} runtime the pool's runtime directory
 */
export async function runnerLeftoversRemoved(runtime) {
  for (const entry of await readdir(runtime))
    if (/^(?:pull|job)-/u.test(entry))
      await rm(join(runtime, entry), { recursive: true, force: true });
}

/**
 * Removes the pull credentials and env files this process made, and no other
 * process's.
 *
 * @param {string} runtime
 * @param {number} pid
 */
export function ownScratchRemoved(runtime, pid = process.pid) {
  const own = [runtimeScratch("pull", pid), runtimeScratch("job", pid)];
  for (const entry of readdirSync(runtime))
    if (own.some((prefix) => entry.startsWith(prefix)))
      rmSync(join(runtime, entry), { recursive: true, force: true });
}

/**
 * Has a SIGTERM, SIGINT or SIGHUP remove this process's own scratch, then end the
 * process by that signal as it would have ended anyway. Its containers are
 * left for the next run to pick up.
 *
 * @param {string} runtime
 */
export function scratchRemovedOnSignal(runtime) {
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"])
    process.once(signal, () => {
      try {
        ownScratchRemoved(runtime);
      } finally {
        process.kill(process.pid, signal);
      }
    });
}

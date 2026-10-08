/**
 * The runner composed: the pool's credentials and the runner's file read, and
 * the container backend beside the worker core's pool runner, which passes
 * until the plane denies the pool. Every command starts here.
 */

import { readdirSync, rmSync } from "node:fs";
import { mkdir, readdir, rm } from "node:fs/promises";
import { availableParallelism, totalmem } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { poolCredentials } from "@chuggy/worker-core/poolCredentials.mjs";
import {
  poolRunnerClient,
  poolRunnerLoop,
  poolRunnerTokens,
} from "@chuggy/worker-core/poolRunner.mjs";

import { containerBackend } from "@chuggy/worker-core/containerBackend.mjs";
import { containerEngine } from "@chuggy/worker-core/engine.mjs";
import {
  dockerContextArgv,
  dockerInfoArgv,
  networkCreateArgv,
  networkInspectArgv,
  podmanRemoteArgv,
  podmanVersionArgv,
} from "@chuggy/worker-core/engineArgv.mjs";
import {
  engineFailure,
  engineFailureLine,
} from "@chuggy/worker-core/engineErrors.mjs";
import { poolIdentityDigest } from "@chuggy/worker-core/poolIdentity.mjs";
import { runtimeScratch } from "@chuggy/worker-core/runtimeScratch.mjs";

import {
  claudeTokenFileRefusal,
  runnerConfig,
  runnerPaths,
} from "./runnerConfig.mjs";
import { deniedExitStatus } from "./systemdUnit.mjs";

/**
 * @typedef {import("@chuggy/worker-core/poolCredentials.mjs").PoolCredentials} PoolCredentials
 * @typedef {import("@chuggy/worker-core/poolLoop.mjs").WorkerPoolClient} WorkerPoolClient
 * @typedef {import("@chuggy/worker-core/containerBackend.mjs").ContainerBackend} ContainerBackend
 * @typedef {import("@chuggy/worker-core/engine.mjs").Engine} Engine
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
 * @property {ContainerBackend} backend
 * @property {WorkerPoolClient} client
 */

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
 * @param {RunnerConfig} config
 * @returns {Engine}
 */
export function runnerEngine(config) {
  return containerEngine(config.engine, engineCallTimeoutMs);
}

/** How `docker info` names a daemon that maps a job's uid onto another. */
const remappedDocker = { rootless: "rootless", userns: "with userns-remap" };

/** The first podman whose `--authfile` is the only login file it reads. */
const podmanVersionMin = /** @type {const} */ ([4, 4]);

/**
 * Refuses rootless docker and userns-remap, because each maps a job's uid onto
 * one that cannot read the Claude token file, and any context but a unix
 * socket, since a remote context's certificates would not reach the pull.
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
      `docker is running ${remappedDocker[remapped]}, where a job cannot read the Claude token file; use rootful docker without userns-remap, or rootless podman ("engine": "podman")`,
    );
  const context = await engine.exec(dockerContextArgv());
  if (context.code !== 0)
    throw new Error(
      `docker's context could not be read: ${engineFailureLine(context)}`,
    );
  const endpoint = context.stdout.trim();
  if (!endpoint.startsWith("unix://"))
    throw new Error(
      `docker's context names "${endpoint}", and only a local docker, reached by a unix socket, is supported`,
    );
  return endpoint;
}

/**
 * Refuses a podman older than the first whose `--authfile` is the only login
 * file it reads, since an older one presents this machine's stored logins
 * too, and a podman whose version cannot be read.
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
      `podman ${version} reads this machine's stored logins even when told not to; ${required}`,
    );
}

/**
 * Refuses a remote podman client: an empty `--authfile` sends its service
 * nothing, and the service falls back on its own stored logins.
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
      "podman is a remote client here (CONTAINER_HOST, CONTAINER_CONNECTION or remote = true in containers.conf), where its service reads its own stored logins; run the runner beside a local podman",
    );
  if (remote !== "false")
    throw new Error(
      `podman answered "${remote}" when asked whether it is a remote client`,
    );
}

/**
 * The endpoint a pull is told, of an engine checked to be one a job can be
 * run by: docker's, from its context, which a pull made under a configuration
 * directory of its own would otherwise lose. Podman has none.
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

/**
 * @param {RunnerSetup} setup
 * @param {{uid: number, log: (line: string) => void, engine?: Engine, tokens?: WorkerPoolClient["tokens"], fetch?: typeof globalThis.fetch}} host this process's uid, where its log lines go, the engine and token source when not those the files name, and the fetch a job's or a session's plane is reached by when not the global one
 * @returns {Promise<Runner>}
 */
export async function runnerParts(setup, host) {
  const { credentials, config, paths } = setup;
  const runtimeDir = poolRuntimeDirectory(paths, credentials);
  const engine = host.engine ?? runnerEngine(config);
  const dockerHost = await engineEndpoint(config.engine, engine);
  const tokens = host.tokens ?? poolRunnerTokens(credentials);
  const backend = containerBackend(
    {
      engine: config.engine,
      pool: credentials,
      tokenFile: config.claudeTokenFile,
      registryHost: credentials.registryHost,
      dockerHost,
      timeoutSecsMax: config.timeoutSecsMax,
      outputBytesMax: config.outputBytesMax,
      environment: config.environment,
      network: config.network,
      runtimeDir,
      logDir: paths.logs,
      machine: {
        cpuMillis: availableParallelism() * 1000,
        memoryMib: Math.floor(totalmem() / (1024 * 1024)),
      },
      pullRetryMs,
    },
    {
      engine,
      tokens,
      nowMs: Date.now,
      sleep: (ms, signal) => delay(ms, undefined, { signal }),
      log: host.log,
      tokenFileRefusal: (file) =>
        claudeTokenFileRefusal(file, config.engine, host.uid),
    },
  );
  const client = poolRunnerClient(
    credentials,
    backend,
    { concurrencyMax: config.concurrencyMax, sessionsMax: config.sessionsMax },
    { tokens, fetch: host.fetch },
  );
  return { runtime: runtimeDir, engine, backend, client };
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
 * restart.
 *
 * @param {WorkerPoolClient} client
 * @param {{sleep: (ms: number) => Promise<void>, log: (line: string) => void}} seams
 * @returns {Promise<number>} the exit status
 */
export async function runnerLoop(client, seams) {
  await poolRunnerLoop(client, seams);
  return deniedExitStatus;
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
 * Has a SIGTERM or SIGINT remove this process's own scratch, then end the
 * process by that signal as it would have ended anyway. Its containers are
 * left for the next run to pick up.
 *
 * @param {string} runtime
 */
export function scratchRemovedOnSignal(runtime) {
  for (const signal of ["SIGTERM", "SIGINT"])
    process.once(signal, () => {
      try {
        ownScratchRemoved(runtime);
      } finally {
        process.kill(process.pid, signal);
      }
    });
}

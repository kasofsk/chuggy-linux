/**
 * The runner composed: the pool's credentials and the runner's file read, the
 * worker core's token source and plane client built from them, and the
 * container backend beside them. Every command starts here.
 *
 * THE LOOP IS THE CORE'S PASS, RUN UNTIL A DENIAL rather than for a count of
 * passes, because the placements a run has in flight live in its memory. Each
 * outage is logged, since under systemd an unlogged one is a pool that
 * silently stopped working. A pass that throws ends the run, and the unit's
 * restart begins the next one from what the engine lists.
 */

import { readdirSync, rmSync } from "node:fs";
import { mkdir, readdir, rm } from "node:fs/promises";
import { availableParallelism, totalmem } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { poolCredentials } from "@chuggy/worker-core/poolCredentials.mjs";
import { poolJobPlaneClient } from "@chuggy/worker-core/poolJobPlane.mjs";
import {
  checkedWorkerPoolClientSettings,
  workerPoolClientPass,
} from "@chuggy/worker-core/poolLoop.mjs";
import { poolPlaneClient } from "@chuggy/worker-core/poolPlane.mjs";
import { poolClientTokens } from "@chuggy/worker-core/poolTokens.mjs";

import { containerBackend } from "./containerBackend.mjs";
import { containerEngine } from "./engine.mjs";
import {
  dockerContextArgv,
  dockerInfoArgv,
  networkCreateArgv,
  networkInspectArgv,
  podmanRemoteArgv,
  podmanVersionArgv,
} from "./engineArgv.mjs";
import { engineFailure, engineFailureLine } from "./engineErrors.mjs";
import { poolIdentityDigest } from "./poolIdentity.mjs";
import { runnerConfig, runnerPaths, runtimeScratch } from "./runnerConfig.mjs";
import { deniedExitStatus } from "./systemdUnit.mjs";

/**
 * @typedef {import("@chuggy/worker-core/poolCredentials.mjs").PoolCredentials} PoolCredentials
 * @typedef {import("@chuggy/worker-core/poolLoop.mjs").WorkerPoolClient} WorkerPoolClient
 * @typedef {import("./containerBackend.mjs").ContainerBackend} ContainerBackend
 * @typedef {import("./engine.mjs").Engine} Engine
 * @typedef {import("./poolIdentity.mjs").PoolIdentity} PoolIdentity
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

/** Chuggy's own pool client's bounds, which its issuer and plane are sized for. */
const tokenSettings = {
  requestTimeoutMs: 10_000,
  responseBytesMax: 64 * 1024,
  responseReadsMax: 64,
  refreshMarginMs: 60_000,
  mintCooldownMs: 1_000,
};
const planeSettings = { pollTimeoutMs: 120_000, settleTimeoutMs: 10_000 };
const jobPlaneSettings = { timeoutMs: 10_000 };
const outageBackoffMs = 5_000;

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
 * @param {PoolCredentials} credentials
 * @returns {WorkerPoolClient["tokens"]}
 */
export function runnerTokens(credentials) {
  return poolClientTokens({
    tokenUrl: credentials.tokenUrl,
    clientId: credentials.clientId,
    clientSecret: credentials.clientSecret,
    audience: [credentials.audience],
    scope: [],
    ...tokenSettings,
  });
}

/**
 * @param {PoolCredentials} credentials
 * @returns {WorkerPoolClient["plane"]}
 */
export function runnerPlane(credentials) {
  return poolPlaneClient({ baseUrl: credentials.planeUrl, ...planeSettings });
}

/**
 * @param {RunnerSetup} setup
 * @param {{uid: number, log: (line: string) => void, engine?: Engine, tokens?: WorkerPoolClient["tokens"], fetch?: typeof globalThis.fetch}} host this process's uid, where its log lines go, the engine and token source when not those the files name, and the fetch a job's plane is reached by when not the global one
 * @returns {Promise<Runner>}
 */
export async function runnerParts(setup, host) {
  const { credentials, config, paths } = setup;
  const runtimeDir = poolRuntimeDirectory(paths, credentials);
  const engine = host.engine ?? runnerEngine(config);
  const dockerHost = await engineEndpoint(config.engine, engine);
  const tokens = host.tokens ?? runnerTokens(credentials);
  const backend = containerBackend(
    {
      engine: config.engine,
      pool: credentials,
      tokenFile: config.claudeTokenFile,
      runnerUid: host.uid,
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
    },
  );
  const client = {
    tokens,
    plane: runnerPlane(credentials),
    jobs: poolJobPlaneClient(jobPlaneSettings, host.fetch),
    backend,
    settings: checkedWorkerPoolClientSettings({
      concurrencyMax: config.concurrencyMax,
      outageBackoffMs,
      passesMax: 1,
    }),
  };
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
 * What a pass did, as a log line, naming the jobs it ended only where it
 * ended any.
 *
 * @param {{placed: number, stopped: number, refused: number, ended: number}} pass
 */
export function passLine(pass) {
  const line = `placed ${String(pass.placed)}, stopped ${String(pass.stopped)}, refused ${String(pass.refused)}`;
  return pass.ended === 0 ? line : `${line}, ended ${String(pass.ended)}`;
}

/**
 * The pool loop until the plane denies the pool.
 *
 * @param {WorkerPoolClient} client
 * @param {{sleep: (ms: number) => Promise<void>, log: (line: string) => void}} seams
 * @returns {Promise<number>} the exit status
 */
export async function runnerLoop(client, seams) {
  for (;;) {
    const pass = await workerPoolClientPass(client);
    if (pass.passed === "Denied") {
      seams.log(`the plane denied this pool: ${pass.evidence}`);
      return deniedExitStatus;
    }
    if (pass.passed === "Unavailable") {
      seams.log(`outage: ${pass.evidence}`);
      await seams.sleep(client.settings.outageBackoffMs);
    } else if (pass.placed + pass.stopped + pass.refused + pass.ended > 0)
      seams.log(passLine(pass));
  }
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

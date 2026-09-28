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

import { availableParallelism, totalmem } from "node:os";
import { mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { poolCredentials } from "@chuggy/worker-core/poolCredentials.mjs";
import {
  checkedWorkerPoolClientSettings,
  workerPoolClientPass,
} from "@chuggy/worker-core/poolLoop.mjs";
import { poolPlaneClient } from "@chuggy/worker-core/poolPlane.mjs";
import { poolClientTokens } from "@chuggy/worker-core/poolTokens.mjs";

import { containerBackend } from "./containerBackend.mjs";
import { containerEngine } from "./engine.mjs";
import { networkCreateArgv, networkInspectArgv } from "./engineArgv.mjs";
import { engineFailure, engineFailureLine } from "./engineErrors.mjs";
import { jobHostUid, runnerConfig, runnerPaths } from "./runnerConfig.mjs";
import { deniedExitStatus } from "./systemdUnit.mjs";

/**
 * @typedef {import("@chuggy/worker-core/poolCredentials.mjs").PoolCredentials} PoolCredentials
 * @typedef {import("@chuggy/worker-core/poolLoop.mjs").WorkerPoolClient} WorkerPoolClient
 * @typedef {import("./containerBackend.mjs").ContainerBackend} ContainerBackend
 * @typedef {import("./engine.mjs").Engine} Engine
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
 * @param {RunnerConfig} config
 * @returns {Engine}
 */
export function runnerEngine(config) {
  return containerEngine(config.engine, engineCallTimeoutMs);
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
 * @param {{uid: number, log: (line: string) => void}} host this process's uid, and where its log lines go
 * @returns {Runner}
 */
export function runnerParts(setup, host) {
  const { credentials, config, paths } = setup;
  const engine = runnerEngine(config);
  const tokens = runnerTokens(credentials);
  const backend = containerBackend(
    {
      engine: config.engine,
      pool: credentials,
      tokenFile: config.claudeTokenFile,
      tokenReaderUid: jobHostUid(config.engine, host.uid),
      timeoutSecsMax: config.timeoutSecsMax,
      outputBytesMax: config.outputBytesMax,
      environment: config.environment,
      network: config.network,
      runtimeDir: runtimeDirectory(paths),
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
    backend,
    settings: checkedWorkerPoolClientSettings({
      concurrencyMax: config.concurrencyMax,
      outageBackoffMs,
      passesMax: 1,
    }),
  };
  return { engine, backend, client };
}

/**
 * The job network, made when it is missing.
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
  if (created.code !== 0)
    throw new Error(
      `network ${network} could not be created: ${engineFailureLine(created)}`,
    );
  return "Created";
}

/**
 * What a pass did, as a log line.
 *
 * @param {{placed: number, stopped: number, refused: number}} pass
 */
export function passLine(pass) {
  return `placed ${String(pass.placed)}, stopped ${String(pass.stopped)}, refused ${String(pass.refused)}`;
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
    } else if (pass.placed + pass.stopped + pass.refused > 0)
      seams.log(passLine(pass));
  }
}

/**
 * The directories the runner writes under, made owner-only. A pull credential
 * or env file left in the runtime directory is one a killed run did not get to
 * remove, and is removed here.
 *
 * @param {RunnerPaths} paths
 */
export async function runnerDirectories(paths) {
  const runtime = runtimeDirectory(paths);
  await mkdir(runtime, { recursive: true, mode: 0o700 });
  await mkdir(paths.logs, { recursive: true, mode: 0o700 });
  for (const entry of await readdir(runtime))
    if (/^(?:pull|job)-/u.test(entry))
      await rm(join(runtime, entry), { recursive: true, force: true });
}

/**
 * What `doctor` checks, in the order a run depends on them, each answered as
 * passed or not with what was found. It changes nothing: a missing network is
 * reported for a run to make, and its one poll names nothing held and wants
 * nothing, which the plane answers without granting or releasing a lease.
 */

import { poolCredentials } from "@chuggy/worker-core/poolCredentials.mjs";

import { poolLabelValue } from "./containerBackend.mjs";
import { listArgv, networkInspectArgv } from "./engineArgv.mjs";
import { engineFailure, engineFailureLine } from "./engineErrors.mjs";
import {
  claudeTokenFileRefusal,
  jobHostUid,
  runnerConfig,
} from "./runnerConfig.mjs";
import { runtimeDirectory } from "./runner.mjs";

/**
 * @typedef {import("@chuggy/worker-core/poolCredentials.mjs").PoolCredentials} PoolCredentials
 * @typedef {import("@chuggy/worker-core/poolLoop.mjs").WorkerPoolClient} WorkerPoolClient
 * @typedef {import("./engine.mjs").Engine} Engine
 * @typedef {import("./runnerConfig.mjs").RunnerConfig} RunnerConfig
 * @typedef {import("./runnerConfig.mjs").RunnerPaths} RunnerPaths
 *
 * @typedef {{check: string, passed: boolean, detail: string}} DoctorFinding
 *
 * @typedef {object} DoctorParts what a run would reach, built from what was read
 * @property {(config: RunnerConfig) => Engine} engine
 * @property {(credentials: PoolCredentials) => WorkerPoolClient["tokens"]} tokens
 * @property {(credentials: PoolCredentials) => WorkerPoolClient["plane"]} plane
 *
 * @typedef {object} DoctorInput
 * @property {string} poolFile
 * @property {RunnerPaths} paths
 * @property {number} uid this process's
 * @property {DoctorParts} parts
 */

/**
 * Runs one check: a probe answers what it found, or throws what is wrong.
 *
 * @template T
 * @param {DoctorFinding[]} findings
 * @param {string} check
 * @param {() => Promise<[T, string]>} probe
 * @returns {Promise<T | undefined>}
 */
async function checked(findings, check, probe) {
  try {
    const [value, detail] = await probe();
    findings.push({ check, passed: true, detail });
    return value;
  } catch (failure) {
    const detail = failure instanceof Error ? failure.message : String(failure);
    findings.push({ check, passed: false, detail });
    return undefined;
  }
}

/**
 * @param {Engine} engine
 * @param {PoolCredentials} credentials
 * @param {RunnerConfig} config
 * @param {DoctorFinding[]} findings
 */
async function engineChecks(engine, credentials, config, findings) {
  const reachable = await checked(findings, "container engine", async () => {
    const listed = await engine.exec(listArgv(poolLabelValue(credentials)));
    if (listed.code !== 0) throw new Error(engineFailureLine(listed));
    const count = listed.stdout.split("\n").filter((id) => id.trim()).length;
    return [
      true,
      `${config.engine} lists ${String(count)} of this pool's containers`,
    ];
  });
  if (reachable === undefined) return;
  await checked(findings, "job network", async () => {
    const inspected = await engine.exec(networkInspectArgv(config.network));
    if (inspected.code === 0) return [true, `${config.network} is present`];
    if (engineFailure(inspected) === "NotFound")
      return [true, `${config.network} is missing, and a run makes it`];
    throw new Error(engineFailureLine(inspected));
  });
}

/**
 * @param {DoctorInput} input
 * @param {PoolCredentials} credentials
 * @param {DoctorFinding[]} findings
 */
async function planeChecks(input, credentials, findings) {
  const token = await checked(findings, "pool token", async () => {
    const acquired = await input.parts.tokens(credentials).acquire();
    if (acquired.acquired !== "Token") throw new Error(acquired.evidence);
    return [acquired.token, `issued by ${credentials.tokenUrl}`];
  });
  if (token === undefined) return;
  await checked(findings, "plane", async () => {
    const polled = await input.parts.plane(credentials).poll(token, [], 0);
    if (polled.polled === "Stale")
      throw new Error("the plane rejected a token the issuer had just issued");
    if (polled.polled !== "Reconciled") throw new Error(polled.evidence);
    return [true, `${credentials.planeUrl} answered a poll`];
  });
}

/**
 * @param {DoctorInput} input
 * @returns {Promise<DoctorFinding[]>}
 */
export async function doctorFindings(input) {
  /** @type {DoctorFinding[]} */
  const findings = [];
  const credentials = await checked(findings, "pool file", async () => {
    const read = await poolCredentials(input.poolFile);
    return [read, `${input.poolFile} names pool ${poolLabelValue(read)}`];
  });
  const config = await checked(findings, "runner configuration", async () => [
    await runnerConfig(input.paths.config),
    input.paths.config,
  ]);
  await checked(findings, "runtime directory", async () => [
    true,
    runtimeDirectory(input.paths),
  ]);
  if (config !== undefined)
    await checked(findings, "Claude token file", async () => {
      const readerUid = jobHostUid(config.engine, input.uid);
      const refusal = await claudeTokenFileRefusal(
        config.claudeTokenFile,
        readerUid,
      );
      if (refusal !== undefined) throw new Error(refusal);
      return [
        true,
        `${config.claudeTokenFile}, readable by uid ${String(readerUid)}`,
      ];
    });
  if (credentials === undefined) return findings;
  if (config !== undefined)
    await engineChecks(
      input.parts.engine(config),
      credentials,
      config,
      findings,
    );
  await planeChecks(input, credentials, findings);
  return findings;
}

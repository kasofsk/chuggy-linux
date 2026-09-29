/**
 * What `doctor` checks, in the order a run depends on them, each answered as
 * passed or not with what was found. It changes nothing: a missing network is
 * reported for a run to make, and its one poll names nothing held and wants
 * nothing, which the plane answers without granting or releasing a lease.
 */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { poolCredentials } from "@chuggy/worker-core/poolCredentials.mjs";

import { poolLabelValue } from "./containerBackend.mjs";
import { listArgv, networkInspectArgv } from "./engineArgv.mjs";
import { engineFailure, engineFailureLine } from "./engineErrors.mjs";
import { claudeTokenFileRefusal, runnerConfig } from "./runnerConfig.mjs";
import { engineEndpoint, runtimeDirectory } from "./runner.mjs";

/**
 * @typedef {import("@chuggy/worker-core/poolCredentials.mjs").PoolCredentials} PoolCredentials
 * @typedef {import("@chuggy/worker-core/poolLoop.mjs").WorkerPoolClient} WorkerPoolClient
 * @typedef {import("./engine.mjs").Engine} Engine
 * @typedef {import("./runnerConfig.mjs").RunnerConfig} RunnerConfig
 * @typedef {import("./runnerConfig.mjs").RunnerPaths} RunnerPaths
 *
 * @typedef {{check: string, passed: boolean, detail: string, warning?: true}} DoctorFinding a warning passes, and is printed as one
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
 * @property {readonly string[]} registriesConf podman's registries.conf files and drop-in directories
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
    const endpoint = await engineEndpoint(config.engine, engine);
    const listed = await engine.exec(listArgv(poolLabelValue(credentials)));
    if (listed.code !== 0) throw new Error(engineFailureLine(listed));
    const count = listed.stdout.split("\n").filter((id) => id.trim()).length;
    return [
      true,
      `${config.engine}${endpoint === undefined ? "" : ` at ${endpoint}`} lists ${String(count)} of this pool's containers`,
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

/** The helper that is the auth file itself, podman's default. */
const authFileHelper = "containers-auth.json";

/**
 * The credential helpers a registries.conf names beyond the auth file, from
 * each `credential-helpers` array it sets, its key bare or quoted.
 *
 * @param {string} text
 */
function credentialHelpersNamed(text) {
  /** @type {string[]} */
  const named = [];
  for (const [, list] of text.matchAll(
    /^\s*(?:credential-helpers|"credential-helpers"|'credential-helpers')\s*=\s*\[([^\]]*)\]/gmu,
  ))
    for (const [, basic, literal] of list.matchAll(/"([^"]*)"|'([^']*)'/gu))
      named.push(basic ?? literal);
  return named.filter((helper) => helper !== authFileHelper);
}

/**
 * The registries.conf files at these locations, each a file or a drop-in
 * directory of `.conf` files, and which of them name a credential helper.
 * One that cannot be read is not counted.
 *
 * @param {readonly string[]} locations
 */
async function registriesConfRead(locations) {
  /** @type {string[]} */
  const files = [];
  for (const location of locations) {
    const entries = await readdir(location).catch(() => undefined);
    files.push(
      ...(entries === undefined
        ? [location]
        : entries
            .filter((entry) => entry.endsWith(".conf"))
            .sort()
            .map((entry) => join(location, entry))),
    );
  }
  let read = 0;
  /** @type {string[]} */
  const helpered = [];
  for (const file of files) {
    const text = await readFile(file, "utf8").catch(() => undefined);
    if (text === undefined) continue;
    read += 1;
    if (credentialHelpersNamed(text).length > 0) helpered.push(file);
  }
  return { read, helpered };
}

/**
 * Podman asks a credential helper registries.conf names whatever
 * `--authfile` says, so a pull outside the pool's registry can present a
 * login of this machine's. That is the operator's to configure, and warned of.
 *
 * @param {readonly string[]} locations
 * @returns {Promise<DoctorFinding>}
 */
async function podmanHelpersFinding(locations) {
  const check = "podman credential helpers";
  const { read, helpered } = await registriesConfRead(locations);
  if (helpered.length === 0)
    return {
      check,
      passed: true,
      detail: `none named in the ${String(read)} registries.conf ${read === 1 ? "file" : "files"} read`,
    };
  return {
    check,
    passed: true,
    warning: true,
    detail: `${helpered.join(", ")} ${helpered.length === 1 ? "names" : "name"} a credential helper, whose logins podman presents on every pull, the pool's token notwithstanding`,
  };
}

/** @param {DoctorFinding} finding */
export function findingLine(finding) {
  const label =
    finding.warning === true ? "warn" : finding.passed ? "ok  " : "FAIL";
  return `${label}  ${finding.check}: ${finding.detail}`;
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
      const refusal = await claudeTokenFileRefusal(
        config.claudeTokenFile,
        config.engine,
        input.uid,
      );
      if (refusal !== undefined) throw new Error(refusal);
      return [true, `${config.claudeTokenFile}, this runner's own`];
    });
  if (config?.engine === "podman")
    findings.push(await podmanHelpersFinding(input.registriesConf));
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

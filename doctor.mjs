/**
 * What `doctor` checks, in the order a run depends on them, each answered as
 * passed or not with what was found, and before the engine whether the pool
 * file's unit runs this copy. It changes nothing: a missing network is
 * reported for a run to make, and its one poll names nothing held and wants
 * nothing, which the plane answers without granting or releasing a lease.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

import { poolCredentials } from "@chuggy/worker-core/poolCredentials.mjs";

import {
  listArgv,
  networkInspectArgv,
} from "@chuggy/worker-core/engineArgv.mjs";
import {
  engineFailure,
  engineFailureLine,
} from "@chuggy/worker-core/engineErrors.mjs";
import { jobEngineSocket, jobGid, jobUid } from "@chuggy/worker-core/job.mjs";
import {
  poolIdentityPersonal,
  poolLabelValue,
} from "@chuggy/worker-core/poolIdentity.mjs";
import { serviceUnitText } from "./poolService.mjs";
import {
  claudeTokenFileRefusal,
  runnerConfig,
  runnerConfigLimits,
} from "./runnerConfig.mjs";
import {
  engineEndpoint,
  engineSocketHanded,
  runtimeDirectory,
} from "./runner.mjs";
import {
  commandLine,
  serviceReloadArgv,
  serviceRestartArgv,
  serviceUnitName,
  unitService,
} from "./systemdUnit.mjs";

/**
 * @typedef {import("@chuggy/worker-core/poolCredentials.mjs").PoolCredentials} PoolCredentials
 * @typedef {import("@chuggy/worker-core/poolLoop.mjs").WorkerPoolClient} WorkerPoolClient
 * @typedef {import("@chuggy/worker-core/engine.mjs").Engine} Engine
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
 * @property {string} node the Node binary running this
 * @property {string} cli this CLI's entry, as an absolute path
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
    findings.push({ check, passed: false, detail: failureMessage(failure) });
    return undefined;
  }
}

/** @param {unknown} failure */
function failureMessage(failure) {
  return failure instanceof Error ? failure.message : String(failure);
}

/**
 * Why a job could not reach this machine's engine socket, or nothing.
 * Reaching a socket takes leave to write it, which the kernel reads from the
 * owner's bits for its owner, the group's for a member and the rest's for
 * anyone else; an ACL is not read. A docker job is `jobUid` in `jobGid` and
 * the socket's group, unless that is root's, which no job is added to; a
 * podman job is the runner, onto whom keep-id maps it.
 *
 * @param {RunnerConfig["engine"]} engine
 * @param {{uid: number, gid: number, mode: number}} socket the socket's stat
 * @param {number} runnerUid
 * @returns {string | undefined}
 */
export function engineSocketUnreached(engine, socket, runnerUid) {
  const docker = engine === "docker";
  const uid = docker ? jobUid : runnerUid;
  const groups = docker
    ? [...new Set([jobGid, ...(socket.gid === 0 ? [] : [socket.gid])])]
    : [];
  const writable =
    socket.uid === uid ? 0o200 : groups.includes(socket.gid) ? 0o020 : 0o002;
  if ((socket.mode & writable) !== 0) return undefined;
  const job = docker
    ? `uid ${String(uid)} in group ${groups.map(String).join(" and ")}`
    : `uid ${String(uid)}, this runner's`;
  const root =
    docker && socket.gid === 0 ? ", and no job is added to root's group" : "";
  return `it is uid ${String(socket.uid)}'s, group ${String(socket.gid)}'s and mode ${(socket.mode & 0o777).toString(8).padStart(3, "0")}, so a job, ${job}, cannot reach it${root}`;
}

/**
 * Whether each job is handed this machine's engine socket and, where it is,
 * that the job can reach it.
 *
 * @param {Engine} engine
 * @param {RunnerConfig} config
 * @param {string | undefined} endpoint
 * @param {number} uid this process's
 * @returns {Promise<[true, string]>}
 */
async function engineSocketProbe(engine, config, endpoint, uid) {
  const socket = await engineSocketHanded(config, engine, endpoint);
  if (socket === undefined) return [true, "off"];
  const named = `${config.engine}'s socket ${socket.path}`;
  const unreached = engineSocketUnreached(
    config.engine,
    await stat(socket.path),
    uid,
  );
  if (unreached !== undefined) throw new Error(`${named}: ${unreached}`);
  const group =
    config.engine === "docker" && socket.gid !== 0
      ? `, added to group ${String(socket.gid)}`
      : "";
  return [true, `on: each job reaches ${named} at ${jobEngineSocket}${group}`];
}

/**
 * @param {Engine} engine
 * @param {PoolCredentials} credentials
 * @param {RunnerConfig} config
 * @param {number} uid this process's
 * @param {DoctorFinding[]} findings
 */
async function engineChecks(engine, credentials, config, uid, findings) {
  const reachable = await checked(findings, "container engine", async () => {
    const endpoint = await engineEndpoint(config.engine, engine);
    const listed = await engine.exec(listArgv(poolLabelValue(credentials)));
    if (listed.code !== 0) throw new Error(engineFailureLine(listed));
    const count = listed.stdout.split("\n").filter((id) => id.trim()).length;
    return [
      { endpoint },
      `${config.engine}${endpoint === undefined ? "" : ` at ${endpoint}`} lists ${String(count)} of this pool's containers`,
    ];
  });
  if (reachable === undefined) return;
  await checked(findings, "engine socket", () =>
    engineSocketProbe(engine, config, reachable.endpoint, uid),
  );
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
    const polled = await input.parts.plane(credentials).poll(token, [], 0, 0);
    if (polled.polled === "Stale")
      throw new Error("the plane rejected a token the issuer had just issued");
    if (polled.polled !== "Reconciled") throw new Error(polled.evidence);
    return [true, `${credentials.planeUrl} answered a poll`];
  });
}

/** The helper that is the auth file itself, podman's default. */
const authFileHelper = "containers-auth.json";

/**
 * The text with each `#` comment removed, a `#` inside a quoted string kept.
 *
 * @param {string} text
 */
function commentsStripped(text) {
  return text.replace(/"(?:[^"\\\n]|\\.)*"|'[^'\n]*'|#[^\n]*/gu, (match) =>
    match.startsWith("#") ? "" : match,
  );
}

/**
 * The credential helpers a registries.conf names beyond the auth file, from
 * each `credential-helpers` array it sets, its key bare or quoted.
 *
 * @param {string} text
 */
function credentialHelpersNamed(text) {
  /** @type {string[]} */
  const named = [];
  for (const [, list] of commentsStripped(text).matchAll(
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

/**
 * Whether the pool file's own unit runs this copy under this Node. One that
 * runs another is warned of with what makes it run this one, and so is one
 * serving another file, or whose `ExecStart` this runner cannot read back;
 * none yet passes.
 *
 * @param {DoctorInput} input
 * @returns {Promise<DoctorFinding>}
 */
async function serviceUnitFinding(input) {
  const check = "service unit";
  /** @param {string} detail */
  const warned = (detail) => ({ check, passed: true, warning: true, detail });
  let name;
  try {
    name = serviceUnitName(input.poolFile);
  } catch (failure) {
    return warned(failureMessage(failure));
  }
  const unit = join(input.paths.units, name);
  let text;
  try {
    text = await serviceUnitText(unit);
  } catch (failure) {
    return warned(`${unit} cannot be read: ${failureMessage(failure)}`);
  }
  if (text === undefined)
    return { check, passed: true, detail: `none yet at ${unit}` };
  const service = unitService(text);
  if (service === undefined)
    return warned(
      `${unit} runs a command this runner cannot read back, so which copy it runs is unknown`,
    );
  if (service.poolFile !== input.poolFile)
    return warned(`${unit} serves ${service.poolFile}, not this pool file`);
  if (service.node === input.node && service.cli === input.cli)
    return {
      check,
      passed: true,
      detail: `${unit} runs this copy under this Node`,
    };
  const left = [
    [input.node, input.cli, "install-service", "--pool", input.poolFile],
    serviceReloadArgv,
    serviceRestartArgv(name),
  ].map(commandLine);
  return warned(
    `${unit} runs ${service.cli} under ${service.node}, not this copy under this Node; to have it run this one: ${left.join(" && ")}`,
  );
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
    return [
      read,
      `${input.poolFile} names ${poolIdentityPersonal(read) ? "personal runner" : "pool"} ${poolLabelValue(read)}`,
    ];
  });
  const config = await checked(findings, "runner configuration", async () => {
    const read = await runnerConfig(input.paths.config);
    return [read, `${input.paths.config}: ${runnerConfigLimits(read)}`];
  });
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
  findings.push(await serviceUnitFinding(input));
  if (credentials === undefined) return findings;
  if (config !== undefined)
    await engineChecks(
      input.parts.engine(config),
      credentials,
      config,
      input.uid,
      findings,
    );
  await planeChecks(input, credentials, findings);
  return findings;
}

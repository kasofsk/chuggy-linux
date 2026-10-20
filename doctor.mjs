/**
 * What `doctor` checks, in the order a run depends on them, each answered as
 * passed or not with what was found, and before the engine whether the pool
 * file's unit runs this copy. It changes nothing: a missing network is
 * reported for a run to make, and its one poll names nothing held and wants
 * nothing, which the plane answers without granting or releasing a lease.
 */

import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, readdir, readFile, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

import {
  claudeCredentialDescribed,
  claudeCredentialFile,
  claudeCredentialRefusal,
  claudeCredentialSetting,
} from "@chuggy/worker-core/claudeCredential.mjs";

import {
  hostEnvironmentRefusal,
  hostTimeoutSecsMax,
} from "@chuggy/worker-core/hostBackend.mjs";
import { poolCredentials } from "@chuggy/worker-core/poolCredentials.mjs";

import {
  listArgv,
  networkInspectArgv,
  ownerVolumeDirectory,
  volumeInspectArgv,
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
  claudeCredentialFileRefusal,
  runnerClaudeCredential,
  runnerConfig,
  runnerConfigLimits,
} from "./runnerConfig.mjs";
import {
  engineEndpoint,
  engineSocketHanded,
  runnerReleasePrefix,
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
 * @typedef {import("@chuggy/worker-core/poolLoop.mjs").WorkerPoolUpdates} WorkerPoolUpdates
 * @typedef {import("@chuggy/worker-core/runnerUpdate.mjs").RunnerIdentity} RunnerIdentity
 * @typedef {import("@chuggy/worker-core/engine.mjs").Engine} Engine
 * @typedef {import("./runnerConfig.mjs").RunnerConfig} RunnerConfig
 * @typedef {import("./runnerConfig.mjs").RunnerPaths} RunnerPaths
 *
 * @typedef {{check: string, passed: boolean, detail: string, warning?: true}} DoctorFinding a warning passes, and is printed as one
 *
 * @typedef {object} DoctorParts what a run would reach, built from what was read
 * @property {(config: RunnerConfig) => Engine} engine
 * @property {(config: RunnerConfig) => WorkerPoolUpdates} updates the update a run would make of its runner
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
 * @property {string | undefined} path this process's PATH
 * @property {() => Promise<string | undefined>} servicePath the PATH the service manager starts the runner with, where it can be read
 * @property {(file: string) => Promise<string | undefined>} claudeVersion what a `claude` says its version is
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

/**
 * What a pool registered with `--host` runs on this machine, or a throw naming
 * what in the runner's file no host job can run under.
 *
 * @param {RunnerConfig} config
 */
function hostJobsChecked(config) {
  const refusal = hostEnvironmentRefusal(config.environment);
  if (refusal !== undefined) throw new Error(refusal);
  if (config.timeoutSecsMax > hostTimeoutSecsMax)
    throw new Error(
      `timeoutSecsMax is at most ${String(hostTimeoutSecsMax)} for a job on this machine itself`,
    );
  return "a job that pins no image and names this machine's platform runs on the machine itself, unisolated";
}

/** The cap on asking a `claude` its version, which guards a hung one and not a slow one. */
const claudeVersionTimeoutMs = 30_000;

/**
 * What a `claude` says its version is, the first line it prints, or nothing
 * where it prints none. It is run with `execFile`, never a shell.
 *
 * @param {string} file
 * @returns {Promise<string | undefined>}
 */
export function claudeVersionAsked(file) {
  return new Promise((resolve) => {
    execFile(
      file,
      ["--version"],
      { timeout: claudeVersionTimeoutMs, encoding: "utf8" },
      (error, stdout) => {
        const line = stdout.split("\n")[0].trim();
        resolve(error === null && line !== "" ? line : undefined);
      },
    );
  });
}

/**
 * The PATH a job on this machine itself is started with, and whose it is: the
 * runner's file's, or the one the service manager starts the runner with, or
 * where that cannot be read this process's own.
 *
 * @param {DoctorInput} input
 * @param {RunnerConfig} config
 * @returns {Promise<[string, string]>}
 */
async function hostJobPath(input, config) {
  if (config.environment.PATH !== undefined)
    return [config.environment.PATH, "the PATH the runner's file sets"];
  const service = await input.servicePath();
  if (service !== undefined)
    return [service, "the PATH the service manager starts the runner with"];
  return [input.path ?? "", "doctor's own PATH"];
}

/**
 * The `claude` a job on this machine itself runs, as the PATH it is started
 * with finds it, or why there is none: a warning, which passes, since a job
 * that runs no Claude Code needs none.
 *
 * @param {DoctorInput} input
 * @param {RunnerConfig} config
 * @returns {Promise<{found: string} | {missing: string}>}
 */
async function hostClaudeFound(input, config) {
  const [path, whose] = await hostJobPath(input, config);
  for (const directory of path.split(":")) {
    if (!isAbsolute(directory)) continue;
    const file = join(directory, "claude");
    try {
      await access(file, constants.X_OK);
      if (!(await stat(file)).isFile()) continue;
    } catch {
      continue;
    }
    const version = await input.claudeVersion(file);
    return {
      found: `a job on this machine itself runs ${file}, ${version ?? "which says no version"}, found on ${whose}`,
    };
  }
  return {
    missing: `no claude is on ${whose}, ${path === "" ? "which is empty" : path}, so a job on this machine itself runs no Claude Code`,
  };
}

/**
 * The Claude credential the runner's file names, its file held to the rule a
 * run holds it to and then read, as only doctor reads it, and held to what a
 * file of its kind says. It names the kind and its settings and never what
 * the file holds, and on a pool registered with `--host` the `claude` a job
 * on this machine itself runs.
 *
 * @param {DoctorInput} input
 * @param {RunnerConfig} config
 * @param {boolean} host whether a job may run on this machine itself
 * @returns {Promise<DoctorFinding>}
 */
async function claudeCredentialFinding(input, config, host) {
  const check = "Claude credential";
  const credential = runnerClaudeCredential(config);
  const file = claudeCredentialFile(credential);
  const setting = claudeCredentialSetting(credential);
  const { label } = claudeCredentialDescribed(setting);
  let refusal = await claudeCredentialFileRefusal(
    setting,
    file,
    config.engine,
    input.uid,
  );
  if (refusal === undefined)
    try {
      const text = (await readFile(file, "utf8")).trim();
      refusal = claudeCredentialRefusal(setting, text, file);
    } catch {
      refusal = `the ${label} ${file} cannot be read`;
    }
  if (refusal !== undefined) return { check, passed: false, detail: refusal };
  const named = [
    setting.kind,
    ...Object.entries(setting).flatMap(([key, value]) =>
      key === "kind" ? [] : [`${key} ${String(value)}`],
    ),
  ].join(", ");
  const detail = `${named}, from the ${label} ${file}, this runner's own`;
  if (!host) return { check, passed: true, detail };
  const claude = await hostClaudeFound(input, config);
  return "found" in claude
    ? { check, passed: true, detail: `${detail}; ${claude.found}` }
    : {
        check,
        passed: true,
        warning: true,
        detail: `${detail}; ${claude.missing}`,
      };
}

/** @param {unknown} failure */
function failureMessage(failure) {
  return failure instanceof Error ? failure.message : String(failure);
}

/**
 * What may let a job write an engine's socket that its stat does not show,
 * and what makes the socket one a job can write.
 */
const engineSocketWrites = {
  docker: {
    unseen: "an ACL",
    remedy:
      "give the socket a group of its own, such as docker's, and mode 660",
  },
  podman: {
    unseen: "its group or an ACL",
    remedy:
      "run podman's socket as this runner, as systemctl --user enable --now podman.socket does",
  },
};

/**
 * Whether a job can reach this machine's engine socket, as far as its stat
 * decides. Reaching a socket takes leave to write it, which the kernel reads
 * from the owner's bits for its owner, the group's for a member and the
 * rest's for anyone else. A docker job is `jobUid` in `jobGid` and the
 * socket's group, unless that is root's, which no job is added to; a podman
 * job is the runner, onto whom keep-id maps it, in groups not known here.
 * Where an ACL is set the group's bits are its mask, and an entry the stat
 * does not show may let in a job that is neither owner nor member, so the
 * stat does not decide where the rest's bits refuse that job and the
 * group's allow writing.
 *
 * @param {RunnerConfig["engine"]} engine
 * @param {{uid: number, gid: number, mode: number}} socket the socket's stat
 * @param {number} runnerUid
 * @returns {{reach: "Reached"} | {reach: "Unreached" | "Undecided", why: string}}
 */
export function engineSocketReach(engine, socket, runnerUid) {
  const docker = engine === "docker";
  const uid = docker ? jobUid : runnerUid;
  const groups = docker
    ? [...new Set([jobGid, ...(socket.gid === 0 ? [] : [socket.gid])])]
    : [];
  const owner = socket.uid === uid;
  const member = !owner && groups.includes(socket.gid);
  const bit = owner ? 0o200 : member ? 0o020 : 0o002;
  if ((socket.mode & bit) !== 0) return { reach: "Reached" };
  const held = `it is uid ${String(socket.uid)}'s, group ${String(socket.gid)}'s and mode ${(socket.mode & 0o777).toString(8).padStart(3, "0")}`;
  const job = docker
    ? `uid ${String(uid)} in group ${groups.map(String).join(" and ")}`
    : `uid ${String(uid)}, this runner's`;
  const root = docker && socket.gid === 0 ? " and never in root's" : "";
  const { unseen, remedy } = engineSocketWrites[engine];
  if (owner || (socket.mode & 0o020) === 0)
    return {
      reach: "Unreached",
      why: `${held}, so a job, ${job}${root}, cannot reach it; ${remedy}`,
    };
  return {
    reach: "Undecided",
    why: `${held}, so a job, ${job}${root}, reaches it only if ${unseen} lets it, which doctor cannot see; to be sure, ${remedy}`,
  };
}

/**
 * Whether each job is handed this machine's engine socket and, where it is,
 * whether the job can reach it, warned of where the socket's stat does not
 * decide.
 *
 * @param {Engine} engine
 * @param {RunnerConfig} config
 * @param {string | undefined} endpoint
 * @param {number} uid this process's
 * @returns {Promise<DoctorFinding>}
 */
async function engineSocketFinding(engine, config, endpoint, uid) {
  const check = "engine socket";
  try {
    const socket = await engineSocketHanded(config, engine, endpoint);
    if (socket === undefined) return { check, passed: true, detail: "off" };
    const group =
      config.engine === "docker" && socket.gid !== 0
        ? `, added to group ${String(socket.gid)}`
        : "";
    const named = `${config.engine}'s socket ${socket.path}`;
    const handed = `${named} at ${jobEngineSocket}${group}`;
    const reach = engineSocketReach(
      config.engine,
      await stat(socket.path),
      uid,
    );
    if (reach.reach === "Reached")
      return { check, passed: true, detail: `on: each job reaches ${handed}` };
    if (reach.reach === "Undecided")
      return {
        check,
        passed: true,
        warning: true,
        detail: `on: each job is handed ${handed}, but ${reach.why}`,
      };
    return { check, passed: false, detail: `${named}: ${reach.why}` };
  } catch (failure) {
    return { check, passed: false, detail: failureMessage(failure) };
  }
}

/**
 * Whether a job may write in an owner's directory by its mode, which takes
 * the write and search bits its uid and groups are read by, as
 * `engineSocketReach` reads a socket's: under docker `jobUid` in `jobGid`,
 * under podman the runner, in groups not known here.
 *
 * @param {RunnerConfig["engine"]} engine
 * @param {{uid: number, gid: number, mode: number}} directory the directory's stat
 * @param {number} runnerUid
 */
export function volumeDirectoryWritable(engine, directory, runnerUid) {
  const docker = engine === "docker";
  const owner = directory.uid === (docker ? jobUid : runnerUid);
  const member = !owner && docker && directory.gid === jobGid;
  const bits = owner ? 0o300 : member ? 0o030 : 0o003;
  return (directory.mode & bits) === bits;
}

/**
 * What a job is given of one of its owner's volumes, or a throw naming why it
 * cannot be given it: a directory that is there, and whether a job may write
 * it, or a named volume, there or for the first job to make.
 *
 * @param {Engine} engine
 * @param {RunnerConfig} config
 * @param {RunnerConfig["volumes"][number]} volume
 * @param {number} uid this process's
 */
async function ownerVolumeFound(engine, config, volume, uid) {
  const { source, target, readonly } = volume;
  const mounted = `${source} at ${target}${readonly ? ", read-only" : ""}`;
  if (ownerVolumeDirectory(source)) {
    const directory = await stat(source);
    if (!directory.isDirectory())
      throw new Error(`${source} is not a directory`);
    if (readonly) return mounted;
    if (volumeDirectoryWritable(config.engine, directory, uid))
      return `${mounted}, which a job may write`;
    const job =
      config.engine === "docker"
        ? `uid ${String(jobUid)} in group ${String(jobGid)}`
        : `uid ${String(uid)}, this runner's`;
    return `${mounted}, which a job, ${job}, may not write: it is uid ${String(directory.uid)}'s, group ${String(directory.gid)}'s and mode ${(directory.mode & 0o777).toString(8).padStart(3, "0")}`;
  }
  const inspected = await engine.exec(volumeInspectArgv([source]));
  if (inspected.code === 0) return `${mounted}, present`;
  if (engineFailure(inspected) === "NoSuchVolume")
    return `${mounted}, missing until the first job started through chuggy's runtime makes it`;
  throw new Error(`${source}: ${engineFailureLine(inspected)}`);
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
  findings.push(
    await engineSocketFinding(engine, config, reachable.endpoint, uid),
  );
  await checked(findings, "job network", async () => {
    const inspected = await engine.exec(networkInspectArgv(config.network));
    if (inspected.code === 0) return [true, `${config.network} is present`];
    if (engineFailure(inspected) === "NotFound")
      return [true, `${config.network} is missing, and a run makes it`];
    throw new Error(engineFailureLine(inspected));
  });
  await checked(findings, "volumes", async () => {
    /** @type {string[]} */
    const found = [];
    for (const volume of config.volumes)
      found.push(await ownerVolumeFound(engine, config, volume, uid));
    return [true, found.length === 0 ? "none" : found.join("; ")];
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
 * The credential helpers a registries.conf names ahead of the auth file, from
 * each `credential-helpers` array it sets, its key bare or quoted: all of an
 * array that names no auth file.
 *
 * @param {string} text
 */
function helpersAheadOfAuthFile(text) {
  /** @type {string[]} */
  const ahead = [];
  for (const [, list] of commentsStripped(text).matchAll(
    /^\s*(?:credential-helpers|"credential-helpers"|'credential-helpers')\s*=\s*\[([^\]]*)\]/gmu,
  )) {
    const named = [...list.matchAll(/"([^"]*)"|'([^']*)'/gu)].map(
      ([, basic, literal]) => basic ?? literal,
    );
    const authFile = named.indexOf(authFileHelper);
    ahead.push(...(authFile < 0 ? named : named.slice(0, authFile)));
  }
  return ahead;
}

/**
 * The registries.conf files at these locations, each a file or a drop-in
 * directory of `.conf` files, and which of them name a credential helper
 * ahead of the auth file. One that cannot be read is not counted.
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
    if (helpersAheadOfAuthFile(text).length > 0) helpered.push(file);
  }
  return { read, helpered };
}

/**
 * Podman asks the credential helpers registries.conf names in the order it
 * names them, and reads `--authfile` only as the auth file's turn comes, so
 * a helper ahead of it, or a list without it, answers a pull of the pool's
 * registry in place of the pool's token. That is the operator's to
 * configure, and warned of.
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
      detail: `none named ahead of the auth file in the ${String(read)} registries.conf ${read === 1 ? "file" : "files"} read`,
    };
  return {
    check,
    passed: true,
    warning: true,
    detail: `${helpered.join(", ")} ${helpered.length === 1 ? "names" : "name"} a credential helper ahead of ${authFileHelper}, which podman asks in place of the pool's token on a pull of the pool's registry; name ${authFileHelper} first`,
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

/**
 * A release one patch above this copy, from its own release downloads, as
 * chuggy would name the next: the core's refusal of it is only of what keeps
 * this install from taking a release.
 *
 * @param {RunnerIdentity} runner
 */
function nextRelease(runner) {
  const [major, minor, patch] = runner.version.split(".").map(Number);
  const version = `${String(major)}.${String(minor)}.${String(patch + 1)}`;
  return {
    package: runner.package,
    version,
    url: `${runnerReleasePrefix}v${version}/${runner.package}-${version}.tgz`,
    integrity: `sha512-${"A".repeat(86)}==`,
  };
}

/**
 * Whether the runner updates itself and, where it does, whether this install
 * can take a release: one that npm did not install globally, or that this
 * user cannot write, cannot, and is warned of.
 *
 * @param {WorkerPoolUpdates} updates
 * @returns {Promise<DoctorFinding>}
 */
async function updatesFinding(updates) {
  const check = "updates";
  if (!updates.on)
    return {
      check,
      passed: true,
      detail: "off: the runner's file sets autoUpdate to false",
    };
  const refusal = await updates.updater.refusal(
    nextRelease(updates.updater.runner),
  );
  if (refusal === undefined)
    return {
      check,
      passed: true,
      detail: "on: the release chuggy names is installed between jobs",
    };
  return {
    check,
    passed: true,
    warning: true,
    detail: `on, but this install cannot take a release: ${refusal}; install it with npm under a prefix you own, such as nvm's`,
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
    return [
      read,
      `${input.poolFile} names ${poolIdentityPersonal(read) ? "personal runner" : "pool"} ${poolLabelValue(read)}`,
    ];
  });
  const config = await checked(findings, "runner configuration", async () => {
    const read = await runnerConfig(input.paths.config);
    return [read, `${input.paths.config}: ${runnerConfigLimits(read)}`];
  });
  const runtime = await checked(findings, "runtime directory", async () => [
    true,
    runtimeDirectory(input.paths),
  ]);
  if (config !== undefined)
    findings.push(
      await claudeCredentialFinding(input, config, credentials?.host === true),
    );
  if (credentials?.host === true && config !== undefined)
    await checked(findings, "host jobs", async () => [
      true,
      hostJobsChecked(config),
    ]);
  if (config?.engine === "podman")
    findings.push(await podmanHelpersFinding(input.registriesConf));
  findings.push(await serviceUnitFinding(input));
  if (config !== undefined && runtime !== undefined)
    findings.push(await updatesFinding(input.parts.updates(config)));
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

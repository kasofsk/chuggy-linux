/**
 * Every call the runner makes to its container engine, as the argv it hands
 * the engine's CLI. Docker and podman are told the same things in the same
 * words but two: podman names a pull's credential by flag where docker reads
 * it from a directory, and podman maps the image's user onto the invoking one.
 * Nothing here runs anything.
 */

import { join } from "node:path";

import { mintedCredentialDirectory } from "@chuggy/worker-contract/workerEnvironment";

import {
  jobGid,
  jobPidsMax,
  jobProviderCredentialFile,
  jobUid,
  jobWorkspace,
} from "./job.mjs";

/**
 * @typedef {"docker" | "podman"} EngineName
 *
 * @typedef {object} JobContainer
 * @property {string} name
 * @property {string} pool the pool label's value
 * @property {string} assignment
 * @property {number} deadlineEpochSecs
 * @property {string} envFile
 * @property {number} cpuMillis
 * @property {number} memoryMib
 * @property {string} tokenFile
 * @property {string} network
 * @property {string} image
 */

/** The labels a job's container carries, which is how `held` finds it again. */
export const poolLabel = "io.chuggy.pool";
export const assignmentLabel = "io.chuggy.assignment";
export const deadlineLabel = "io.chuggy.deadline";

/** The file a pull's credential is written to, in the directory made for it. */
export const registryAuthFile = "config.json";

/** @param {string} image */
export function imageInspectArgv(image) {
  return ["image", "inspect", "--format", "{{.Id}}", image];
}

/**
 * A pull, and the variables its engine is run with: docker reads its
 * credential from `DOCKER_CONFIG`, podman from `--authfile`.
 *
 * @param {EngineName} engine
 * @param {string} image
 * @param {string} authDirectory
 * @returns {{argv: string[], environment: Record<string, string>}}
 */
export function pullArgv(engine, image, authDirectory) {
  return engine === "docker"
    ? {
        argv: ["pull", "--quiet", image],
        environment: { DOCKER_CONFIG: authDirectory },
      }
    : {
        argv: [
          "pull",
          "--quiet",
          "--authfile",
          join(authDirectory, registryAuthFile),
          image,
        ],
        environment: {},
      };
}

/**
 * One job's container. The mounts and the security options are the rig's
 * pod in container terms: the image's user, no capabilities, no privilege
 * escalation, the engine's default seccomp profile, the minted credential in
 * memory the image's user owns, and the workspace in a volume of its own.
 *
 * @param {EngineName} engine
 * @param {JobContainer} job
 */
export function runArgv(engine, job) {
  return [
    "run",
    "-d",
    "--pull=never",
    "--name",
    job.name,
    "--label",
    `${poolLabel}=${job.pool}`,
    "--label",
    `${assignmentLabel}=${job.assignment}`,
    "--label",
    `${deadlineLabel}=${String(job.deadlineEpochSecs)}`,
    "--env-file",
    job.envFile,
    "--user",
    `${String(jobUid)}:${String(jobGid)}`,
    ...(engine === "podman"
      ? [`--userns=keep-id:uid=${String(jobUid)},gid=${String(jobGid)}`]
      : []),
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--pids-limit",
    String(jobPidsMax),
    "--cpus",
    String(job.cpuMillis / 1000),
    "--memory",
    `${String(job.memoryMib)}m`,
    "--mount",
    `type=bind,source=${job.tokenFile},target=${jobProviderCredentialFile},readonly`,
    "--tmpfs",
    `${mintedCredentialDirectory}:rw,nosuid,nodev,noexec,size=1m,uid=${String(jobUid)},gid=${String(jobGid)},mode=0700`,
    "--volume",
    jobWorkspace,
    "--network",
    job.network,
    job.image,
  ];
}

/** @param {string} pool the pool label's value */
export function listArgv(pool) {
  return [
    "ps",
    "--all",
    "--quiet",
    "--no-trunc",
    "--filter",
    `label=${poolLabel}=${pool}`,
  ];
}

/** @param {readonly string[]} containers */
export function inspectArgv(containers) {
  return ["container", "inspect", ...containers];
}

/** @param {string} container */
export function killArgv(container) {
  return ["kill", container];
}

/** @param {string} container */
export function logsArgv(container) {
  return ["logs", container];
}

/**
 * A removal, with the container's anonymous volumes: the workspace goes with
 * the job. Forced, it kills a running container first.
 *
 * @param {string} container
 * @param {{force: boolean}} how
 */
export function removeArgv(container, how) {
  return how.force ? ["rm", "-f", "-v", container] : ["rm", "-v", container];
}

/** @param {string} network */
export function networkInspectArgv(network) {
  return ["network", "inspect", network];
}

/** @param {string} network */
export function networkCreateArgv(network) {
  return ["network", "create", network];
}

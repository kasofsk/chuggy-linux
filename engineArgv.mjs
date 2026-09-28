/**
 * Every call the runner makes to its container engine, as the argv it hands
 * the engine's CLI. Nothing here runs anything.
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
 * credential from `DOCKER_CONFIG`, podman from `--authfile`. A fresh
 * `DOCKER_CONFIG` holds no CLI context either, so docker is also told the
 * endpoint its context resolved to, or the pull would reach another daemon
 * than every other call. `DOCKER_AUTH_CONFIG`, a login docker takes from the
 * environment over any file's, is emptied, which docker reads as unset.
 *
 * @param {EngineName} engine
 * @param {string} image
 * @param {string} authDirectory
 * @param {string | undefined} dockerHost the endpoint `dockerContextArgv` answered; docker's alone
 * @returns {{argv: string[], environment: Record<string, string>}}
 */
export function pullArgv(engine, image, authDirectory, dockerHost) {
  if (engine === "docker") {
    if (dockerHost === undefined)
      throw new RangeError(
        "a docker pull needs the endpoint its context names",
      );
    return {
      argv: ["pull", "--quiet", image],
      environment: {
        DOCKER_CONFIG: authDirectory,
        DOCKER_HOST: dockerHost,
        DOCKER_AUTH_CONFIG: "",
      },
    };
  }
  return {
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

/** Podman's own version, which decides whether `--authfile` is all it reads. */
export function podmanVersionArgv() {
  return ["version", "--format", "{{.Client.Version}}"];
}

/** Docker's security options, which name a daemon running rootless. */
export function dockerInfoArgv() {
  return ["info", "--format", "{{json .SecurityOptions}}"];
}

/** The endpoint docker's CLI reaches, by `DOCKER_HOST` or its current context. */
export function dockerContextArgv() {
  return ["context", "inspect", "--format", "{{.Endpoints.docker.Host}}"];
}

/**
 * The minted directory's tmpfs, owned by the job's user. Docker takes the
 * owner as `uid`/`gid` and rejects `U`; rootless podman rejects `uid`/`gid`
 * and takes `U`, which chowns the mount to the container's user.
 *
 * @param {EngineName} engine
 */
export function mintedTmpfs(engine) {
  const owner =
    engine === "docker"
      ? `uid=${String(jobUid)},gid=${String(jobGid)},mode=0700`
      : "mode=0700,U";
  return `${mintedCredentialDirectory}:rw,nosuid,nodev,noexec,size=1m,${owner}`;
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
    mintedTmpfs(engine),
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

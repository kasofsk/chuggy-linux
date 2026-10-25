/**
 * The bytes free where this machine's engine stores what it holds, which the
 * runner measures itself, since an engine in a VM would answer for the VM's
 * disk: the lowest of the filesystems holding docker's root directory, and
 * containerd's where docker stores images through its snapshotter, or
 * podman's graph root and volume path. An engine naming another machine than
 * this one runs elsewhere, and its free disk is unknown.
 */

import { statfs } from "node:fs/promises";
import { hostname } from "node:os";

import { z } from "zod";

import { diskGib } from "@chuggy/worker-core/diskFloor.mjs";
import { engineInfoArgv } from "@chuggy/worker-core/engineArgv.mjs";
import { engineFailureLine } from "@chuggy/worker-core/engineErrors.mjs";

/**
 * @typedef {import("@chuggy/worker-core/diskFloor.mjs").DiskFree} DiskFree
 * @typedef {import("@chuggy/worker-core/engine.mjs").Engine} Engine
 * @typedef {import("./runnerConfig.mjs").RunnerConfig} RunnerConfig
 *
 * @typedef {object} DiskFreePorts what the free disk is measured by
 * @property {() => string} hostname this machine's, asked each measurement
 * @property {(path: string) => Promise<{bavail: number, bsize: number}>} statfs
 */

/** @type {DiskFreePorts} */
export const diskFreePorts = { hostname, statfs };

/** Where containerd keeps what it holds unless its own configuration moves it. */
const containerdRoot = "/var/lib/containerd";

/** What docker's `info` names the storage of images it keeps through containerd. */
const containerdSnapshotter = "io.containerd.snapshotter.v1";

const dockerInfoSchema = z.object({
  DockerRootDir: z.string(),
  Name: z.string(),
  DriverStatus: z.array(z.array(z.string())).nullish(),
});

const podmanInfoSchema = z.object({
  host: z.object({ hostname: z.string() }),
  store: z.object({ graphRoot: z.string(), volumePath: z.string() }),
});

/**
 * The machine an engine's `info` names and the directories it says it keeps
 * what it holds in, or nothing for an answer of another shape.
 *
 * @param {RunnerConfig["engine"]} name
 * @param {string} stdout
 * @returns {{machine: string, paths: string[]} | undefined}
 */
function engineStores(name, stdout) {
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  if (name === "docker") {
    const docker = dockerInfoSchema.safeParse(parsed);
    if (!docker.success) return undefined;
    const { DockerRootDir, Name, DriverStatus } = docker.data;
    const snapshotter = (DriverStatus ?? []).some(
      ([key, value]) =>
        key === "driver-type" && value === containerdSnapshotter,
    );
    return {
      machine: Name,
      paths: [DockerRootDir, ...(snapshotter ? [containerdRoot] : [])],
    };
  }
  const podman = podmanInfoSchema.safeParse(parsed);
  if (!podman.success) return undefined;
  const { host, store } = podman.data;
  return { machine: host.hostname, paths: [store.graphRoot, store.volumePath] };
}

/** @param {unknown} failure */
function failureMessage(failure) {
  return failure instanceof Error ? failure.message : String(failure);
}

/**
 * @param {RunnerConfig["engine"]} name
 * @param {Engine} engine
 * @param {DiskFreePorts} ports
 * @returns {Promise<DiskFree>}
 */
export async function engineDiskFree(name, engine, ports) {
  const info = await engine.exec(engineInfoArgv());
  if (info.code !== 0)
    return {
      unknown: `${name} could not be asked where it stores what it holds: ${engineFailureLine(info)}`,
    };
  const stores = engineStores(name, info.stdout);
  if (stores === undefined)
    return { unknown: `${name} answered an info this runner cannot read` };
  const machine = ports.hostname();
  if (stores.machine !== machine)
    return {
      unknown: `${name} names its machine ${stores.machine}, not ${machine}, so it stores what it holds on another machine's disk, such as a VM's`,
    };
  /** @type {{free: number, where: string} | undefined} */
  let lowest;
  for (const where of new Set(stores.paths)) {
    let found;
    try {
      found = await ports.statfs(where);
    } catch (failure) {
      return {
        unknown: `${where} could not be measured: ${failureMessage(failure)}`,
      };
    }
    const free = found.bavail * found.bsize;
    if (lowest === undefined || free < lowest.free) lowest = { free, where };
  }
  return lowest ?? { unknown: `${name} names nowhere it stores what it holds` };
}

/**
 * The floor the runner's file sets, in bytes.
 *
 * @param {RunnerConfig} config
 */
export function diskFloorBytes(config) {
  return config.diskFreeGibMin * 2 ** 30;
}

/**
 * The engine's free disk against the runner's floor, as doctor and `status`
 * say it, and whether it is one to warn of: unmeasured, or under the floor.
 *
 * @param {RunnerConfig} config
 * @param {Engine} engine
 * @param {DiskFreePorts} ports
 * @returns {Promise<{detail: string, warning: boolean}>}
 */
export async function diskFloorSaid(config, engine, ports) {
  if (config.diskFreeGibMin === 0)
    return {
      detail: "none: the runner's file sets diskFreeGibMin to 0",
      warning: false,
    };
  const measured = await engineDiskFree(config.engine, engine, ports);
  if ("unknown" in measured)
    return {
      detail: `none held, since the free disk could not be measured: ${measured.unknown}`,
      warning: true,
    };
  const bytesMin = diskFloorBytes(config);
  const free = `${diskGib(measured.free)} GiB free at ${measured.where}`;
  const floor = `the floor of ${String(config.diskFreeGibMin)} GiB`;
  if (measured.free >= bytesMin)
    return { detail: `${free}, over ${floor}`, warning: false };
  if (measured.free >= Math.floor(bytesMin / 2))
    return {
      detail: `${free}, under ${floor}: the service removes the images it may and takes no job until it is over`,
      warning: true,
    };
  return {
    detail: `${free}, under half ${floor}: the service removes the images it may, and stops a job each pass it is still under half`,
    warning: true,
  };
}

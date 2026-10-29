/**
 * What a runner report says of this machine, where the runner's file sets
 * `reportMetrics`: its CPUs and load as Node reads them of Linux, its memory
 * as `/proc/meminfo` counts it, and, where the service holds a disk floor,
 * that floor and the space free under it, measured as the floor measures it.
 * Available memory is the kernel's own MemAvailable, read here rather than
 * through `os.freemem()`, which answers MemFree where the kernel counts no
 * MemAvailable. A fact that cannot be read is left out, never estimated from
 * another.
 */

import { readFile } from "node:fs/promises";
import { availableParallelism, loadavg } from "node:os";

import { diskFloorBytes } from "./diskFree.mjs";

/**
 * @typedef {import("@chuggy/worker-core/runnerReport.mjs").RunnerMachine} RunnerMachine
 * @typedef {import("@chuggy/worker-core/diskFloor.mjs").DiskFree} DiskFree
 * @typedef {import("./runnerConfig.mjs").RunnerConfig} RunnerConfig
 *
 * @typedef {object} MachineFactPorts what this machine's CPUs, load and memory are read by
 * @property {() => Promise<string>} meminfo `/proc/meminfo`'s text
 * @property {() => number[]} loadavg as `os.loadavg` answers
 * @property {() => number} cpus as `os.availableParallelism` answers
 */

/** @type {MachineFactPorts} */
export const machineFactPorts = {
  meminfo: () => readFile("/proc/meminfo", "utf8"),
  loadavg,
  cpus: availableParallelism,
};

/** The bytes in the unit `/proc/meminfo` counts in, which it names kB. */
const meminfoUnitBytes = 1024;

/**
 * The bytes a `/proc/meminfo` line counts for `field`, or nothing where no
 * line counts it as Linux does.
 *
 * @param {string} text
 * @param {string} field
 */
function meminfoBytes(text, field) {
  const counted = new RegExp(`^${field}:\\s+(\\d+) kB$`, "mu").exec(text);
  if (counted === null) return undefined;
  const bytes = Number(counted[1]) * meminfoUnitBytes;
  return Number.isSafeInteger(bytes) ? bytes : undefined;
}

/**
 * The memory a `/proc/meminfo` text counts, each figure it does not count
 * left out.
 *
 * @param {string} text
 * @returns {Pick<RunnerMachine, "memoryTotalBytes" | "memoryAvailableBytes">}
 */
export function meminfoFacts(text) {
  const total = meminfoBytes(text, "MemTotal");
  const available = meminfoBytes(text, "MemAvailable");
  return {
    ...(total === undefined ? {} : { memoryTotalBytes: total }),
    ...(available === undefined ? {} : { memoryAvailableBytes: available }),
  };
}

/**
 * The floor the runner's file keeps and the space free under it, or nothing
 * where it keeps none, as the service then measures none, or the space
 * cannot be measured.
 *
 * @param {RunnerConfig} config
 * @param {() => Promise<DiskFree>} diskFree
 * @returns {Promise<Pick<RunnerMachine, "diskFreeBytes" | "diskFloorBytes">>}
 */
async function diskFacts(config, diskFree) {
  if (config.diskFreeGibMin === 0) return {};
  const measured = await diskFree().catch(() => undefined);
  if (measured === undefined || "unknown" in measured) return {};
  return {
    diskFreeBytes: measured.free,
    diskFloorBytes: diskFloorBytes(config),
  };
}

/**
 * This machine's facts as a report reads them, each read as the report is
 * made.
 *
 * @param {RunnerConfig} config
 * @param {() => Promise<DiskFree>} diskFree the engine's free disk, measured as the floor measures it
 * @param {MachineFactPorts} [ports]
 * @returns {() => Promise<RunnerMachine>}
 */
export function machineFacts(config, diskFree, ports = machineFactPorts) {
  return async () => ({
    cpus: ports.cpus(),
    loadAverageOneMinute: ports.loadavg()[0],
    ...meminfoFacts(await ports.meminfo().catch(() => "")),
    ...(await diskFacts(config, diskFree)),
  });
}

import assert from "node:assert/strict";
import test from "node:test";

import { machineFacts, meminfoFacts } from "./machineFacts.mjs";

/** The head of a `/proc/meminfo` as Linux writes one. */
const meminfo = [
  "MemTotal:       64620692 kB",
  "MemFree:        16862672 kB",
  "MemAvailable:   41391256 kB",
  "Buffers:         1203324 kB",
  "Cached:         22071648 kB",
]
  .map((line) => `${line}\n`)
  .join("");

/** Ports reading a machine of 8 CPUs, whose load is 0.42, with `meminfo`. */
const ports = {
  meminfo: async () => meminfo,
  loadavg: () => [0.42, 0.31, 0.2],
  cpus: () => 8,
};

/** What `ports` read, as a report names it. */
const portsRead = {
  cpus: 8,
  loadAverageOneMinute: 0.42,
  memoryTotalBytes: 64620692 * 1024,
  memoryAvailableBytes: 41391256 * 1024,
};

/** @param {number} diskFreeGibMin */
const configured = (diskFreeGibMin) =>
  /** @type {import("./runnerConfig.mjs").RunnerConfig} */ (
    /** @type {unknown} */ ({ diskFreeGibMin })
  );

test("a report's memory is /proc/meminfo's MemTotal and MemAvailable, in bytes", () => {
  assert.deepEqual(meminfoFacts(meminfo), {
    memoryTotalBytes: 64620692 * 1024,
    memoryAvailableBytes: 41391256 * 1024,
  });
});

test("a figure /proc/meminfo does not count as Linux does is left out, and available memory is never taken from MemFree", () => {
  const withoutAvailable = meminfo.replace(/^MemAvailable:.*\n/mu, "");
  assert.deepEqual(meminfoFacts(withoutAvailable), {
    memoryTotalBytes: 64620692 * 1024,
  });
  assert.deepEqual(meminfoFacts(""), {});
  assert.deepEqual(
    meminfoFacts("MemTotal:       64620692 MB\nMemAvailable: lots kB\n"),
    {},
  );
  assert.deepEqual(meminfoFacts(`MemTotal: ${"9".repeat(17)} kB\n`), {});
});

test("a report names this machine's CPUs, load and memory, and the engine's free disk with its floor where the file keeps one", async () => {
  /** @type {number[]} */
  const measured = [];
  const diskFree = async () => {
    measured.push(1);
    return { free: 30 * 2 ** 30, where: "/var/lib/docker" };
  };
  assert.deepEqual(await machineFacts(configured(20), diskFree, ports)(), {
    ...portsRead,
    diskFreeBytes: 30 * 2 ** 30,
    diskFloorBytes: 20 * 2 ** 30,
  });
  assert.deepEqual(
    await machineFacts(configured(0), diskFree, ports)(),
    portsRead,
  );
  assert.equal(measured.length, 1, "a file keeping no floor measures none");
});

test("a fact that cannot be read is left out, and every other is still named", async () => {
  const unknown = async () => ({ unknown: "podman could not be asked" });
  assert.deepEqual(
    await machineFacts(configured(20), unknown, ports)(),
    portsRead,
  );
  const thrown = async () => {
    throw new Error("statfs hung up");
  };
  assert.deepEqual(
    await machineFacts(configured(20), thrown, ports)(),
    portsRead,
  );
  const unread = {
    ...ports,
    meminfo: async () => {
      throw new Error(
        "ENOENT: no such file or directory, open '/proc/meminfo'",
      );
    },
  };
  assert.deepEqual(await machineFacts(configured(0), unknown, unread)(), {
    cpus: 8,
    loadAverageOneMinute: 0.42,
  });
});

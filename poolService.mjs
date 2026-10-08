/**
 * The service answering for a pool on this machine, found by where it
 * listens. A pool's service listens in the pool's own runtime directory. A
 * service still running a runner from before pools had their own listens in
 * the runtime directory's root until it restarts, and is this pool's when the
 * legacy unit serves a file naming this pool. One whose file cannot be read
 * may be this pool's or another's.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { poolCredentials } from "@chuggy/worker-core/poolCredentials.mjs";

import {
  controlAsked,
  controlSocketPath,
} from "@chuggy/worker-core/control.mjs";
import { poolIdentitySame } from "@chuggy/worker-core/poolIdentity.mjs";
import { poolRuntimeDirectory, runtimeDirectory } from "./runner.mjs";
import {
  legacyServiceUnitName,
  serviceUnitName,
  unitPoolFile,
} from "./systemdUnit.mjs";

/**
 * @typedef {import("@chuggy/worker-core/poolIdentity.mjs").PoolIdentity} PoolIdentity
 * @typedef {import("./runnerConfig.mjs").RunnerPaths} RunnerPaths
 *
 * @typedef {object} LegacyService
 * @property {string} unit the legacy unit's file
 * @property {string} file the pool file it serves
 * @property {"ThisPool" | "Unread"} serves this pool, or a pool file that cannot be read and so may name it
 *
 * @typedef {object} PoolServiceSockets
 * @property {string} own where the pool's service listens
 * @property {{socket: string, serves: LegacyService["serves"]} | undefined} legacy where a legacy service listens that serves this pool, or may
 */

/**
 * A unit file's text, or nothing where there is no such file.
 *
 * @param {string} unit
 */
export async function serviceUnitText(unit) {
  try {
    return await readFile(unit, "utf8");
  } catch (failure) {
    if (/** @type {NodeJS.ErrnoException} */ (failure).code === "ENOENT")
      return undefined;
    throw failure;
  }
}

/**
 * The legacy unit, where it serves this pool or a pool file that cannot be
 * read. Nothing where it serves another pool, or there is none this runner
 * wrote.
 *
 * @param {RunnerPaths} paths
 * @param {PoolIdentity} identity
 * @returns {Promise<LegacyService | undefined>}
 */
export async function legacyService(paths, identity) {
  const unit = join(paths.units, legacyServiceUnitName);
  const text = await serviceUnitText(unit);
  const file = text === undefined ? undefined : unitPoolFile(text);
  if (file === undefined) return undefined;
  const named = await poolCredentials(file).catch(() => undefined);
  if (named === undefined) return { unit, file, serves: "Unread" };
  return poolIdentitySame(named, identity)
    ? { unit, file, serves: "ThisPool" }
    : undefined;
}

/**
 * The units here that serve exactly `file`: its own and the legacy one.
 *
 * @param {RunnerPaths} paths
 * @param {string} file
 */
export async function poolFileServiceUnits(paths, file) {
  const names = [serviceUnitName(file), legacyServiceUnitName];
  const served = await Promise.all(
    names.map(
      async (name) =>
        unitPoolFile((await serviceUnitText(join(paths.units, name))) ?? "") ===
        file,
    ),
  );
  return names.filter((_, index) => served[index]);
}

/**
 * @param {RunnerPaths} paths
 * @param {PoolIdentity} identity
 * @returns {Promise<PoolServiceSockets>}
 */
export async function poolServiceSockets(paths, identity) {
  const legacy = await legacyService(paths, identity);
  return {
    own: controlSocketPath(poolRuntimeDirectory(paths, identity)),
    legacy:
      legacy === undefined
        ? undefined
        : {
            socket: controlSocketPath(runtimeDirectory(paths)),
            serves: legacy.serves,
          },
  };
}

/**
 * Asks the service answering for the pool, answering nothing when none is
 * running. A legacy service whose pool file cannot be read is not asked, since
 * it may be another pool's.
 *
 * @param {PoolServiceSockets} sockets
 * @param {import("@chuggy/worker-core/control.mjs").ControlRequest} request
 * @returns {Promise<unknown>}
 */
export async function poolServiceAsked(sockets, request) {
  const answered = await controlAsked(sockets.own, request);
  if (answered !== undefined || sockets.legacy?.serves !== "ThisPool")
    return answered;
  return controlAsked(sockets.legacy.socket, request);
}
